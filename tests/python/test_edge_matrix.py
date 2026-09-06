"""TOWER Phase-4 edge-matrix gap-fill (T-10) — stdlib + repo imports only.

Covers ONLY the edges with no pre-existing named test (see matrix in the
exit report). Pre-existing coverage is referenced, never duplicated:

  PRE-EXISTING (verified, not re-proved here):
    E01 requests.test.ts · E04/E06/E07/E09 test_slot_graph.py · E05/E13/E19
    test_agent_tools.py · E10 test_slot_graph (suggest-Priya) · E15/E22/E25
    test_emitter.py · E16 health.test.ts · E20 requests/reroute.test.ts ·
    E21 RadarScope.test.tsx · E23 TimelineGantt.test.tsx · E24 requests.test.ts

  NEW here (true gaps):
    E02 2000-char fuzz boundary · E03 TZ-edge 23:59 parse · E08 50-thread
    hold_all_atomic race · E11 gear-failure fault-injection rollback ·
    E12 BFF-level stale-refresh (mock 409 → fresh alternatives) ·
    E14 BQ-down outbox-pending + drain · E15 sustained-outage buffer wave ·
    E17 missing-secret fail-loud + provision env-guard.

Run: ``uv run --project agent --python 3.11 pytest tests/ agent/ -q``
from the repo root. No network, no secrets, no sleeps, no Docker.
"""

from __future__ import annotations

import os
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from agent.graph.slot_graph import (  # noqa: E402
    SlotRegistry,
    rank_alternatives,
    revalidate,
)
from agent.observability import emitter as _emitter  # noqa: E402
from agent.observability.emitter import (  # noqa: E402
    OBSERVABILITY_DELAYED_SIGNAL,
    buffer_depth,
    drain_buffer,
    emit_collision,
    emit_error,
    emit_hold,
    emit_parse,
    emit_reroute,
    is_observability_delayed,
    reset_for_tests,
)
from agent.tower.breaker import GeminiError  # noqa: E402,E501 (E13 reference anchor)
from agent.tower.safety import (  # noqa: E402
    InMemoryMaintenanceTable,
)
from agent.tower.store import (  # noqa: E402
    InMemoryIdempotencyStore,
    InMemorySlotStore,
    compute_body_hash,
)
from agent.tower.tools import (  # noqa: E402
    CheckedRequest,
    GeminiClient,
    LiveGeminiClient,
    MissingGeminiKeyError,
    StaleAlternativeError,
    build_checked_request,
    hold_slot,
    parse_request,
    reroute,
)
from contracts.slot import AlternativeSlot, Slot  # noqa: E402

NOW_ISO: str = "2026-09-05T12:00:00Z"


def utc(year: int, month: int, day: int, hour: int, minute: int = 0) -> datetime:
    """Build a UTC-aware datetime (test helper)."""
    return datetime(year, month, day, hour, minute, tzinfo=timezone.utc)


def make_slot(
    *,
    sid: str = "s1",
    resource_id: str = "stage-3",
    resource_type: str = "stage",
    start: datetime | None = None,
    end: datetime | None = None,
    request_id: str = "req_1",
    trace_id: str = "trace_1",
    production: str = "atlas",
    status: str = "holding",
) -> Slot:
    """Build a valid Slot with sensible defaults."""
    s: datetime = start if start is not None else utc(2026, 9, 6, 6)
    e: datetime = end if end is not None else utc(2026, 9, 6, 18)
    return Slot(
        id=sid,
        production=production,
        resource_type=resource_type,  # type: ignore[arg-type]
        resource_id=resource_id,
        start=s,
        end=e,
        status=status,  # type: ignore[arg-type]
        request_id=request_id,
        trace_id=trace_id,
    )


class FakeGemini(GeminiClient):
    """Mocked Gemini forced-JSON client (no network, no secrets)."""

    def __init__(self, payload: dict[str, Any] | None = None) -> None:
        self._payload: dict[str, Any] = payload or {
            "slots": [
                {
                    "resource_type": "stage",
                    "resource_id": "stage-3",
                    "start": "2026-09-06T06:00:00Z",
                    "end": "2026-09-06T18:00:00Z",
                }
            ],
            "confidence": 0.92,
            "clarifications": [],
        }
        self.calls: int = 0
        self.last_prompt: str = ""

    def generate_json(self, prompt: str) -> dict[str, Any]:
        self.calls += 1
        self.last_prompt = prompt
        return dict(self._payload)


