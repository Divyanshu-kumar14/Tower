"""TOWER observability emitter — metric+log+trace per PRD §8.2 (T-06).

Emit table (every call shares one ``trace_id`` across all signals):

* ``parse`` → ``tower_parse_duration_seconds`` + info log + ``parse`` span
* ``collision`` → ``tower_collisions_total`` + warn log + ``collision`` span
* ``hold`` → ``tower_slots_total`` + info log + ``hold`` span
* ``reroute`` → ``tower_reroutes_total`` + info log + ``reroute`` span
* ``error`` → ``tower_errors_total`` + error log + ERROR span

``trace_id`` travels in log fields + span attributes, never as a metric
label (E25). PII is scrubbed via :func:`redactPII` before any log emit
(E22). Failures enqueue to a local buffer with retry and surface the
``observability_delayed`` stale signal; emit calls never raise into the
hold path (E15).
"""

from __future__ import annotations

import logging
import re
import sys
import threading
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from agent.observability import otel as _otel  # noqa: E402

__all__ = [
    "ALLOWED_LABEL_KEYS",
    "OBSERVABILITY_DELAYED_SIGNAL",
    "BufferedEvent",
    "redactPII",
    "sanitize_labels",
    "emit_parse",
    "emit_collision",
    "emit_hold",
    "emit_reroute",
    "emit_error",
    "buffer_depth",
    "is_observability_delayed",
    "drain_buffer",
    "get_log_records",
    "get_emitted_metrics",
    "reset_for_tests",
]

ALLOWED_LABEL_KEYS: frozenset[str] = frozenset(
    {"lot", "stage", "production", "status", "resource", "from", "to", "code"}
)

OBSERVABILITY_DELAYED_SIGNAL: str = "observability_delayed"

_LOGGER: logging.Logger = logging.getLogger("tower.observability.emitter")

_PHONE_RE: re.Pattern[str] = re.compile(
    r"(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}"
)
_EMAIL_RE: re.Pattern[str] = re.compile(
    r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"
)
_REDACTED: str = "[REDACTED]"

_MAX_BUFFER: int = 1000


def redactPII(text: str) -> str:
    """Scrub phone-like patterns + emails before any Loki emit (E22).

    Inputs: raw log text. Output: text with phone numbers and emails
    replaced by ``[REDACTED]``. Pure function — never raises on str
    input, never touches the network.
    """
    if not text:
        return text
    scrubbed = _PHONE_RE.sub(_REDACTED, text)
    scrubbed = _EMAIL_RE.sub(_REDACTED, scrubbed)
    return scrubbed


def sanitize_labels(labels: dict[str, Any]) -> dict[str, str]:
    """Filter metric attributes to the label allowlist (E25).

    Inputs: candidate label dict. Output: only allowlisted keys with
    string values. ``trace_id`` / ``request_id`` / unknown keys are
    dropped loudly (debug log) so cardinality can never explode.
    """
    clean: dict[str, str] = {}
    for key, value in labels.items():
        if key not in ALLOWED_LABEL_KEYS:
            _LOGGER.debug("dropping non-allowlisted label key=%s", key)
            continue
        if value is None:
            continue
        text_value = str(value)
        if text_value == "":
            continue
        clean[key] = text_value
    return clean


def _new_trace_id() -> str:
    """Generate a fresh ``trace_``-prefixed correlation id."""
    return f"trace_{uuid.uuid4().hex[:16]}"


def _coerce_trace_id(trace_id: str) -> str:
    """Return the caller trace_id or a fresh one when empty."""
    candidate = (trace_id or "").strip()
    if candidate:
        return candidate
    return _new_trace_id()


@dataclass
class BufferedEvent:
    """One deferred emit waiting for exporter recovery (E15)."""

    kind: str
    trace_id: str
    payload: dict[str, Any] = field(default_factory=dict)
    attempts: int = 0
    enqueued_at: float = field(default_factory=time.time)


_BUFFER: deque[BufferedEvent] = deque()
_BUFFER_LOCK: threading.Lock = threading.Lock()
_LOG_RECORDS: list[dict[str, Any]] = []
_LOG_LOCK: threading.Lock = threading.Lock()
_EMITTED_METRICS: list[dict[str, Any]] = []
_METRIC_LOCK: threading.Lock = threading.Lock()


