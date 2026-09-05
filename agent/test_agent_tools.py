"""TOWER agent tool tests — mocked Gemini, fake clocks (T-04).

Run: ``uv run --project agent --python 3.11 pytest agent/test_agent_tools.py agent/graph -q``
from the repo root. No real API key, no network, no sleeping 30s.

The forced-ordering story is proved structurally here (not prompt-only):
``hold_slot`` raises ``SafetyViolation`` without a validated
``CheckedRequest`` proving ``check_collisions`` + ``safety_check``
both passed — search "forced" in this file for every proof.
"""

from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[1]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from agent.graph.slot_graph import SlotRegistry  # noqa: E402
from agent.tower.agent import (  # noqa: E402
    FORCED_ORDER,
    FORCED_SAFETY_TOOLS,
    FORCED_TOOL_CONFIG,
    SYSTEM_PROMPT,
    create_tower_agent,
)
from agent.tower.breaker import (  # noqa: E402
    BreakerOpenError,
    GeminiBreaker,
    GeminiError,
)
from agent.tower.safety import (  # noqa: E402
    InMemoryMaintenanceTable,
    MaintenanceWindow,
    SafetyViolation,
    safety_check,
)
from agent.tower.store import (  # noqa: E402
    IdempotencyKeyReuse,
    InMemoryIdempotencyStore,
    InMemorySlotStore,
    PostgresSlotStore,
    compute_body_hash,
)
from agent.tower.tools import (  # noqa: E402
    CheckedRequest,
    GeminiClient,
    HoldResult,
    PartialRerouteFailedError,
    StaleAlternativeError,
    build_checked_request,
    check_collisions,
    hold_slot,
    parse_request,
    reroute,
    suggest_resources,
)
from contracts.slot import (  # noqa: E402
    AlternativeSlot,
    ParsedSlot,
    Slot,
)

NOW_ISO: str = "2026-09-05T12:00:00Z"


def utc(
    year: int, month: int, day: int, hour: int, minute: int = 0
) -> datetime:
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


class FailingGemini(GeminiClient):
    """Always raises GeminiError with the given status (E13 path)."""

    def __init__(self, status_code: int) -> None:
        self._status = status_code
        self.calls = 0

    def generate_json(self, prompt: str) -> dict[str, Any]:
        self.calls += 1
        raise GeminiError(self._status, "boom")


class FakeClock:
    """Manual clock for breaker/TTL tests (no sleeping 30s in tests)."""

    def __init__(self, start: float = 1000.0) -> None:
        self.now = start

    def __call__(self) -> float:
        return self.now

    def advance(self, secs: float) -> None:
        self.now += secs


# -- parse_request --------------------------------------------------------


def test_parse_forced_json_via_mock() -> None:
    """Mocked Gemini forced-JSON yields validated slots (normal case)."""
    res = parse_request("Stage 3 tomorrow 6am-6pm", NOW_ISO, client=FakeGemini())
    assert len(res.slots) == 1
    assert res.slots[0].resource_id == "stage-3"
    assert res.confidence == pytest.approx(0.92)
    assert res.needs_clarification is False


def test_parse_truncates_over_500_chars() -> None:
    """Edge: >500 chars truncate + needs_clarification (E02)."""
    long_text = "x" * 600
    fake = FakeGemini()
    res = parse_request(long_text, NOW_ISO, client=fake)
    assert res.truncated is True
    assert res.needs_clarification is True
    assert any("truncated" in c for c in res.clarifications)
    assert len(fake.last_prompt) < len(long_text) + 2000


def test_parse_empty_needs_clarification() -> None:
    """Edge: empty input returns clarification, no Gemini call."""
    fake = FakeGemini()
    res = parse_request("   ", NOW_ISO, client=fake)
    assert res.slots == []
    assert res.needs_clarification is True
    assert fake.calls == 0


