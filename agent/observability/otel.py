"""TOWER OTel handles — real tracer/meter + OTLP/in-memory fallback (T-06).

Every agent state change emits metric + log + trace sharing one
``trace_id`` (PRD G2 / §8). This module owns the tracer/meter handles
and exporter wiring; :mod:`agent.observability.emitter` owns the
per-event emit table (parse/collision/hold/reroute/error).

Exporter strategy (no creds or network in this repo):

* When ``GRAFANA_CLOUD_OTLP_ENDPOINT`` is set, OTLP HTTP exporters push
  to Grafana Cloud (Mimir / Loki / Tempo) with basic auth derived from
  ``GRAFANA_CLOUD_INSTANCE_ID`` / ``GRAFANA_CLOUD_API_KEY`` read from
  the environment at configure time only.
* When the endpoint is unset (tests + local dev), traces go to an
  in-memory span exporter, metrics to an in-memory metric reader, and
  logs to stdout. Nothing blocks the hold path and nothing dials out.

Label hygiene (E25): metric attribute keys are restricted to
``ALLOWED_LABEL_KEYS``. ``trace_id`` / ``request_id`` travel in log
fields + span attributes, never as metric labels.
"""

from __future__ import annotations

import base64
import logging
import os
import sys
from typing import Any

__all__ = [
    "TRACER_NAME",
    "METER_NAME",
    "SLOT_COUNTER_NAME",
    "COLLISION_COUNTER_NAME",
    "RESOLVE_HISTOGRAM_NAME",
    "PARSE_HISTOGRAM_NAME",
    "REROUTE_COUNTER_NAME",
    "ERROR_COUNTER_NAME",
    "ALLOWED_LABEL_KEYS",
    "GRAFANA_OTLP_ENV",
    "GRAFANA_INSTANCE_ENV",
    "GRAFANA_API_KEY_ENV",
    "tracer",
    "meter",
    "slot_counter",
    "collision_counter",
    "resolve_histogram",
    "parse_histogram",
    "reroute_counter",
    "error_counter",
    "is_otlp_configured",
    "get_span_exporter",
    "get_metric_reader",
    "get_metrics_data",
    "get_finished_spans",
    "reset_for_tests",
    "emit_parse",
    "emit_collision",
    "emit_hold",
    "emit_reroute",
    "emit_error",
]

TRACER_NAME: str = "tower.atc"
METER_NAME: str = "tower.atc"

SLOT_COUNTER_NAME: str = "tower_slots_total"
COLLISION_COUNTER_NAME: str = "tower_collisions_total"
RESOLVE_HISTOGRAM_NAME: str = "tower_resolve_duration_seconds"
PARSE_HISTOGRAM_NAME: str = "tower_parse_duration_seconds"
REROUTE_COUNTER_NAME: str = "tower_reroutes_total"
ERROR_COUNTER_NAME: str = "tower_errors_total"

# Label allowlist ONLY — never trace_id / request_id as a label (E25).
ALLOWED_LABEL_KEYS: frozenset[str] = frozenset(
    {"lot", "stage", "production", "status", "resource", "from", "to", "code"}
)

# Grafana Cloud env names (endpoint/key NAMES only — values live in the
# environment / Secret Manager, never in the repo).
GRAFANA_OTLP_ENV: str = "GRAFANA_CLOUD_OTLP_ENDPOINT"
GRAFANA_INSTANCE_ENV: str = "GRAFANA_CLOUD_INSTANCE_ID"
GRAFANA_API_KEY_ENV: str = "GRAFANA_CLOUD_API_KEY"

_LOGGER: logging.Logger = logging.getLogger("tower.observability.otel")


def _grafana_endpoint_from_env() -> str:
    """Read the Grafana Cloud OTLP base endpoint (empty = local mode)."""
    return os.environ.get(GRAFANA_OTLP_ENV, "").strip().rstrip("/")