def buffer_depth() -> int:
    """Return the number of buffered (not yet flushed) events."""
    with _BUFFER_LOCK:
        return len(_BUFFER)


def is_observability_delayed() -> bool:
    """Stale signal: True when the local buffer is non-empty (E15).

    The grafana cloud push is delayed while this is True; the hold path
    itself is never blocked.
    """
    grafana_configured = _otel.is_otlp_configured()
    _LOGGER.debug("grafana otlp configured=%s", grafana_configured)
    return buffer_depth() > 0


def _enqueue_buffered(kind: str, trace_id: str, payload: dict[str, Any]) -> None:
    """Append one event to the retry buffer (bounded, drops oldest)."""
    with _BUFFER_LOCK:
        if len(_BUFFER) >= _MAX_BUFFER:
            _BUFFER.popleft()
            _LOGGER.warning(
                "observability buffer full (%d); dropping oldest (%s)",
                _MAX_BUFFER,
                OBSERVABILITY_DELAYED_SIGNAL,
            )
        _BUFFER.append(BufferedEvent(kind=kind, trace_id=trace_id, payload=dict(payload)))


def _record_log(
    *, level: str, event: str, message: str, trace_id: str, extra: dict[str, Any]
) -> dict[str, Any]:
    """Append an in-memory log record + write to stdout (redacted)."""
    redacted = redactPII(message)
    record: dict[str, Any] = {
        "level": level,
        "event": event,
        "message": redacted,
        "trace_id": trace_id,
        "timestamp": time.time(),
        "attributes": dict(extra),
    }
    with _LOG_LOCK:
        _LOG_RECORDS.append(record)
    log_method = getattr(_LOGGER, level, _LOGGER.info)
    try:
        log_method("%s trace_id=%s %s", event, trace_id, redacted, extra={"trace_id": trace_id})
    except Exception:
        _LOGGER.info("%s trace_id=%s %s", event, trace_id, redacted)
    return record


def get_log_records() -> list[dict[str, Any]]:
    """Return a copy of in-memory log records (tests)."""
    with _LOG_LOCK:
        return [dict(record) for record in _LOG_RECORDS]


def get_emitted_metrics() -> list[dict[str, Any]]:
    """Return the metric-emit sidecar envelopes (tests).

    Each envelope carries the caller ``trace_id`` as metadata for
    correlation WITHOUT sending it as a metric label (E25).
    """
    with _METRIC_LOCK:
        return [dict(entry) for entry in _EMITTED_METRICS]


def _record_metric_envelope(
    *, instrument: str, value: float, attributes: dict[str, str], trace_id: str
) -> None:
    """Store one sidecar envelope linking a metric point to a trace_id."""
    with _METRIC_LOCK:
        _EMITTED_METRICS.append(
            {
                "instrument": instrument,
                "value": value,
                "attributes": dict(attributes),
                "trace_id": trace_id,
            }
        )


def _safe_metric_call(description: str, func: Any, *args: Any, **kwargs: Any) -> bool:
    """Invoke one OTel instrument call; False on failure (then buffered)."""
    try:
        func(*args, **kwargs)
        return True
    except Exception as exc:
        _LOGGER.exception("observability metric %s failed: %s", description, exc)
        return False


def _safe_span(name: str, attributes: dict[str, Any]) -> Any:
    """Create a span context manager or None when the SDK is inert."""
    try:
        tracer = _otel.tracer
        starter = getattr(tracer, "start_as_current_span", None)
        if not callable(starter):
            return None
        clean: dict[str, Any] = {}
        for key, value in attributes.items():
            if value is None:
                continue
            if isinstance(value, (str, bool, int, float)):
                clean[str(key)] = value
            else:
                clean[str(key)] = str(value)
        return starter(name, attributes=clean)
    except Exception as exc:
        _LOGGER.exception("observability span %s failed: %s", name, exc)
        return None