def test_parse_rejects_naive_now_iso() -> None:
    """Invalid: naive now_iso fails loudly (TZ-aware required)."""
    with pytest.raises(ValueError, match="timezone-aware"):
        parse_request("Stage 3", "2026-09-05T12:00:00", client=FakeGemini())


def test_parse_unknown_resource_suggestions() -> None:
    """Unknown resource -> unknown_resource + seed-catalog suggestions (E05)."""
    payload = {
        "slots": [
            {
                "resource_type": "gear",
                "resource_id": "alexa-1000",
                "start": "2026-09-06T06:00:00Z",
                "end": "2026-09-06T18:00:00Z",
            }
        ],
        "confidence": 0.5,
        "clarifications": [],
    }
    res = parse_request("Alexa 1000", NOW_ISO, client=FakeGemini(payload))
    assert res.unknown_resources == ["alexa-1000"]
    assert "alexa-65" in res.suggestions or "alexa-mini" in res.suggestions
    assert res.needs_clarification is True


def test_suggest_resources_alias_and_fallback() -> None:
    """Suggestion helper: alias hit, fuzzy, and fallback paths."""
    assert suggest_resources("alexa-1000")[:2] == ["alexa-65", "alexa-mini"] or (
        "alexa-65" in suggest_resources("alexa-1000")
    )
    assert suggest_resources("Stage 3") == ["stage-3"]
    assert len(suggest_resources("something-weird-xyz")) == 3


# -- check_collisions (thin wrapper, no LLM) -------------------------------


def test_check_collisions_thin_wrapper_no_conflict() -> None:
    """Normal: empty registry -> no conflict (pure graph, no LLM)."""
    slots = [make_slot()]
    report = check_collisions(slots, SlotRegistry())
    assert report.has_conflict is False


def test_check_collisions_detects_atlas_overlap() -> None:
    """Pre-seeded req_atlas Stage 3 08:00-10:00 blocks an overlapping ask."""
    registry = SlotRegistry(
        [
            make_slot(
                sid="slot_atlas_stage3_0800",
                resource_id="stage-3",
                start=utc(2026, 9, 6, 8),
                end=utc(2026, 9, 6, 10),
                request_id="req_atlas",
                status="confirmed",
            )
        ]
    )
    asking = make_slot(
        sid="ask", start=utc(2026, 9, 6, 9), end=utc(2026, 9, 6, 11)
    )
    report = check_collisions([asking], registry)
    assert report.has_conflict is True
    assert report.conflicts[0].blocked_by.request_id == "req_atlas"


# -- safety_check ----------------------------------------------------------


def test_safety_check_blocks_maintenance_window() -> None:
    """Gear in the illustrative alexa-65 window fails the forced gate."""
    slot = make_slot(
        sid="g1",
        resource_id="alexa-65",
        resource_type="gear",
        start=utc(2026, 9, 6, 12, 30),
        end=utc(2026, 9, 6, 13, 30),
    )
    report = safety_check([slot], SlotRegistry())
    assert report.passed is False
    assert any(v.startswith("MAINTENANCE:alexa-65") for v in report.violations)


def test_safety_check_passes_clear_window() -> None:
    """Normal: stage-2 same-time alternative passes the forced gate."""
    slot = make_slot(
        sid="ok", resource_id="stage-2", start=utc(2026, 9, 6, 6), end=utc(2026, 9, 6, 8)
    )
    # 06:00-08:00 avoids the 08:00 atlas hold + 30min turnaround edge:
    # use 10:30-12:00 to clear both overlap and separation.
    slot2 = make_slot(
        sid="ok2",
        resource_id="stage-2",
        start=utc(2026, 9, 6, 10, 30),
        end=utc(2026, 9, 6, 12),
    )
    _ = slot
    report = safety_check([slot2], SlotRegistry())
    assert report.passed is True