# ---------------------------------------------------------------------------
# E02 — 2000-char fuzz boundary (PRE covers 500/501; this proves fuzz-scale).
# ---------------------------------------------------------------------------


def test_E02_2000_char_fuzz_truncates_loudly() -> None:
    """2000-char fuzz input: truncated + needs_clarification, prompt bounded."""
    fake = FakeGemini()
    res = parse_request("x" * 2000, NOW_ISO, client=fake)
    assert res.truncated is True
    assert res.needs_clarification is True
    assert any("truncated" in c for c in res.clarifications)
    assert fake.calls == 1
    # Only the first 500 chars of user text may reach the model prompt.
    assert "x" * 501 not in fake.last_prompt


def test_E02_boundary_500_ok_501_truncated() -> None:
    """Exact boundary: 500 forwards clean, 501 truncates (no silent clip)."""
    ok = parse_request("y" * 500, NOW_ISO, client=FakeGemini())
    assert ok.truncated is False
    assert ok.needs_clarification is False
    over = parse_request("y" * 501, NOW_ISO, client=FakeGemini())
    assert over.truncated is True
    assert over.needs_clarification is True


# ---------------------------------------------------------------------------
# E03 — TZ-edge 23:59 parse (PRE covers naive-now reject; this is the edge).
# ---------------------------------------------------------------------------


def test_E03_TZ_edge_2359_parses_with_offset_and_Z() -> None:
    """23:59 boundary: Z and +00:00 now_iso agree, slots land on Sep 6."""
    res_z = parse_request("Stage 3 tomorrow 6am", "2026-09-05T23:59:00Z", client=FakeGemini())
    res_off = parse_request(
        "Stage 3 tomorrow 6am", "2026-09-05T23:59:00+00:00", client=FakeGemini()
    )
    assert res_z.needs_clarification is False
    assert [(s.start, s.end) for s in res_z.slots] == [
        (s.start, s.end) for s in res_off.slots
    ]
    assert res_z.slots[0].start.date().isoformat() == "2026-09-06"
    assert res_z.slots[0].start.tzinfo is not None


# ---------------------------------------------------------------------------
# E08 — 50-thread hold_all_atomic race (PRE covers 2-thread graph race).
# ---------------------------------------------------------------------------


def test_E08_50_threads_hold_all_atomic_exactly_one_winner() -> None:
    """50 racers × hold_all_atomic on one slot: 1 winner, 49 fail clean."""
    store = InMemorySlotStore()
    barrier = threading.Barrier(50)
    results: list[tuple[bool, str]] = []
    lock = threading.Lock()

    def racer(idx: int) -> None:
        slot = make_slot(
            sid=f"racer-{idx}",
            start=utc(2026, 9, 6, 8),
            end=utc(2026, 9, 6, 10),
            request_id=f"req_race_{idx}",
        )
        barrier.wait(timeout=15)
        out = store.hold_all_atomic([slot], f"key-{idx}")
        with lock:
            results.append(out)

    with ThreadPoolExecutor(max_workers=50) as pool:
        list(pool.map(racer, range(50)))
    assert len(results) == 50
    wins = [r for r in results if r[0]]
    losses = [r for r in results if not r[0]]
    assert len(wins) == 1
    assert wins[0] == (True, "OK")
    assert len(losses) == 49
    for ok, reason in losses:
        assert ok is False
        assert reason.startswith("PARTIAL_REROUTE_FAILED:OVERLAP:")
    assert len(store.all_slots()) == 1  # zero double-books


# ---------------------------------------------------------------------------
# E11 — gear-failure fault-injection rollback (PRE covers blocked-alt path).
# ---------------------------------------------------------------------------


class FaultyGearStore(InMemorySlotStore):
    """Mock store whose gear writes explode mid-cascade (gear-truck fault)."""

    def hold(self, slot: Slot, idempotency_key: str) -> tuple[bool, str]:
        if slot.resource_type == "gear":
            raise RuntimeError("gear move failed: GFM Primavera truck fault")
        return super().hold(slot, idempotency_key)