def _do_emit_parse(
    *,
    trace_id: str,
    duration_s: float,
    confidence: float,
    slot_count: int,
    text: str,
    lot: str,
    production: str,
    stage: str,
) -> None:
    """Single-attempt parse emit (may raise; public wrapper buffers)."""
    labels = sanitize_labels({"lot": lot, "production": production, "stage": stage})
    ok = _safe_metric_call(
        _otel.PARSE_HISTOGRAM_NAME,
        _otel.parse_histogram.record,
        float(duration_s),
        labels,
    )
    if not ok:
        raise RuntimeError("parse histogram export failed")
    _record_metric_envelope(
        instrument=_otel.PARSE_HISTOGRAM_NAME,
        value=float(duration_s),
        attributes=labels,
        trace_id=trace_id,
    )
    preview = redactPII(text[:200])
    _record_log(
        level="info",
        event="parse",
        message=f"Parsed {slot_count} slots confidence={confidence:.2f} text={preview!r}",
        trace_id=trace_id,
        extra={"confidence": confidence, "slot_count": slot_count},
    )
    span_cm = _safe_span(
        "parse",
        {
            "trace_id": trace_id,
            "confidence": float(confidence),
            "slot_count": int(slot_count),
            "duration_s": float(duration_s),
        },
    )
    if span_cm is not None:
        with span_cm:
            pass


def _do_emit_collision(
    *,
    trace_id: str,
    resource: str,
    overlap: str,
    blocked_by: str,
    alternative_count: int,
    lot: str,
    production: str,
    stage: str,
) -> None:
    """Single-attempt collision emit (may raise; public wrapper buffers)."""
    labels = sanitize_labels(
        {"resource": resource, "lot": lot, "production": production, "stage": stage}
    )
    ok = _safe_metric_call(
        _otel.COLLISION_COUNTER_NAME, _otel.collision_counter.add, 1, labels
    )
    if not ok:
        raise RuntimeError("collision counter export failed")
    _record_metric_envelope(
        instrument=_otel.COLLISION_COUNTER_NAME,
        value=1.0,
        attributes=labels,
        trace_id=trace_id,
    )
    _record_log(
        level="warning",
        event="collision",
        message=(
            f"Collision {resource} overlap {overlap} blockedBy={blocked_by} "
            f"alternatives={alternative_count}"
        ),
        trace_id=trace_id,
        extra={
            "resource": resource,
            "overlap": overlap,
            "blocked_by": blocked_by,
            "alternative_count": alternative_count,
        },
    )
    span_cm = _safe_span(
        "collision_check",
        {
            "trace_id": trace_id,
            "resource": resource,
            "overlap": overlap,
            "blocked_by": blocked_by,
            "alternative.count": int(alternative_count),
        },
    )
    if span_cm is not None:
        with span_cm:
            pass


def _do_emit_hold(
    *,
    trace_id: str,
    resource_id: str,
    status: str,
    start: str,
    end: str,
    crew: str,
    duration_s: float,
    lot: str,
    production: str,
    stage: str,
) -> None:
    """Single-attempt hold emit (may raise; public wrapper buffers)."""
    labels = sanitize_labels(
        {"status": status, "lot": lot, "production": production, "stage": stage}
    )
    ok = _safe_metric_call(
        _otel.SLOT_COUNTER_NAME, _otel.slot_counter.add, 1, labels
    )
    if not ok:
        raise RuntimeError("slot counter export failed")
    _record_metric_envelope(
        instrument=_otel.SLOT_COUNTER_NAME,
        value=1.0,
        attributes=labels,
        trace_id=trace_id,
    )
    if duration_s > 0:
        resolve_labels = sanitize_labels(
            {"lot": lot, "production": production, "stage": stage}
        )
        ok_resolve = _safe_metric_call(
            _otel.RESOLVE_HISTOGRAM_NAME,
            _otel.resolve_histogram.record,
            float(duration_s),
            resolve_labels,
        )
        if ok_resolve:
            _record_metric_envelope(
                instrument=_otel.RESOLVE_HISTOGRAM_NAME,
                value=float(duration_s),
                attributes=resolve_labels,
                trace_id=trace_id,
            )
    window = f"{start}--{end}" if (start or end) else resource_id
    _record_log(
        level="info",
        event="hold",
        message=f"Hold {resource_id} {window} status={status} crew={crew}",
        trace_id=trace_id,
        extra={
            "resource_id": resource_id,
            "status": status,
            "start": start,
            "end": end,
            "crew": crew,
        },
    )
    span_cm = _safe_span(
        "hold",
        {
            "trace_id": trace_id,
            "resource_id": resource_id,
            "status": status,
            "start": start,
            "end": end,
            "crew": crew,
        },
    )
    if span_cm is not None:
        with span_cm:
            pass