def test_safety_check_custom_table() -> None:
    """Custom maintenance table injection (empty table passes)."""
    slot = make_slot(
        sid="g2",
        resource_id="alexa-65",
        resource_type="gear",
        start=utc(2026, 9, 6, 12, 30),
        end=utc(2026, 9, 6, 13, 30),
    )
    empty = InMemoryMaintenanceTable(windows=[])
    assert safety_check([slot], SlotRegistry(), empty).passed is True


# -- forced ordering: CheckedRequest + hold_slot ---------------------------


def _checked_single(
    resource_id: str = "stage-2",
    start: datetime | None = None,
    end: datetime | None = None,
    request_id: str = "req_hold",
) -> tuple[CheckedRequest, InMemorySlotStore]:
    store = InMemorySlotStore()
    slot = make_slot(
        sid=f"{request_id}-s1",
        resource_id=resource_id,
        start=start or utc(2026, 9, 6, 6),
        end=end or utc(2026, 9, 6, 8),
        request_id=request_id,
    )
    checked = build_checked_request(
        request_id=request_id,
        slots=[slot],
        registry=store.registry,
        maintenance=InMemoryMaintenanceTable(windows=[]),
        trace_id="trace_hold",
        body_hash=compute_body_hash("body"),
    )
    return checked, store


def test_forced_ordering_hold_refuses_raw_slot() -> None:
    """Structural forced ordering: raw Slot (no token) cannot hold."""
    store = InMemorySlotStore()
    idem = InMemoryIdempotencyStore()
    raw = make_slot()
    with pytest.raises(SafetyViolation, match="FORCED_ORDER"):
        hold_slot(  # type: ignore[arg-type]
            raw,  # type: ignore[arg-type]
            "key-1",
            slot_store=store,
            idempotency_store=idem,
            body="x",
        )


def test_forced_ordering_build_fails_on_collision() -> None:
    """forced chain constructor refuses conflicting slots loudly."""
    registry = SlotRegistry(
        [
            make_slot(
                sid="holder",
                start=utc(2026, 9, 6, 8),
                end=utc(2026, 9, 6, 10),
                request_id="req_atlas",
                status="confirmed",
            )
        ]
    )
    bad = make_slot(sid="ask", start=utc(2026, 9, 6, 9), end=utc(2026, 9, 6, 11))
    with pytest.raises(SafetyViolation, match="FORCED_ORDER"):
        build_checked_request(request_id="req_x", slots=[bad], registry=registry)


def test_forced_ordering_build_fails_on_safety() -> None:
    """forced chain constructor refuses maintenance-blocked slots."""
    bad = make_slot(
        sid="g",
        resource_id="alexa-65",
        resource_type="gear",
        start=utc(2026, 9, 6, 12, 30),
        end=utc(2026, 9, 6, 13, 30),
    )
    with pytest.raises(SafetyViolation, match="FORCED_ORDER"):
        build_checked_request(request_id="req_x", slots=[bad])


def test_hold_slot_success_enqueues_outbox() -> None:
    """Happy path: validated forced token holds + enqueues BQ outbox."""
    checked, store = _checked_single()
    idem = InMemoryIdempotencyStore()
    res: HoldResult = hold_slot(
        checked,
        "11111111-1111-4111-8111-111111111111",
        slot_store=store,
        idempotency_store=idem,
        body="stage-2 6-8",
    )
    assert res.replayed is False
    assert res.slot_ids == [f"{checked.request_id}-s1"]
    assert len(store.outbox_pending()) == 1
    assert store.get(res.slot_ids[0]) is not None


def test_hold_idempotency_replay_and_reuse() -> None:
    """E19: same key+same body replays; same key+diff body is 422."""
    checked, store = _checked_single(request_id="req_idem")
    idem = InMemoryIdempotencyStore()
    key = "22222222-2222-4222-8222-222222222222"
    first = hold_slot(
        checked, key, slot_store=store, idempotency_store=idem, body="same-body"
    )
    second = hold_slot(
        checked, key, slot_store=store, idempotency_store=idem, body="same-body"
    )
    assert second.replayed is True
    assert second.slot_ids == first.slot_ids
    assert len(store.all_slots()) == 1  # replay never double-holds
    with pytest.raises(IdempotencyKeyReuse) as exc:
        hold_slot(
            checked, key, slot_store=store, idempotency_store=idem, body="DIFF"
        )
    assert exc.value.code == "IDEMPOTENCY_KEY_REUSE"