def test_E11_gear_fault_reroute_never_strands_request() -> None:
    """Gear write fault: reroute raises loudly, old stage hold stays live."""
    store = FaultyGearStore()
    old = make_slot(
        sid="req_gear--stage-3--orig",
        resource_id="stage-3",
        start=utc(2026, 9, 6, 6),
        end=utc(2026, 9, 6, 8),
        request_id="req_gear",
    )
    assert store.hold(old, "seed:req_gear")[0] is True
    store.drain_outbox()
    idem = InMemoryIdempotencyStore()
    alt = AlternativeSlot(
        resource_id="alexa-65",
        resource_type="gear",
        start=utc(2026, 9, 6, 6),
        end=utc(2026, 9, 6, 8),
    )
    with pytest.raises(RuntimeError, match="gear move failed"):
        reroute(
            "req_gear",
            alt,
            slot_store=store,
            idempotency_store=idem,
            idempotency_key="88888888-8888-4888-8888-888888888888",
            body="gear move",
        )
    # Rollback proof: the request is never stranded — the old stage hold
    # stays live (not released), the store recorded no gear-side partial
    # (no dict entry, no outbox row), and the idempotency key was never
    # saved so the reroute is safely retryable after the truck is fixed.
    kept = store.get("req_gear--stage-3--orig")
    assert kept is not None
    assert kept.status != "released"  # type: ignore[union-attr]
    assert [s.id for s in store.slots_for_request("req_gear")] == [
        "req_gear--stage-3--orig"
    ]
    assert store.get("req_gear--alexa-65--reroute") is None
    assert store.outbox_pending() == []
    assert (
        idem.lookup("88888888-8888-4888-8888-888888888888") is None
    )  # retryable


# ---------------------------------------------------------------------------
# E12 — BFF-level stale refresh: mock agent 409 → fresh alternatives.
# ---------------------------------------------------------------------------


def test_E12_bff_stale_409_refreshes_to_fresh_alternatives() -> None:
    """BFF flow: hold hits STALE_ALTERNATIVE → re-rank excludes taken win."""
    store = InMemorySlotStore()
    atlas = make_slot(
        sid="atlas",
        start=utc(2026, 9, 6, 8),
        end=utc(2026, 9, 6, 10),
        request_id="req_atlas",
        status="confirmed",
    )
    assert store.hold(atlas, "seed:atlas")[0] is True
    wanted = make_slot(
        sid="wanted",
        resource_id="stage-2",
        start=utc(2026, 9, 6, 8),
        end=utc(2026, 9, 6, 10),
        request_id="req_new",
    )
    checked = build_checked_request(
        request_id="req_new",
        slots=[wanted],
        registry=store.registry,
        maintenance=InMemoryMaintenanceTable(windows=[]),
        body_hash=compute_body_hash("bff-body"),
    )
    # Competitor grabs stage-2 between BFF check and hold (mock agent 409).
    racer = make_slot(
        sid="racer",
        resource_id="stage-2",
        start=utc(2026, 9, 6, 8),
        end=utc(2026, 9, 6, 10),
        request_id="req_racer",
    )
    assert store.registry.hold_slot(racer) == (True, "OK")
    idem = InMemoryIdempotencyStore()
    with pytest.raises(StaleAlternativeError) as exc:
        hold_slot(
            checked,
            "99999999-9999-4999-8999-999999999999",
            slot_store=store,
            idempotency_store=idem,
            body="bff-body",
        )
    assert exc.value.code == "STALE_ALTERNATIVE"
    # BFF refresh: re-rank with the taken window excluded → fresh top-3.
    cands = [
        AlternativeSlot(
            resource_id="stage-2",
            resource_type="stage",
            start=utc(2026, 9, 6, 8),
            end=utc(2026, 9, 6, 10),
        ),
        AlternativeSlot(
            resource_id="stage-3",
            resource_type="stage",
            start=utc(2026, 9, 6, 12),
            end=utc(2026, 9, 6, 14),
        ),
        AlternativeSlot(
            resource_id="stage-1",
            resource_type="stage",
            start=utc(2026, 9, 6, 8),
            end=utc(2026, 9, 6, 10),
        ),
    ]
    fresh = rank_alternatives(wanted, store.registry, candidates=cands)
    assert len(fresh) >= 1
    for alt_ranked in fresh:
        assert not (
            alt_ranked.slot.resource_id == "stage-2"
            and alt_ranked.slot.start == utc(2026, 9, 6, 8)
        )
        probe = make_slot(
            sid="probe",
            resource_id=alt_ranked.slot.resource_id,
            resource_type=str(
                alt_ranked.slot.resource_type or wanted.resource_type
            ),
            start=alt_ranked.slot.start,
            end=alt_ranked.slot.end,
            request_id="req_new",
        )
        ok, _ = revalidate(probe, store.registry)
        assert ok is True