def _grafana_basic_auth_header() -> dict[str, str]:
    """Build the Grafana Cloud OTLP basic-auth header from env.

    Returns an empty dict when either credential is missing so callers
    fall back to in-memory export instead of sending unauthenticated
    traffic. Values are never logged.
    """
    instance_id = os.environ.get(GRAFANA_INSTANCE_ENV, "").strip()
    api_key = os.environ.get(GRAFANA_API_KEY_ENV, "").strip()
    if not instance_id or not api_key:
        return {}
    token = base64.b64encode(f"{instance_id}:{api_key}".encode("utf-8")).decode(
        "ascii"
    )
    return {"Authorization": f"Basic {token}"}


def is_otlp_configured() -> bool:
    """True when a Grafana Cloud OTLP endpoint is configured via env."""
    return bool(_grafana_endpoint_from_env())


def _ensure_stdout_handler() -> None:
    """Attach a stdout log handler once (local-dev log exporter)."""
    root_logger = logging.getLogger("tower.observability")
    for handler in root_logger.handlers:
        if isinstance(handler, logging.StreamHandler):
            return
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(
        logging.Formatter(
            "%(asctime)s %(levelname)s %(name)s trace_id=%(trace_id)s %(message)s",
            defaults={"trace_id": "-"},
        )
    )
    root_logger.addHandler(handler)


class _NoOp:
    """Fallback handle when the OTel SDK is unavailable."""

    def __getattr__(self, _name: str) -> Any:
        def _noop(*_args: Any, **_kwargs: Any) -> None:
            return None

        return _noop


# Module-level provider state (rebound by reset_for_tests()).
_tracer_provider: Any = None
_meter_provider: Any = None
_span_exporter: Any = None
_metric_reader: Any = None
_otlp_enabled: bool = False

tracer: Any = _NoOp()
meter: Any = _NoOp()
slot_counter: Any = _NoOp()
collision_counter: Any = _NoOp()
resolve_histogram: Any = _NoOp()
parse_histogram: Any = _NoOp()
reroute_counter: Any = _NoOp()
error_counter: Any = _NoOp()


def _build_instruments(active_meter: Any) -> dict[str, Any]:
    """Create the six TOWER instruments on ``active_meter``."""
    return {
        "slot_counter": active_meter.create_counter(
            SLOT_COUNTER_NAME, unit="1", description="Slots by status"
        ),
        "collision_counter": active_meter.create_counter(
            COLLISION_COUNTER_NAME, unit="1", description="Collisions by resource"
        ),
        "resolve_histogram": active_meter.create_histogram(
            RESOLVE_HISTOGRAM_NAME,
            unit="s",
            description="Collision resolve duration seconds",
        ),
        "parse_histogram": active_meter.create_histogram(
            PARSE_HISTOGRAM_NAME,
            unit="s",
            description="NL parse duration seconds",
        ),
        "reroute_counter": active_meter.create_counter(
            REROUTE_COUNTER_NAME, unit="1", description="Reroutes by from/to"
        ),
        "error_counter": active_meter.create_counter(
            ERROR_COUNTER_NAME, unit="1", description="Errors by code"
        ),
    }