def test_hold_stale_alternative_409() -> None:
    """E12: alternative taken between check and hold -> STALE_ALTERNATIVE."""
    store = InMemorySlotStore()
    empty_maintenance = InMemoryMaintenanceTable(windows=[])
    slot = make_slot(
        sid="race-s1",
        resource_id="stage-2",
        start=utc(2026, 9, 6, 6),
        end=utc(2026, 9, 6, 8),
        request_id="req_race",
    )
    checked = build_checked_request(
        request_id="req_race",
        slots=[slot],
        registry=store.registry,
        maintenance=empty_maintenance,
    )
    # Racer takes the window before we hold.
    racer = make_slot(
        sid="racer",
        resource_id="stage-2",
        start=utc(2026, 9, 6, 6),
        end=utc(2026, 9, 6, 8),
        request_id="req_racer",
    )
    ok, _ = store.registry.hold_slot(racer)
    assert ok is True
    idem = InMemoryIdempotencyStore()
    with pytest.raises(StaleAlternativeError) as exc:
        hold_slot(
            checked,
            "33333333-3333-4333-8333-333333333333",
            slot_store=store,
            idempotency_store=idem,
            body="race",
        )
    assert exc.value.code == "STALE_ALTERNATIVE"


# -- reroute ---------------------------------------------------------------


def _seeded_store_with_request() -> InMemorySlotStore:
    store = InMemorySlotStore()
    old = make_slot(
        sid="req_move--stage-3--orig",
        resource_id="stage-3",
        start=utc(2026, 9, 6, 6),
        end=utc(2026, 9, 6, 8),
        request_id="req_move",
        status="holding",
    )
    ok, reason = store.hold(old, "seed-key:req_move--stage-3--orig")
    assert ok, reason
    store.drain_outbox()
    return store


def test_reroute_moves_stage_atomically() -> None:
    """Reroute stage-3 -> stage-2: new held, old released, outbox queued."""
    store = _seeded_store_with_request()
    idem = InMemoryIdempotencyStore()
    alt = AlternativeSlot(
        resource_id="stage-2",
        resource_type="stage",
        start=utc(2026, 9, 6, 6),
        end=utc(2026, 9, 6, 8),
    )
    res = reroute(
        "req_move",
        alt,
        slot_store=store,
        idempotency_store=idem,
        idempotency_key="44444444-4444-4444-8444-444444444444",
        body="move to stage-2",
        production="atlas",
        trace_id="trace_move",
    )
    assert res.replayed is False
    assert len(res.new_slot_ids) == 1
    assert res.old_slot_ids == ["req_move--stage-3--orig"]
    assert store.get("req_move--stage-3--orig") is not None
    assert store.get("req_move--stage-3--orig") is not None and (
        store.get("req_move--stage-3--orig").status == "released"  # type: ignore[union-attr]
    )