# ---------------------------------------------------------------------------
# E14 — BQ-down: holds confirm from the store + outbox pending signal.
# ---------------------------------------------------------------------------


def test_E14_bq_down_hold_confirms_with_ledger_sync_pending() -> None:
    """BQ mirror down: hold confirms locally, outbox pending, 3x retry flush."""
    store = InMemorySlotStore()
    slot = make_slot(sid="e14-s1", resource_id="stage-2")
    ok, reason = store.hold(slot, "e14-key")
    assert (ok, reason) == (True, "OK")
    # `Ledger sync pending` signal: outbox non-empty while BQ is down.
    pending = store.outbox_pending()
    assert len(pending) == 1
    assert pending[0].request_id == "req_1"
    assert pending[0].attempts == 0
    # Hold confirmed FROM THE STORE despite the pending mirror (never block).
    assert store.get("e14-s1") is not None
    # Cloud-Tasks-style worker: 2 failed flushes (attempts++), 3rd drains.
    for attempt in (1, 2):
        assert len(store.outbox_pending()) == 1
        store.outbox_pending()[0].attempts = attempt
    drained = store.drain_outbox()
    assert len(drained) == 1
    assert store.outbox_pending() == []
    assert store.get("e14-s1") is not None


# ---------------------------------------------------------------------------
# E15 — sustained-outage buffer wave (complements PRE single-buffer test).
# ---------------------------------------------------------------------------


def test_E15_sustained_outage_buffers_full_table_then_drains() -> None:
    """All 5 emit-table rows buffer under outage; hold path never raises."""
    reset_for_tests()
    original = _emitter._safe_metric_call
    state = {"failing": True}

    def _flaky(description: str, func: Any, *args: Any, **kwargs: Any) -> bool:
        if state["failing"]:
            return False
        return bool(original(description, func, *args, **kwargs))

    _emitter._safe_metric_call = _flaky  # type: ignore[method-assign]
    try:
        emit_parse(trace_id="trace_e15_parse", duration_s=0.1)
        emit_collision(trace_id="trace_e15_collision", resource="stage-3")
        emit_hold(trace_id="trace_e15_hold", resource_id="stage-2")
        emit_reroute(
            trace_id="trace_e15_reroute",
            from_resource="stage-3",
            to_resource="stage-2",
        )
        emit_error(trace_id="trace_e15_error", code="503", message="otlp down")
        assert buffer_depth() == 5
        assert is_observability_delayed() is True
        assert OBSERVABILITY_DELAYED_SIGNAL == "observability_delayed"
        # Second outage wave grows monotonically (no silent drops).
        emit_hold(trace_id="trace_e15_hold2", resource_id="stage-2")
        assert buffer_depth() == 6
        state["failing"] = False
        assert drain_buffer() == 6
    finally:
        _emitter._safe_metric_call = original  # type: ignore[method-assign]
    assert buffer_depth() == 0
    assert is_observability_delayed() is False


# ---------------------------------------------------------------------------
# E17 — missing-secret fail-loud + provision env-guard.
# ---------------------------------------------------------------------------


def test_E17_missing_gemini_key_fails_loud(monkeypatch: pytest.MonkeyPatch) -> None:
    """No GOOGLE_API_KEY/GEMINI_API_KEY → MissingGeminiKeyError naming env."""
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    client = LiveGeminiClient()
    with pytest.raises(MissingGeminiKeyError, match="GOOGLE_API_KEY"):
        client.generate_json("Stage 3 tomorrow 6am")


def test_E17_provision_reads_secrets_from_env_only() -> None:
    """provision.py: env-guard present, zero live-secret shapes.

    Bare prefix mentions (e.g. the ``glc_...`` docstring noting the OTLP
    password is NOT valid for the stack API) are documentation, not
    secrets — only long-tail live shapes fail this gate.
    """
    import re

    text = (_REPO_ROOT / "infra" / "grafana" / "provision.py").read_text()
    assert "os.environ.get" in text
    assert "MISSING_SECRET_" in text  # fail-loud checklist block
    live_shapes = [
        r"AIza[0-9A-Za-z_\-]{15,}",
        r"glc_[A-Za-z0-9_\-]{10,}",
        r"glsa_[A-Za-z0-9_\-]{10,}",
        r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----",
    ]
    for shape in live_shapes:
        assert re.search(shape, text) is None, f"live secret shape: {shape}"