def _configure_providers() -> None:
    """Wire tracer/meter providers: OTLP when configured, else in-memory.

    Never raises: any exporter/import failure falls back to in-memory
    handles so the hold path stays unblocked.
    """
    global _tracer_provider, _meter_provider, _span_exporter, _metric_reader
    global _otlp_enabled, tracer, meter
    global slot_counter, collision_counter, resolve_histogram, parse_histogram
    global reroute_counter, error_counter

    _ensure_stdout_handler()
    grafana_endpoint = _grafana_endpoint_from_env()
    try:
        from opentelemetry import metrics as _metrics  # type: ignore[import-not-found]
        from opentelemetry import trace as _trace  # type: ignore[import-not-found]
        from opentelemetry.sdk.metrics import MeterProvider as _SDKMeterProvider  # type: ignore[import-not-found]
        from opentelemetry.sdk.metrics.export import (  # type: ignore[import-not-found]
            InMemoryMetricReader as _InMemoryMetricReader,
        )
        from opentelemetry.sdk.resources import Resource as _Resource  # type: ignore[import-not-found]
        from opentelemetry.sdk.trace import TracerProvider as _TracerProvider  # type: ignore[import-not-found]
        from opentelemetry.sdk.trace.export import (  # type: ignore[import-not-found]
            SimpleSpanProcessor as _SimpleSpanProcessor,
        )
        from opentelemetry.sdk.trace.export.in_memory_span_exporter import (  # type: ignore[import-not-found]
            InMemorySpanExporter as _InMemorySpanExporter,
        )
    except ImportError as exc:
        _LOGGER.warning("otel sdk unavailable, using no-op handles: %s", exc)
        fallback = _NoOp()
        tracer = fallback
        meter = fallback
        slot_counter = fallback
        collision_counter = fallback
        resolve_histogram = fallback
        parse_histogram = fallback
        reroute_counter = fallback
        error_counter = fallback
        _otlp_enabled = False
        return

    resource = _Resource.create(
        {"service.name": "tower", "service.namespace": "tower"}
    )

    # Default: in-memory (tests + local dev, synchronous, no network).
    span_exporter: Any = _InMemorySpanExporter()
    tracer_provider: Any = _TracerProvider(resource=resource)
    tracer_provider.add_span_processor(_SimpleSpanProcessor(span_exporter))
    metric_reader: Any = _InMemoryMetricReader()
    meter_provider: Any = _SDKMeterProvider(
        resource=resource, metric_readers=[metric_reader]
    )
    otlp_enabled = False

    if grafana_endpoint:
        try:
            from opentelemetry.exporter.otlp.proto.http.metric_exporter import (  # type: ignore[import-not-found]
                OTLPMetricExporter as _OTLPMetricExporter,
            )
            from opentelemetry.exporter.otlp.proto.http.trace_exporter import (  # type: ignore[import-not-found]
                OTLPSpanExporter as _OTLPSpanExporter,
            )
            from opentelemetry.sdk.metrics.export import (  # type: ignore[import-not-found]
                PeriodicExportingMetricReader as _PeriodicReader,
            )
            from opentelemetry.sdk.trace.export import (  # type: ignore[import-not-found]
                BatchSpanProcessor as _BatchSpanProcessor,
            )

            headers = _grafana_basic_auth_header()
            if not headers:
                raise ValueError(
                    "grafana otlp endpoint set without instance/api-key"
                )
            # Grafana Cloud OTLP gateway: base + /v1/<signal>.
            span_otlp = _OTLPSpanExporter(
                endpoint=f"{grafana_endpoint}/v1/traces", headers=headers
            )
            metric_otlp = _OTLPMetricExporter(
                endpoint=f"{grafana_endpoint}/v1/metrics", headers=headers
            )
            tracer_provider = _TracerProvider(resource=resource)
            tracer_provider.add_span_processor(_BatchSpanProcessor(span_otlp))
            metric_reader = _PeriodicReader(metric_otlp, export_interval_millis=5000)
            meter_provider = _SDKMeterProvider(
                resource=resource, metric_readers=[metric_reader]
            )
            # Keep an in-memory exporter alongside OTLP so tests can still
            # assert correlation without network.
            span_exporter = _InMemorySpanExporter()
            tracer_provider.add_span_processor(_SimpleSpanProcessor(span_exporter))
            otlp_enabled = True
            _LOGGER.info("otel exporters configured for grafana cloud otlp")
        except Exception as exc:
            _LOGGER.warning(
                "grafana otlp setup failed, in-memory fallback active: %s", exc
            )
            otlp_enabled = False

    _tracer_provider = tracer_provider
    _meter_provider = meter_provider
    _span_exporter = span_exporter
    _metric_reader = metric_reader
    _otlp_enabled = otlp_enabled

    try:
        _trace.set_tracer_provider(_tracer_provider)
    except Exception:
        pass
    try:
        _metrics.set_meter_provider(_meter_provider)
    except Exception:
        pass

    tracer = _tracer_provider.get_tracer(TRACER_NAME)
    meter = _meter_provider.get_meter(METER_NAME)
    try:
        instruments = _build_instruments(meter)
    except Exception as exc:
        _LOGGER.warning("otel instrument creation failed: %s", exc)
        fallback = _NoOp()
        instruments = {
            "slot_counter": fallback,
            "collision_counter": fallback,
            "resolve_histogram": fallback,
            "parse_histogram": fallback,
            "reroute_counter": fallback,
            "error_counter": fallback,
        }
    slot_counter = instruments["slot_counter"]
    collision_counter = instruments["collision_counter"]
    resolve_histogram = instruments["resolve_histogram"]
    parse_histogram = instruments["parse_histogram"]
    reroute_counter = instruments["reroute_counter"]
    error_counter = instruments["error_counter"]