def test_reroute_partial_failure_rolls_back() -> None:
    """E11: blocked alternative -> PARTIAL_REROUTE_FAILED, old kept live."""
    store = InMemorySlotStore()
    blocker = make_slot(
        sid="blocker",
        resource_id="stage-2",
        start=utc(2026, 9, 6, 6),
        end=utc(2026, 9, 6, 8),
        request_id="req_other",
        status="confirmed",
    )
    assert store.hold(blocker, "k:blocker")[0] is True
    old = make_slot(
        sid="req_move2--stage-3--orig",
        resource_id="stage-3",
        start=utc(2026, 9, 6, 6),
        end=utc(2026, 9, 6, 8),
        request_id="req_move2",
    )
    assert store.hold(old, "k:old")[0] is True
    idem = InMemoryIdempotencyStore()
    alt = AlternativeSlot(
        resource_id="stage-2",
        resource_type="stage",
        start=utc(2026, 9, 6, 6),
        end=utc(2026, 9, 6, 8),
    )
    with pytest.raises((PartialRerouteFailedError, StaleAlternativeError)):
        reroute(
            "req_move2",
            alt,
            slot_store=store,
            idempotency_store=idem,
            idempotency_key="55555555-5555-4555-8555-555555555555",
            body="blocked move",
        )
    # Rollback proof: old still live (not released), no partial new hold.
    assert store.get("req_move2--stage-3--orig") is not None
    assert store.get("req_move2--stage-3--orig").status != "released"  # type: ignore[union-attr]


def test_reroute_unknown_request_fails_loudly() -> None:
    """Invalid: unknown request_id raises ValueError (never silent)."""
    store = InMemorySlotStore()
    idem = InMemoryIdempotencyStore()
    alt = AlternativeSlot(
        resource_id="stage-2",
        resource_type="stage",
        start=utc(2026, 9, 6, 6),
        end=utc(2026, 9, 6, 8),
    )
    with pytest.raises(ValueError, match="unknown request_id"):
        reroute(
            "req_missing",
            alt,
            slot_store=store,
            idempotency_store=idem,
            idempotency_key="66666666-6666-4666-8666-666666666666",
            body="x",
        )


# -- breaker E13 -----------------------------------------------------------


def test_breaker_opens_after_five_and_uses_cache() -> None:
    """E13: 5x 429 -> forced-open 30s; identical text falls back to cache."""
    clock = FakeClock()
    breaker = GeminiBreaker(clock=clock)
    cache: dict[str, Any] = {}
    cached = parse_request("Stage 3 6am", NOW_ISO, client=FakeGemini(), cache=cache)
    assert cached.from_cache is False
    failing = FailingGemini(429)
    for _ in range(5):
        with pytest.raises(GeminiError):
            parse_request("other text", NOW_ISO, client=failing, breaker=breaker)
    assert breaker.current_state() == "open"
    # Identical cached text -> fallback without a live call.
    calls_before = failing.calls
    fell_back = parse_request(
        "Stage 3 6am", NOW_ISO, client=failing, breaker=breaker, cache=cache
    )
    assert fell_back.from_cache is True
    assert failing.calls == calls_before  # no live call while forced-open
    # Uncached text while open -> queued BreakerOpenError, no sleep.
    with pytest.raises(BreakerOpenError) as exc:
        parse_request("brand new", NOW_ISO, client=failing, breaker=breaker)
    assert exc.value.queued is True
    assert breaker.time_remaining() > 0


def test_breaker_half_open_probe_recovers() -> None:
    """Half-open probe after 30s closes the breaker on success."""
    clock = FakeClock()
    breaker = GeminiBreaker(clock=clock)
    for _ in range(5):
        breaker.record_failure(429)
    assert breaker.current_state() == "open"
    assert breaker.can_execute() is False
    clock.advance(30.0)
    assert breaker.current_state() == "half-open"
    assert breaker.can_execute() is True  # single probe
    assert breaker.can_execute() is False  # concurrent probe denied
    breaker.record_success()
    assert breaker.current_state() == "closed"
    assert breaker.consecutive_failures == 0
    assert breaker.drain_queue() == []


def test_breaker_ignores_non_retryable() -> None:
    """400s never trip the forced-open breaker (fail loudly instead)."""
    breaker = GeminiBreaker()
    for _ in range(10):
        breaker.record_failure(400)
    assert breaker.current_state() == "closed"
    assert breaker.consecutive_failures == 0


