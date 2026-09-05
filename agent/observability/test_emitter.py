"""TOWER emitter correlation tests — in-memory exporters only (T-06).

Run: ``uv run --project agent --python 3.11 pytest agent/observability -q``
from the repo root. No sleeps, no network, no secrets.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from agent.observability import emitter as _emitter  # noqa: E402
from agent.observability import otel as _otel  # noqa: E402
from agent.observability.emitter import (  # noqa: E402
    buffer_depth,
    drain_buffer,
    emit_collision,
    emit_error,
    emit_hold,
    emit_parse,
    emit_reroute,
    get_emitted_metrics,
    get_log_records,
    is_observability_delayed,
    redactPII,
    reset_for_tests,
)


def _otel_metric_names() -> set[str]:
    """Collect metric names from the in-memory reader (tests only)."""
    data: Any = _otel.get_metrics_data()
    names: set[str] = set()
    if data is None:
        return names
    for resource_metrics in getattr(data, "resource_metrics", []):
        for scope_metrics in getattr(resource_metrics, "scope_metrics", []):
            for metric in getattr(scope_metrics, "metrics", []):
                names.add(str(getattr(metric, "name", "")))
    return names


def _spans_with_trace(trace_id: str) -> list[Any]:
    """Finished spans carrying ``trace_id`` in attributes."""
    matched: list[Any] = []
    for span in _otel.get_finished_spans():
        attrs: Any = getattr(span, "attributes", None)
        if attrs is not None and dict(attrs).get("trace_id") == trace_id:
            matched.append(span)
    return matched


def test_emit_hold_correlates_metric_log_span() -> None:
    """One emit_hold call yields metric + log + span sharing trace_id."""
    reset_for_tests()
    trace_id = "trace_corr_hold_001"
    emit_hold(
        trace_id=trace_id,
        resource_id="stage-2",
        status="confirmed",
        start="2026-09-06T06:00:00Z",
        end="2026-09-06T18:00:00Z",
        crew="maya",
        lot="main",
        production="atlas",
        stage="2",
    )
    envelopes = [
        entry
        for entry in get_emitted_metrics()
        if entry["trace_id"] == trace_id
        and entry["instrument"] == _otel.SLOT_COUNTER_NAME
    ]
    assert len(envelopes) == 1
    assert envelopes[0]["attributes"].get("status") == "confirmed"
    logs = [rec for rec in get_log_records() if rec["trace_id"] == trace_id]
    assert len(logs) == 1
    assert logs[0]["event"] == "hold"
    spans = _spans_with_trace(trace_id)
    assert len(spans) == 1
    assert _otel.SLOT_COUNTER_NAME in _otel_metric_names()


def test_emit_parse_collision_reroute_error_smoke() -> None:
    """Each emit-table row produces its instrument + log + span."""
    reset_for_tests()
    emit_parse(
        trace_id="trace_smoke_parse",
        duration_s=0.12,
        confidence=0.92,
        slot_count=3,
        text="Stage 3 tomorrow 6am",
        production="atlas",
    )
    emit_collision(
        trace_id="trace_smoke_collision",
        resource="stage-3",
        overlap="08:00-10:00",
        blocked_by="req_atlas",
        alternative_count=2,
        production="atlas",
    )
    emit_reroute(
        trace_id="trace_smoke_reroute",
        from_resource="stage-3",
        to_resource="stage-2",
        request_id="req_123",
        reason="collision",
        production="atlas",
    )
    emit_error(trace_id="trace_smoke_error", code="409", message="STALE_ALTERNATIVE")
    names = _otel_metric_names()
    assert _otel.PARSE_HISTOGRAM_NAME in names
    assert _otel.COLLISION_COUNTER_NAME in names
    assert _otel.REROUTE_COUNTER_NAME in names
    assert _otel.ERROR_COUNTER_NAME in names
    for trace_id in (
        "trace_smoke_parse",
        "trace_smoke_collision",
        "trace_smoke_reroute",
        "trace_smoke_error",
    ):
        assert len(_spans_with_trace(trace_id)) == 1
        assert any(rec["trace_id"] == trace_id for rec in get_log_records())


def test_redactPII_strips_phone_like_patterns() -> None:
    """E22: phone-like patterns + emails never reach logs."""
    assert "415-555-1234" not in redactPII("call Maya at 415-555-1234 now")
    assert "[REDACTED]" in redactPII("call Maya at 415-555-1234 now")
    assert "(415) 555-1234" not in redactPII("crew (415) 555-1234 on file")
    assert "+1 415-555-0199" not in redactPII("phone +1 415-555-0199 urgent")
    assert "maya@studio.test" not in redactPII("mail maya@studio.test today")
    assert redactPII("") == ""
    # Emit path redacts before storing the log record.
    reset_for_tests()
    emit_hold(trace_id="trace_pii_001", resource_id="stage-2", crew="415-555-1234")
    logged = [rec for rec in get_log_records() if rec["trace_id"] == "trace_pii_001"]
    assert len(logged) == 1
    assert "415-555-1234" not in logged[0]["message"]


def test_buffer_drains_on_exporter_recovery(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """E15: failed emits buffer with a stale signal, then drain on recovery."""
    reset_for_tests()
    original = _emitter._safe_metric_call
    calls = {"count": 0}

    def _flaky(description: str, func: Any, *args: Any, **kwargs: Any) -> bool:
        if calls["count"] == 0:
            calls["count"] += 1
            return False
        return bool(original(description, func, *args, **kwargs))

    monkeypatch.setattr(_emitter, "_safe_metric_call", _flaky)
    emit_hold(trace_id="trace_buffer_001", resource_id="stage-2", status="confirmed")
    assert buffer_depth() == 1
    assert is_observability_delayed() is True
    drained = drain_buffer()
    assert drained == 1
    assert buffer_depth() == 0
    assert is_observability_delayed() is False
    assert len(_spans_with_trace("trace_buffer_001")) == 1
    assert any(
        rec["trace_id"] == "trace_buffer_001" for rec in get_log_records()
    )


def test_emit_never_raises_into_hold_path(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Emit calls never raise, even when every exporter is down."""
    reset_for_tests()

    def _always_fail(description: str, func: Any, *args: Any, **kwargs: Any) -> bool:
        return False

    def _span_boom(name: str, attributes: dict[str, Any]) -> Any:
        raise RuntimeError("tempo down")

    monkeypatch.setattr(_emitter, "_safe_metric_call", _always_fail)
    monkeypatch.setattr(_emitter, "_safe_span", _span_boom)
    emit_parse(trace_id="trace_noraise_1", duration_s=0.1)
    emit_collision(trace_id="trace_noraise_2", resource="stage-3")
    emit_hold(trace_id="trace_noraise_3", resource_id="stage-2")
    emit_reroute(
        trace_id="trace_noraise_4", from_resource="stage-3", to_resource="stage-2"
    )
    emit_error(trace_id="trace_noraise_5", code="500", message="boom")
    assert buffer_depth() == 5
    assert is_observability_delayed() is True