_configure_providers()


def get_span_exporter() -> Any:
    """Return the current in-memory span exporter (None when OTLP-only)."""
    return _span_exporter


def get_metric_reader() -> Any:
    """Return the current metric reader (in-memory locally)."""
    return _metric_reader


def get_metrics_data() -> Any:
    """Collect current metrics data from the active reader."""
    reader = _metric_reader
    collect = getattr(reader, "get_metrics_data", None)
    if callable(collect):
        try:
            return collect()
        except Exception as exc:
            _LOGGER.warning("otel metrics collect failed: %s", exc)
            return None
    return None


def get_finished_spans() -> list[Any]:
    """Return finished spans from the in-memory exporter (tests)."""
    exporter = _span_exporter
    getter = getattr(exporter, "get_finished_spans", None)
    if callable(getter):
        try:
            result: Any = getter()
            return list(result)
        except Exception as exc:
            _LOGGER.warning("otel span read failed: %s", exc)
            return []
    return []


def reset_for_tests() -> None:
    """Rebuild in-memory providers so tests start from a clean slate.

    No network, no sleeps. Safe to call repeatedly; rebinds the module
    ``tracer`` / ``meter`` / instrument handles.
    """
    for key in (GRAFANA_OTLP_ENV,):
        saved = os.environ.get(key, "")
        if saved:
            # Tests must never push to Grafana Cloud: force local mode by
            # temporarily clearing the endpoint, then restoring it.
            del os.environ[key]
            try:
                _configure_providers()
            finally:
                os.environ[key] = saved
            return
    _configure_providers()


def _delegate_emit(name: str, *args: Any, **kwargs: Any) -> None:
    """Forward an emit call to the emitter without ever raising."""
    try:
        from agent.observability import emitter as _emitter  # noqa: PLC0415

        func = getattr(_emitter, name, None)
        if func is None:
            _LOGGER.warning("otel emit delegate missing: %s", name)
            return
        func(*args, **kwargs)
    except Exception as exc:
        _LOGGER.exception("otel emit %s failed (never blocks holds): %s", name, exc)


def emit_parse(*args: Any, **kwargs: Any) -> None:
    """Emit parse metric+log+trace (delegates to emitter, never raises)."""
    _delegate_emit("emit_parse", *args, **kwargs)


def emit_collision(*args: Any, **kwargs: Any) -> None:
    """Emit collision metric+log+span (delegates to emitter, never raises)."""
    _delegate_emit("emit_collision", *args, **kwargs)


def emit_hold(*args: Any, **kwargs: Any) -> None:
    """Emit hold metric+log+span (delegates to emitter, never raises)."""
    _delegate_emit("emit_hold", *args, **kwargs)


def emit_reroute(*args: Any, **kwargs: Any) -> None:
    """Emit reroute metric+log+trace link (delegates to emitter)."""
    _delegate_emit("emit_reroute", *args, **kwargs)


def emit_error(*args: Any, **kwargs: Any) -> None:
    """Emit error metric+log+span (delegates to emitter, never raises)."""
    _delegate_emit("emit_error", *args, **kwargs)