def _do_emit_reroute(
    *,
    trace_id: str,
    from_resource: str,
    to_resource: str,
    request_id: str,
    reason: str,
    duration_s: float,
    lot: str,
    production: str,
    stage: str,
) -> None:
    """Single-attempt reroute emit (may raise; public wrapper buffers)."""
    labels = sanitize_labels(
        {
            "from": from_resource,
            "to": to_resource,
            "lot": lot,
            "production": production,
            "stage": stage,
        }
    )
    ok = _safe_metric_call(
        _otel.REROUTE_COUNTER_NAME, _otel.reroute_counter.add, 1, labels
    )
    if not ok:
        raise RuntimeError("reroute counter export failed")
    _record_metric_envelope(
        instrument=_otel.REROUTE_COUNTER_NAME,
        value=1.0,
        attributes=labels,
        trace_id=trace_id,
    )
    if duration_s > 0:
        resolve_labels = sanitize_labels(
            {"lot": lot, "production": production, "stage": stage}
        )
        ok_resolve = _safe_metric_call(
            _otel.RESOLVE_HISTOGRAM_NAME,
            _otel.resolve_histogram.record,
            float(duration_s),
            resolve_labels,
        )
        if ok_resolve:
            _record_metric_envelope(
                instrument=_otel.RESOLVE_HISTOGRAM_NAME,
                value=float(duration_s),
                attributes=resolve_labels,
                trace_id=trace_id,
            )
    _record_log(
        level="info",
        event="reroute",
        message=f"Reroute {request_id} {from_resource}->{to_resource} reason={reason}",
        trace_id=trace_id,
        extra={
            "from_resource": from_resource,
            "to_resource": to_resource,
            "request_id": request_id,
            "reason": reason,
        },
    )
    span_cm = _safe_span(
        "reroute",
        {
            "trace_id": trace_id,
            "from": from_resource,
            "to": to_resource,
            "request_id": request_id,
            "reason": reason,
        },
    )
    if span_cm is not None:
        with span_cm:
            pass


def _do_emit_error(
    *,
    trace_id: str,
    code: str,
    message: str,
    lot: str,
    production: str,
    stage: str,
) -> None:
    """Single-attempt error emit (may raise; public wrapper buffers)."""
    labels = sanitize_labels(
        {"code": code, "lot": lot, "production": production, "stage": stage}
    )
    ok = _safe_metric_call(
        _otel.ERROR_COUNTER_NAME, _otel.error_counter.add, 1, labels
    )
    if not ok:
        raise RuntimeError("error counter export failed")
    _record_metric_envelope(
        instrument=_otel.ERROR_COUNTER_NAME,
        value=1.0,
        attributes=labels,
        trace_id=trace_id,
    )
    _record_log(
        level="error",
        event="error",
        message=f"Hold failed {code} {message}",
        trace_id=trace_id,
        extra={"code": code},
    )
    span_cm = _safe_span(
        "error", {"trace_id": trace_id, "code": code, "message": message[:500]}
    )
    if span_cm is not None:
        try:
            with span_cm as span:
                try:
                    from opentelemetry.trace import (  # type: ignore[import-not-found]
                        Status as _TraceStatus,
                        StatusCode as _StatusCode,
                    )

                    span.set_status(_TraceStatus(_StatusCode.ERROR, message[:200]))
                except Exception:
                    pass
                try:
                    span.record_exception(ValueError(f"{code}: {message[:200]}"))
                except Exception:
                    pass
        except Exception as exc:
            _LOGGER.exception("observability error-span failed: %s", exc)


def emit_parse(
    *,
    trace_id: str = "",
    duration_s: float = 0.0,
    confidence: float = 0.0,
    slot_count: int = 0,
    text: str = "",
    lot: str = "main",
    production: str = "",
    stage: str = "",
) -> None:
    """Emit parse metric+log+trace sharing ``trace_id`` (never raises)."""
    resolved = _coerce_trace_id(trace_id)
    try:
        _do_emit_parse(
            trace_id=resolved,
            duration_s=float(duration_s),
            confidence=float(confidence),
            slot_count=int(slot_count),
            text=str(text),
            lot=str(lot),
            production=str(production),
            stage=str(stage),
        )
    except Exception as exc:
        _LOGGER.exception(
            "emit_parse failed, buffering (%s): %s",
            OBSERVABILITY_DELAYED_SIGNAL,
            exc,
        )
        _enqueue_buffered(
            "parse",
            resolved,
            {
                "duration_s": float(duration_s),
                "confidence": float(confidence),
                "slot_count": int(slot_count),
                "text": str(text)[:500],
                "lot": str(lot),
                "production": str(production),
                "stage": str(stage),
            },
        )