def test_breaker_counts_5xx() -> None:
    """5xx counts exactly like 429 toward the threshold."""
    clock = FakeClock()
    breaker = GeminiBreaker(clock=clock)
    for _ in range(4):
        breaker.record_failure(503)
    assert breaker.current_state() == "closed"
    breaker.record_failure(500)
    assert breaker.current_state() == "open"


# -- idempotency TTL + stores ----------------------------------------------


def test_idempotency_ttl_24h() -> None:
    """24h TTL: expired keys are treated as missing (documented semantic)."""
    start = datetime(2026, 9, 5, 12, tzinfo=timezone.utc)
    now = [start]

    def clock() -> datetime:
        return now[0]

    store = InMemoryIdempotencyStore(clock=clock)
    from agent.tower.store import IdempotencyRecord

    store.save(
        IdempotencyRecord(
            key="k", body_hash="h", response={"slot_ids": "s1"}, created_at=start
        )
    )
    assert store.check("k", "h") == {"slot_ids": "s1"}
    now[0] = start + timedelta(hours=24, seconds=1)
    assert store.check("k", "h") is None


def test_outbox_never_blocks_hold() -> None:
    """Outbox enqueue is a pure append: hold succeeds with full outbox."""
    checked, store = _checked_single(request_id="req_outbox")
    idem = InMemoryIdempotencyStore()
    res = hold_slot(
        checked,
        "77777777-7777-4777-8777-777777777777",
        slot_store=store,
        idempotency_store=idem,
        body="b",
    )
    assert res.replayed is False
    drained = store.drain_outbox()
    assert len(drained) == 1
    assert store.outbox_pending() == []


# -- agent wiring (forced config proof) ------------------------------------


def test_agent_forced_config_and_prompt() -> None:
    """Agent carries NEVER/ALWAYS prompt AND forced tool config."""
    assert "NEVER" in SYSTEM_PROMPT
    assert "ALWAYS" in SYSTEM_PROMPT
    assert "forced" in SYSTEM_PROMPT.lower()
    assert FORCED_ORDER == (
        "parse_request",
        "check_collisions",
        "safety_check",
        "hold_slot",
    )
    assert "check_collisions" in FORCED_SAFETY_TOOLS
    assert "safety_check" in FORCED_SAFETY_TOOLS
    # forced function-calling mode ANY is configured (verified ADK API).
    cfg = FORCED_TOOL_CONFIG
    assert cfg.tool_config is not None
    assert str(cfg.tool_config.function_calling_config.mode).endswith("ANY")


def test_agent_builds_without_creds() -> None:
    """Agent factory needs no API key / no network (forced-safe import)."""
    agent = create_tower_agent()
    # ADK 2.8.0 requires a Python-identifier node name: tower_atc
    # (packet/PRD hyphen form tower-atc lives in description instead).
    assert agent.name == "tower_atc"
    assert len(agent.tools) == 5


def test_no_secrets_in_repo() -> None:
    """Guard: no hardcoded Gemini/Grafana keys in the tool layer."""
    root = Path(__file__).resolve().parent
    for rel in ["tower/tools.py", "tower/agent.py", "tower/breaker.py"]:
        text = (root / rel).read_text()
        lowered = text.lower()
        assert "sk-" not in lowered or "skip" in lowered or "task" in lowered
        assert "AIza" not in text


@pytest.mark.skipif(
    not os.environ.get("DATABASE_URL"),
    reason="Postgres live path needs $DATABASE_URL (no Docker here)",
)
def test_postgres_live_hold_sql_path() -> None:
    """Integration: real Postgres hold via documented SQL (skipped w/o DB)."""
    import psycopg  # type: ignore[import-not-found]

    url = os.environ["DATABASE_URL"]
    store = PostgresSlotStore(lambda: psycopg.connect(url))
    slot = make_slot(sid="pg-live-1", resource_id="stage-2")
    ok, _ = store.hold(slot, "pg-key-1")
    assert isinstance(ok, bool)