def test_labels_never_carry_trace_id() -> None:
    """E25: trace_id / request_id are never metric labels."""
    reset_for_tests()
    emit_hold(
        trace_id="trace_label_001",
        resource_id="stage-2",
        status="confirmed",
        lot="main",
        production="atlas",
        stage="2",
    )
    for envelope in get_emitted_metrics():
        assert "trace_id" not in envelope["attributes"]
        assert "request_id" not in envelope["attributes"]
        for key in envelope["attributes"]:
            assert key in _emitter.ALLOWED_LABEL_KEYS
    data: Any = _otel.get_metrics_data()
    assert data is not None
    for resource_metrics in data.resource_metrics:
        for scope_metrics in resource_metrics.scope_metrics:
            for metric in scope_metrics.metrics:
                points: Any = getattr(metric.data, "data_points", [])
                for point in points:
                    assert "trace_id" not in dict(point.attributes)
                    assert "request_id" not in dict(point.attributes)


def test_env_example_has_names_only_no_values() -> None:
    """Guard: .env.example carries endpoint/key NAMES, zero secrets."""
    path = _REPO_ROOT / ".env.example"
    assert path.exists(), ".env.example must exist for T-11"
    text = path.read_text()
    assert "GRAFANA_CLOUD_OTLP_ENDPOINT" in text
    assert "GRAFANA_CLOUD_INSTANCE_ID" in text
    assert "GRAFANA_CLOUD_API_KEY" in text
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        assert "=" in stripped, f"non-comment line must be KEY=: {line!r}"
        _, _, value = stripped.partition("=")
        assert value.strip() == "", f".env.example must not contain values: {line!r}"
    lowered = text.lower()
    assert "AIza" not in text
    assert "sk-" not in lowered or "task" in lowered


def test_dashboard_references_exact_instruments() -> None:
    """Cross-check: dashboard queries use EXACTLY the emitter instruments."""
    path = _REPO_ROOT / "infra" / "grafana" / "dashboard.json"
    assert path.exists(), "infra/grafana/dashboard.json must exist"
    dashboard: Any = json.loads(path.read_text())
    assert dashboard.get("title") == "TOWER Radar"
    raw = json.dumps(dashboard)
    for instrument in (
        "tower_slots_total",
        "tower_collisions_total",
        "tower_resolve_duration_seconds",
        "tower_parse_duration_seconds",
        "tower_reroutes_total",
        "tower_errors_total",
    ):
        assert instrument in raw, f"dashboard missing instrument {instrument}"