def emit_collision(
    *,
    trace_id: str = "",
    resource: str = "",
    overlap: str = "",
    blocked_by: str = "",
    alternative_count: int = 0,
    lot: str = "main",
    production: str = "",
    stage: str = "",
) -> None:
    """Emit collision metric+log+span sharing ``trace_id`` (never raises)."""
    resolved = _coerce_trace_id(trace_id)
    try:
        _do_emit_collision(
            trace_id=resolved,
            resource=str(resource),
            overlap=str(overlap),
            blocked_by=str(blocked_by),
            alternative_count=int(alternative_count),
            lot=str(lot),
            production=str(production),
            stage=str(stage),
        )
    except Exception as exc:
        _LOGGER.exception(
            "emit_collision failed, buffering (%s): %s",
            OBSERVABILITY_DELAYED_SIGNAL,
            exc,
        )
        _enqueue_buffered(
            "collision",
            resolved,
            {
                "resource": str(resource),
                "overlap": str(overlap),
                "blocked_by": str(blocked_by),
                "alternative_count": int(alternative_count),
                "lot": str(lot),
                "production": str(production),
                "stage": str(stage),
            },
        )


def emit_hold(
    *,
    trace_id: str = "",
    resource_id: str = "",
    status: str = "confirmed",
    start: str = "",
    end: str = "",
    crew: str = "",
    duration_s: float = 0.0,
    lot: str = "main",
    production: str = "",
    stage: str = "",
) -> None:
    """Emit hold metric+log+span sharing ``trace_id`` (never raises)."""
    resolved = _coerce_trace_id(trace_id)
    try:
        _do_emit_hold(
            trace_id=resolved,
            resource_id=str(resource_id),
            status=str(status),
            start=str(start),
            end=str(end),
            crew=str(crew),
            duration_s=float(duration_s),
            lot=str(lot),
            production=str(production),
            stage=str(stage),
        )
    except Exception as exc:
        _LOGGER.exception(
            "emit_hold failed, buffering (%s): %s",
            OBSERVABILITY_DELAYED_SIGNAL,
            exc,
        )
        _enqueue_buffered(
            "hold",
            resolved,
            {
                "resource_id": str(resource_id),
                "status": str(status),
                "start": str(start),
                "end": str(end),
                "crew": str(crew),
                "duration_s": float(duration_s),
                "lot": str(lot),
                "production": str(production),
                "stage": str(stage),
            },
        )


def emit_reroute(
    *,
    trace_id: str = "",
    from_resource: str = "",
    to_resource: str = "",
    request_id: str = "",
    reason: str = "collision",
    duration_s: float = 0.0,
    lot: str = "main",
    production: str = "",
    stage: str = "",
) -> None:
    """Emit reroute metric+log+trace link sharing ``trace_id`` (never raises)."""
    resolved = _coerce_trace_id(trace_id)
    try:
        _do_emit_reroute(
            trace_id=resolved,
            from_resource=str(from_resource),
            to_resource=str(to_resource),
            request_id=str(request_id),
            reason=str(reason),
            duration_s=float(duration_s),
            lot=str(lot),
            production=str(production),
            stage=str(stage),
        )
    except Exception as exc:
        _LOGGER.exception(
            "emit_reroute failed, buffering (%s): %s",
            OBSERVABILITY_DELAYED_SIGNAL,
            exc,
        )
        _enqueue_buffered(
            "reroute",
            resolved,
            {
                "from_resource": str(from_resource),
                "to_resource": str(to_resource),
                "request_id": str(request_id),
                "reason": str(reason),
                "duration_s": float(duration_s),
                "lot": str(lot),
                "production": str(production),
                "stage": str(stage),
            },
        )


def emit_error(
    *,
    trace_id: str = "",
    code: str = "500",
    message: str = "",
    lot: str = "main",
    production: str = "",
    stage: str = "",
) -> None:
    """Emit error metric+log+span sharing ``trace_id`` (never raises)."""
    resolved = _coerce_trace_id(trace_id)
    try:
        _do_emit_error(
            trace_id=resolved,
            code=str(code),
            message=str(message),
            lot=str(lot),
            production=str(production),
            stage=str(stage),
        )
    except Exception as exc:
        _LOGGER.exception(
            "emit_error failed, buffering (%s): %s",
            OBSERVABILITY_DELAYED_SIGNAL,
            exc,
        )
        _enqueue_buffered(
            "error",
            resolved,
            {
                "code": str(code),
                "message": str(message)[:500],
                "lot": str(lot),
                "production": str(production),
                "stage": str(stage),
            },
        )


def drain_buffer() -> int:
    """Retry buffered events against the live exporters (E15).

    Returns the number of events successfully flushed. Failures stay
    queued with an incremented attempt count; never raises.
    """
    drained = 0
    while True:
        with _BUFFER_LOCK:
            if not _BUFFER:
                return drained
            event = _BUFFER[0]
        try:
            payload = dict(event.payload)
            if event.kind == "parse":
                _do_emit_parse(
                    trace_id=event.trace_id,
                    duration_s=float(payload.get("duration_s", 0.0)),
                    confidence=float(payload.get("confidence", 0.0)),
                    slot_count=int(payload.get("slot_count", 0)),
                    text=str(payload.get("text", "")),
                    lot=str(payload.get("lot", "main")),
                    production=str(payload.get("production", "")),
                    stage=str(payload.get("stage", "")),
                )
            elif event.kind == "collision":
                _do_emit_collision(
                    trace_id=event.trace_id,
                    resource=str(payload.get("resource", "")),
                    overlap=str(payload.get("overlap", "")),
                    blocked_by=str(payload.get("blocked_by", "")),
                    alternative_count=int(payload.get("alternative_count", 0)),
                    lot=str(payload.get("lot", "main")),
                    production=str(payload.get("production", "")),
                    stage=str(payload.get("stage", "")),
                )
            elif event.kind == "hold":
                _do_emit_hold(
                    trace_id=event.trace_id,
                    resource_id=str(payload.get("resource_id", "")),
                    status=str(payload.get("status", "confirmed")),
                    start=str(payload.get("start", "")),
                    end=str(payload.get("end", "")),
                    crew=str(payload.get("crew", "")),
                    duration_s=float(payload.get("duration_s", 0.0)),
                    lot=str(payload.get("lot", "main")),
                    production=str(payload.get("production", "")),
                    stage=str(payload.get("stage", "")),
                )
            elif event.kind == "reroute":
                _do_emit_reroute(
                    trace_id=event.trace_id,
                    from_resource=str(payload.get("from_resource", "")),
                    to_resource=str(payload.get("to_resource", "")),
                    request_id=str(payload.get("request_id", "")),
                    reason=str(payload.get("reason", "collision")),
                    duration_s=float(payload.get("duration_s", 0.0)),
                    lot=str(payload.get("lot", "main")),
                    production=str(payload.get("production", "")),
                    stage=str(payload.get("stage", "")),
                )
            elif event.kind == "error":
                _do_emit_error(
                    trace_id=event.trace_id,
                    code=str(payload.get("code", "500")),
                    message=str(payload.get("message", "")),
                    lot=str(payload.get("lot", "main")),
                    production=str(payload.get("production", "")),
                    stage=str(payload.get("stage", "")),
                )
            else:
                raise ValueError(f"unknown buffered kind: {event.kind}")
        except Exception as exc:
            _LOGGER.warning(
                "buffered %s emit still failing (%s): %s",
                event.kind,
                OBSERVABILITY_DELAYED_SIGNAL,
                exc,
            )
            with _BUFFER_LOCK:
                if _BUFFER and _BUFFER[0] is event:
                    event.attempts += 1
            return drained
        with _BUFFER_LOCK:
            if _BUFFER and _BUFFER[0] is event:
                _BUFFER.popleft()
                drained += 1
            else:
                return drained


def reset_for_tests() -> None:
    """Clear buffer + logs + metric envelopes + OTel in-memory state."""
    with _BUFFER_LOCK:
        _BUFFER.clear()
    with _LOG_LOCK:
        _LOG_RECORDS.clear()
    with _METRIC_LOCK:
        _EMITTED_METRICS.clear()
    try:
        _otel.reset_for_tests()
    except Exception as exc:
        _LOGGER.warning("otel reset_for_tests failed: %s", exc)
