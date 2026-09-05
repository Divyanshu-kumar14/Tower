"""TOWER Slot Graph tests — E04, E06–E12 + normal/edge/invalid (T-03).

Run: ``uv run --python 3.11 --with pytest pytest agent/graph -v``
from repo root, or ``pytest graph -v`` from ``agent/``.
"""

from __future__ import annotations

import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from pydantic import ValidationError

_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from contracts.slot import AlternativeSlot, ResourceType, Slot, SlotStatus

from .slot_graph import (
    CollisionReport,
    Conflict,
    RankedAlternative,
    SlotConflictError,
    SlotRegistry,
    canPlace,
    can_place,
    check_collisions,
    hold_cascade,
    hold_slot,
    merge_self_overlaps,
    rank_alternatives,
    required_gap,
    revalidate,
    slots_overlap,
    split_overnight,
    validate_interval,
)


def utc(
    year: int, month: int, day: int, hour: int, minute: int = 0
) -> datetime:
    """Build a UTC-aware datetime (test helper)."""
    return datetime(year, month, day, hour, minute, tzinfo=timezone.utc)


def make_slot(
    *,
    sid: str = "s1",
    production: str = "atlas",
    resource_type: ResourceType = "stage",
    resource_id: str = "stage-3",
    start: datetime | None = None,
    end: datetime | None = None,
    status: SlotStatus = "holding",
    request_id: str = "req_1",
    trace_id: str = "trace_1",
) -> Slot:
    """Build a valid Slot with sensible defaults (test helper)."""
    s: datetime = start if start is not None else utc(2026, 9, 6, 6)
    e: datetime = end if end is not None else utc(2026, 9, 6, 18)
    return Slot(
        id=sid,
        production=production,
        resource_type=resource_type,
        resource_id=resource_id,
        start=s,
        end=e,
        status=status,
        request_id=request_id,
        trace_id=trace_id,
    )


# ---------------------------------------------------------------------------
# Overlap rule + canPlace basics (normal / edge / invalid).
# ---------------------------------------------------------------------------


def test_overlap_rule_basic() -> None:
    assert slots_overlap(utc(2026, 9, 6, 8), utc(2026, 9, 6, 10), utc(2026, 9, 6, 9), utc(2026, 9, 6, 11))
    assert not slots_overlap(
        utc(2026, 9, 6, 8), utc(2026, 9, 6, 10), utc(2026, 9, 6, 10), utc(2026, 9, 6, 12)
    )


def test_overlap_touching_is_not_overlap_but_separation_may_block() -> None:
    reg = SlotRegistry(
        [make_slot(sid="a", start=utc(2026, 9, 6, 8), end=utc(2026, 9, 6, 10))]
    )
    touching = make_slot(sid="b", start=utc(2026, 9, 6, 10), end=utc(2026, 9, 6, 12))
    assert not slots_overlap(
        utc(2026, 9, 6, 8), utc(2026, 9, 6, 10), utc(2026, 9, 6, 10), utc(2026, 9, 6, 12)
    )
    ok, reason = canPlace(touching, reg)
    assert not ok
    assert reason == "SEPARATION_VIOLATION"


def test_canPlace_ok_on_empty_registry() -> None:
    s = make_slot()
    ok, reason = canPlace(s, SlotRegistry())
    assert (ok, reason) == (True, "OK")
    ok2, reason2 = canPlace(s, None)
    assert (ok2, reason2) == (True, "OK")
    ok3, reason3 = can_place(s, SlotRegistry())
    assert (ok3, reason3) == (True, "OK")


def test_canPlace_invalid_interval_via_construct() -> None:
    bad = Slot.model_construct(
        id="bad",
        production="atlas",
        resource_type="stage",
        resource_id="stage-3",
        start=utc(2026, 9, 6, 10),
        end=utc(2026, 9, 6, 10),
        status="holding",
        request_id="req_1",
        trace_id="trace_1",
    )
    ok, reason = canPlace(bad, SlotRegistry())
    assert not ok
    assert reason == "INVALID_INTERVAL"


def test_registry_keeps_start_sorted_order() -> None:
    reg = SlotRegistry()
    # Insert out of order with wide gaps so separation passes.
    s3 = make_slot(sid="c", start=utc(2026, 9, 6, 14), end=utc(2026, 9, 6, 15))
    s1 = make_slot(sid="a", start=utc(2026, 9, 6, 6), end=utc(2026, 9, 6, 7))
    s2 = make_slot(sid="b", start=utc(2026, 9, 6, 10), end=utc(2026, 9, 6, 11))
    for s in (s3, s1, s2):
        assert reg.hold_slot(s) == (True, "OK")
    ids = [s.id for s in reg.slots_for("stage-3")]
    assert ids == ["a", "b", "c"]
    assert len(reg) == 3


def test_released_slots_do_not_block() -> None:
    reg = SlotRegistry(
        [
            make_slot(
                sid="old",
                start=utc(2026, 9, 6, 8),
                end=utc(2026, 9, 6, 10),
                status="released",
            )
        ]
    )
    # Same window would overlap a live hold, but released is audit-only.
    probe = make_slot(sid="new", start=utc(2026, 9, 6, 8), end=utc(2026, 9, 6, 10))
    ok, reason = canPlace(probe, reg)
    assert (ok, reason) == (True, "OK")


# ---------------------------------------------------------------------------
# E04 — self-collision merge.
# ---------------------------------------------------------------------------


def test_E04_same_request_overlap_merges() -> None:
    a = make_slot(
        sid="a", start=utc(2026, 9, 6, 6), end=utc(2026, 9, 6, 10), request_id="req_1"
    )
    b = make_slot(
        sid="b", start=utc(2026, 9, 6, 9), end=utc(2026, 9, 6, 18), request_id="req_1"
    )
    merged, did = merge_self_overlaps([a, b])
    assert did is True
    assert len(merged) == 1
    assert merged[0].start == utc(2026, 9, 6, 6)
    assert merged[0].end == utc(2026, 9, 6, 18)
    report = check_collisions([a, b])
    assert report.self_overlap_merged is True
    assert report.has_conflict is False
    assert len(report.merged_slots) == 1


def test_E04_touching_same_request_merges_contiguous() -> None:
    a = make_slot(
        sid="a", start=utc(2026, 9, 6, 6), end=utc(2026, 9, 6, 10), request_id="req_1"
    )
    b = make_slot(
        sid="b", start=utc(2026, 9, 6, 10), end=utc(2026, 9, 6, 12), request_id="req_1"
    )
    merged, did = merge_self_overlaps([a, b])
    assert did is True
    assert len(merged) == 1
    assert merged[0].end == utc(2026, 9, 6, 12)


def test_E04_different_resources_do_not_merge() -> None:
    a = make_slot(sid="a", resource_id="stage-3", request_id="req_1")
    b = make_slot(
        sid="b",
        resource_id="alexa-65",
        resource_type="gear",
        request_id="req_1",
        start=utc(2026, 9, 6, 6),
        end=utc(2026, 9, 6, 18),
    )
    merged, did = merge_self_overlaps([a, b])
    assert did is False
    assert len(merged) == 2


def test_E04_different_requests_overlap_is_conflict_not_merge() -> None:
    a = make_slot(
        sid="a", start=utc(2026, 9, 6, 8), end=utc(2026, 9, 6, 10), request_id="req_1"
    )
    b = make_slot(
        sid="b", start=utc(2026, 9, 6, 9), end=utc(2026, 9, 6, 11), request_id="req_2"
    )
    report = check_collisions([a, b])
    assert report.self_overlap_merged is False
    assert report.has_conflict is True
    assert len(report.conflicts) == 1
    c: Conflict = report.conflicts[0]
    assert c.reason.startswith("OVERLAP:")
    assert c.blocked_by.id == "a"
    assert c.requested.id == "b"


def test_E04_empty_and_singleton() -> None:
    merged, did = merge_self_overlaps([])
    assert (merged, did) == ([], False)
    one = make_slot()
    merged1, did1 = merge_self_overlaps([one])
    assert did1 is False
    assert len(merged1) == 1


# ---------------------------------------------------------------------------
# E06 — zero-duration / end <= start.
# ---------------------------------------------------------------------------


def test_E06_zero_duration_rejected_by_contract() -> None:
    with pytest.raises(ValidationError) as exc:
        make_slot(start=utc(2026, 9, 6, 10), end=utc(2026, 9, 6, 10))
    assert "INVALID_INTERVAL" in str(exc.value)


def test_E06_end_before_start_rejected_by_contract() -> None:
    with pytest.raises(ValidationError) as exc2:
        make_slot(start=utc(2026, 9, 6, 11), end=utc(2026, 9, 6, 10))
    assert "INVALID_INTERVAL" in str(exc2.value)


def test_E06_validate_interval_helper() -> None:
    validate_interval(utc(2026, 9, 6, 8), utc(2026, 9, 6, 10))
    with pytest.raises(ValueError, match="INVALID_INTERVAL"):
        validate_interval(utc(2026, 9, 6, 10), utc(2026, 9, 6, 10))
    with pytest.raises(ValueError, match="INVALID_INTERVAL"):
        validate_interval(utc(2026, 9, 6, 11), utc(2026, 9, 6, 10))


def test_E06_merge_and_split_reject_invalid() -> None:
    bad = Slot.model_construct(
        id="bad",
        production="p",
        resource_type="stage",
        resource_id="stage-3",
        start=utc(2026, 9, 6, 10),
        end=utc(2026, 9, 6, 10),
        status="holding",
        request_id="r",
        trace_id="t",
    )
    with pytest.raises(ValueError, match="INVALID_INTERVAL"):
        merge_self_overlaps([bad])
    with pytest.raises(ValueError, match="INVALID_INTERVAL"):
        split_overnight(bad)


# ---------------------------------------------------------------------------
# E07 — overnight split.
# ---------------------------------------------------------------------------


def test_E07_overnight_22_to_06_splits_into_two() -> None:
    night = make_slot(
        sid="night",
        start=utc(2026, 9, 6, 22),
        end=utc(2026, 9, 7, 6),
    )
    parts = split_overnight(night)
    assert len(parts) == 2
    assert parts[0].start == utc(2026, 9, 6, 22)
    assert parts[0].end == utc(2026, 9, 7, 0)
    assert parts[1].start == utc(2026, 9, 7, 0)
    assert parts[1].end == utc(2026, 9, 7, 6)
    assert parts[0].request_id == night.request_id
    assert parts[1].resource_id == night.resource_id
    assert parts[0].id != parts[1].id


def test_E07_same_day_returns_singleton() -> None:
    day = make_slot(start=utc(2026, 9, 6, 6), end=utc(2026, 9, 6, 18))
    parts = split_overnight(day)
    assert len(parts) == 1
    assert parts[0].id == day.id


def test_E07_split_parts_cover_full_span_without_gap() -> None:
    night = make_slot(
        sid="n", start=utc(2026, 9, 6, 22), end=utc(2026, 9, 7, 6)
    )
    parts = split_overnight(night)
    assert parts[0].start == night.start
    assert parts[-1].end == night.end
    for first, second in zip(parts, parts[1:]):
        assert first.end == second.start


# ---------------------------------------------------------------------------
# E08 — concurrent-hold serialization at graph level.
# ---------------------------------------------------------------------------


def test_E08_double_hold_second_fails_409_like() -> None:
    reg = SlotRegistry()
    first = make_slot(
        sid="first", start=utc(2026, 9, 6, 8), end=utc(2026, 9, 6, 10)
    )
    second = make_slot(
        sid="second",
        start=utc(2026, 9, 6, 9),
        end=utc(2026, 9, 6, 11),
        request_id="req_2",
    )
    assert hold_slot(first, reg) == (True, "OK")
    ok, reason = hold_slot(second, reg)
    assert not ok
    assert reason == "OVERLAP:first"
    assert len(reg) == 1
    with pytest.raises(SlotConflictError):
        reg.add(second)


def test_E08_concurrent_threads_exactly_one_wins() -> None:
    reg = SlotRegistry()
    barrier = threading.Barrier(2)
    results: list[tuple[bool, str]] = []

    def racer(idx: int) -> None:
        s = make_slot(
            sid=f"racer-{idx}",
            start=utc(2026, 9, 6, 8),
            end=utc(2026, 9, 6, 10),
            request_id=f"req_{idx}",
        )
        barrier.wait(timeout=5)
        results.append(reg.hold_slot(s))

    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(racer, [1, 2]))
    assert len(results) == 2
    wins = [r for r in results if r[0]]
    losses = [r for r in results if not r[0]]
    assert len(wins) == 1
    assert wins[0] == (True, "OK")
    assert len(losses) == 1
    assert losses[0][1].startswith("OVERLAP:")
    assert len(reg) == 1


def test_E08_different_resources_do_not_conflict() -> None:
    reg = SlotRegistry(
        [make_slot(sid="stage", start=utc(2026, 9, 6, 8), end=utc(2026, 9, 6, 10))]
    )
    gear = make_slot(
        sid="gear",
        resource_type="gear",
        resource_id="alexa-65",
        start=utc(2026, 9, 6, 8),
        end=utc(2026, 9, 6, 10),
    )
    ok, reason = canPlace(gear, reg)
    assert (ok, reason) == (True, "OK")


# ---------------------------------------------------------------------------
# E09 — separation minima.
# ---------------------------------------------------------------------------


def test_E09_stage_5min_gap_rejected() -> None:
    reg = SlotRegistry(
        [make_slot(sid="a", start=utc(2026, 9, 6, 8), end=utc(2026, 9, 6, 10))]
    )
    tight = make_slot(sid="b", start=utc(2026, 9, 6, 10, 5), end=utc(2026, 9, 6, 11))
    ok, reason = canPlace(tight, reg)
    assert not ok
    assert reason == "SEPARATION_VIOLATION"


def test_E09_stage_exact_30min_gap_ok() -> None:
    reg = SlotRegistry(
        [make_slot(sid="a", start=utc(2026, 9, 6, 8), end=utc(2026, 9, 6, 10))]
    )
    ok_slot = make_slot(
        sid="b", start=utc(2026, 9, 6, 10, 30), end=utc(2026, 9, 6, 12)
    )
    ok, reason = canPlace(ok_slot, reg)
    assert (ok, reason) == (True, "OK")


def test_E09_stage_gap_before_existing_enforced() -> None:
    reg = SlotRegistry(
        [make_slot(sid="a", start=utc(2026, 9, 6, 10), end=utc(2026, 9, 6, 12))]
    )
    early = make_slot(sid="b", start=utc(2026, 9, 6, 8), end=utc(2026, 9, 6, 9, 45))
    ok, reason = canPlace(early, reg)
    assert not ok
    assert reason == "SEPARATION_VIOLATION"


def test_E09_gear_15min_swap() -> None:
    reg = SlotRegistry(
        [
            make_slot(
                sid="g1",
                resource_type="gear",
                resource_id="alexa-65",
                start=utc(2026, 9, 6, 8),
                end=utc(2026, 9, 6, 10),
            )
        ]
    )
    tight = make_slot(
        sid="g2",
        resource_type="gear",
        resource_id="alexa-65",
        start=utc(2026, 9, 6, 10, 10),
        end=utc(2026, 9, 6, 11),
    )
    ok, reason = canPlace(tight, reg)
    assert not ok
    assert reason == "SEPARATION_VIOLATION"
    loose = make_slot(
        sid="g3",
        resource_type="gear",
        resource_id="alexa-65",
        start=utc(2026, 9, 6, 10, 15),
        end=utc(2026, 9, 6, 11),
    )
    ok2, _ = canPlace(loose, reg)
    assert ok2


def test_E09_required_gap_values() -> None:
    assert required_gap("stage") == timedelta(minutes=30)
    assert required_gap("gear") == timedelta(minutes=15)
    assert required_gap("crew") == timedelta(hours=11)
    with pytest.raises(ValueError):
        required_gap("drone")


# ---------------------------------------------------------------------------
# E10 — crew rest + alternative suggestion.
# ---------------------------------------------------------------------------


def test_E10_crew_11h_rest_violation() -> None:
    reg = SlotRegistry(
        [
            make_slot(
                sid="maya-night",
                resource_type="crew",
                resource_id="crew-maya",
                start=utc(2026, 9, 6, 22),
                end=utc(2026, 9, 7, 6),
                request_id="req_night",
            )
        ]
    )
    early = make_slot(
        sid="maya-morning",
        resource_type="crew",
        resource_id="crew-maya",
        start=utc(2026, 9, 7, 8),
        end=utc(2026, 9, 7, 10),
        request_id="req_new",
    )
    ok, reason = canPlace(early, reg)
    assert not ok
    assert reason == "CREW_REST_VIOLATION"


def test_E10_crew_exact_11h_gap_ok() -> None:
    reg = SlotRegistry(
        [
            make_slot(
                sid="m1",
                resource_type="crew",
                resource_id="crew-maya",
                start=utc(2026, 9, 6, 22),
                end=utc(2026, 9, 7, 6),
                request_id="req_night",
            )
        ]
    )
    rested = make_slot(
        sid="m2",
        resource_type="crew",
        resource_id="crew-maya",
        start=utc(2026, 9, 7, 17),
        end=utc(2026, 9, 7, 19),
        request_id="req_new",
    )
    ok, reason = canPlace(rested, reg)
    assert (ok, reason) == (True, "OK")


def test_E10_suggest_priya_when_maya_blocked() -> None:
    reg = SlotRegistry(
        [
            make_slot(
                sid="maya-night",
                resource_type="crew",
                resource_id="crew-maya",
                start=utc(2026, 9, 6, 22),
                end=utc(2026, 9, 7, 6),
                request_id="req_night",
            )
        ]
    )
    requested = make_slot(
        sid="wanted",
        resource_type="crew",
        resource_id="crew-maya",
        start=utc(2026, 9, 7, 8),
        end=utc(2026, 9, 7, 10),
        request_id="req_new",
    )
    report = check_collisions([requested], reg)
    assert report.has_conflict is True
    conflict: Conflict = report.conflicts[0]
    assert conflict.reason == "CREW_REST_VIOLATION"
    priya = AlternativeSlot(
        resource_id="crew-priya",
        resource_type="crew",
        start=utc(2026, 9, 7, 8),
        end=utc(2026, 9, 7, 10),
    )
    maya_later = AlternativeSlot(
        resource_id="crew-maya",
        resource_type="crew",
        start=utc(2026, 9, 7, 17),
        end=utc(2026, 9, 7, 19),
    )
    top = rank_alternatives(conflict, reg, candidates=[priya, maya_later])
    assert len(top) == 2
    # Same-time Priya beats 9h-shifted Maya (min time delta wins).
    assert top[0].slot.resource_id == "crew-priya"
    assert 0.0 <= top[0].score <= 1.0
    assert top[0].reason != ""


def test_E10_crew_availability_filter() -> None:
    reg = SlotRegistry()
    requested = make_slot(
        sid="w",
        resource_type="crew",
        resource_id="crew-maya",
        start=utc(2026, 9, 7, 8),
        end=utc(2026, 9, 7, 10),
        request_id="req_new",
    )
    conflict = Conflict(
        resource_id="crew-maya",
        resource_type="crew",
        requested=requested,
        blocked_by=requested,
        overlap_start=requested.start,
        overlap_end=requested.end,
        reason="CREW_REST_VIOLATION",
    )
    priya = AlternativeSlot(
        resource_id="crew-priya",
        resource_type="crew",
        start=utc(2026, 9, 7, 8),
        end=utc(2026, 9, 7, 10),
    )
    top = rank_alternatives(
        conflict, reg, candidates=[priya], crew_availability={"crew-priya": False}
    )
    assert top == []


# ---------------------------------------------------------------------------
# E11 — cascade atomicity.
# ---------------------------------------------------------------------------


def test_E11_cascade_success_holds_all() -> None:
    reg = SlotRegistry()
    stage = make_slot(sid="st", start=utc(2026, 9, 6, 6), end=utc(2026, 9, 6, 18))
    gear = make_slot(
        sid="g",
        resource_type="gear",
        resource_id="alexa-65",
        start=utc(2026, 9, 6, 6),
        end=utc(2026, 9, 6, 18),
    )
    ok, reason = hold_cascade([stage, gear], reg)
    assert (ok, reason) == (True, "OK")
    assert len(reg) == 2


def test_E11_cascade_failure_rolls_back_no_partial() -> None:
    reg = SlotRegistry(
        [
            make_slot(
                sid="taken",
                resource_type="gear",
                resource_id="alexa-65",
                start=utc(2026, 9, 6, 8),
                end=utc(2026, 9, 6, 10),
                request_id="req_atlas",
            )
        ]
    )
    stage = make_slot(sid="st", start=utc(2026, 9, 6, 6), end=utc(2026, 9, 6, 18))
    gear_clash = make_slot(
        sid="g2",
        resource_type="gear",
        resource_id="alexa-65",
        start=utc(2026, 9, 6, 9),
        end=utc(2026, 9, 6, 11),
        request_id="req_new",
    )
    ok, reason = hold_cascade([stage, gear_clash], reg)
    assert not ok
    assert reason.startswith("PARTIAL_REROUTE_FAILED:")
    # Rollback: stage must NOT be held (registry unchanged apart from seed).
    assert len(reg) == 1
    assert reg.slots_for("stage-3") == []


def test_E11_cascade_empty_noop() -> None:
    reg = SlotRegistry()
    ok, reason = hold_cascade([], reg)
    assert (ok, reason) == (True, "OK")
    assert len(reg) == 0


def test_E11_method_and_function_agree() -> None:
    reg1 = SlotRegistry()
    reg2 = SlotRegistry()
    batch = [make_slot(sid="a"), make_slot(sid="b", resource_id="stage-2")]
    # Batch has same request/resource overlap? No — different resources,
    # but same time is fine across resources. Widen: same resource overlap
    # to force failure in both paths.
    clash = [
        make_slot(sid="x", start=utc(2026, 9, 6, 8), end=utc(2026, 9, 6, 10)),
        make_slot(
            sid="y",
            start=utc(2026, 9, 6, 9),
            end=utc(2026, 9, 6, 11),
            request_id="req_other",
        ),
    ]
    assert batch[0].resource_id != batch[1].resource_id
    ok1, _ = reg1.hold_all_atomic(clash)
    ok2, _ = hold_cascade(clash, reg2)
    assert ok1 == ok2 is False
    assert len(reg1) == 0
    assert len(reg2) == 0


# ---------------------------------------------------------------------------
# E12 — stale-alternative re-check.
# ---------------------------------------------------------------------------


def test_E12_stale_alternative_detected_before_hold() -> None:
    reg = SlotRegistry(
        [make_slot(sid="atlas", start=utc(2026, 9, 6, 8), end=utc(2026, 9, 6, 10), request_id="req_atlas")]
    )
    requested = make_slot(
        sid="wanted",
        start=utc(2026, 9, 6, 8),
        end=utc(2026, 9, 6, 10),
        request_id="req_new",
    )
    report = check_collisions([requested], reg)
    assert report.has_conflict is True
    alt_slot = make_slot(
        sid="alt-stage2",
        resource_id="stage-2",
        start=utc(2026, 9, 6, 8),
        end=utc(2026, 9, 6, 10),
        request_id="req_new",
    )
    # Fresh alternative validates OK.
    ok, _ = revalidate(alt_slot, reg)
    assert ok is True
    # Competitor takes it between check and hold.
    winner = make_slot(
        sid="competitor",
        resource_id="stage-2",
        start=utc(2026, 9, 6, 8),
        end=utc(2026, 9, 6, 10),
        request_id="req_racer",
    )
    assert reg.hold_slot(winner) == (True, "OK")
    # Pre-hold re-check now fails -> caller maps to 409 STALE_ALTERNATIVE.
    ok2, reason2 = revalidate(alt_slot, reg)
    assert not ok2
    assert reason2.startswith("OVERLAP:")
    ok3, reason3 = hold_slot(alt_slot, reg)
    assert not ok3
    assert reason3.startswith("OVERLAP:")


def test_E12_revalidate_ok_when_still_free() -> None:
    reg = SlotRegistry()
    alt = make_slot(sid="alt", resource_id="stage-2")
    ok, reason = revalidate(alt, reg)
    assert (ok, reason) == (True, "OK")


# ---------------------------------------------------------------------------
# rank_alternatives scoring: spec match, time delta, top-3.
# ---------------------------------------------------------------------------


def test_rank_prefers_spec_match_same_time() -> None:
    reg = SlotRegistry(
        [make_slot(sid="atlas", start=utc(2026, 9, 6, 8), end=utc(2026, 9, 6, 10), request_id="req_atlas")]
    )
    requested = make_slot(
        sid="wanted",
        start=utc(2026, 9, 6, 8),
        end=utc(2026, 9, 6, 10),
        request_id="req_new",
    )
    report = check_collisions([requested], reg)
    conflict = report.conflicts[0]
    same_specs = AlternativeSlot(
        resource_id="stage-2",
        resource_type="stage",
        start=utc(2026, 9, 6, 8),
        end=utc(2026, 9, 6, 10),
    )
    later_same = AlternativeSlot(
        resource_id="stage-3",
        resource_type="stage",
        start=utc(2026, 9, 6, 12),
        end=utc(2026, 9, 6, 14),
    )
    top = rank_alternatives(conflict, reg, candidates=[later_same, same_specs])
    assert len(top) == 2
    assert top[0].slot.resource_id == "stage-2"
    assert top[0].score >= top[1].score
    assert "same specs" in top[0].reason


def test_rank_top3_limit_and_viability_filter() -> None:
    reg = SlotRegistry(
        [make_slot(sid="a", start=utc(2026, 9, 6, 8), end=utc(2026, 9, 6, 10), request_id="req_atlas")]
    )
    requested = make_slot(
        sid="w", start=utc(2026, 9, 6, 8), end=utc(2026, 9, 6, 10), request_id="req_new"
    )
    conflict = check_collisions([requested], reg).conflicts[0]
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
            start=utc(2026, 9, 6, 8),
            end=utc(2026, 9, 6, 10),
        ),  # clashes -> filtered
        AlternativeSlot(
            resource_id="stage-3",
            resource_type="stage",
            start=utc(2026, 9, 6, 11),
            end=utc(2026, 9, 6, 13),
        ),
        AlternativeSlot(
            resource_id="stage-3",
            resource_type="stage",
            start=utc(2026, 9, 6, 14),
            end=utc(2026, 9, 6, 16),
        ),
        AlternativeSlot(
            resource_id="stage-1",
            resource_type="stage",
            start=utc(2026, 9, 6, 8),
            end=utc(2026, 9, 6, 10),
        ),
    ]
    top3 = rank_alternatives(conflict, reg, candidates=cands, limit=3)
    assert len(top3) == 3
    # Clashing stage-3 08:00 must be filtered out.
    for r in top3:
        assert not (
            r.slot.resource_id == "stage-3"
            and r.slot.start == utc(2026, 9, 6, 8)
        )
    assert isinstance(top3[0], RankedAlternative)


def test_rank_auto_generates_when_no_candidates() -> None:
    reg = SlotRegistry()
    requested = make_slot(
        sid="w", start=utc(2026, 9, 6, 8), end=utc(2026, 9, 6, 10), request_id="req_new"
    )
    conflict = Conflict(
        resource_id="stage-3",
        resource_type="stage",
        requested=requested,
        blocked_by=requested,
        overlap_start=requested.start,
        overlap_end=requested.end,
        reason="OVERLAP:other",
    )
    top = rank_alternatives(conflict, reg)
    assert 1 <= len(top) <= 3
    assert all(0.0 <= r.score <= 1.0 for r in top)


def test_rank_accepts_slot_candidates_and_slot_conflict() -> None:
    reg = SlotRegistry()
    requested = make_slot(
        sid="w", start=utc(2026, 9, 6, 8), end=utc(2026, 9, 6, 10), request_id="req_new"
    )
    cand = make_slot(
        sid="c1", resource_id="stage-2", start=utc(2026, 9, 6, 8), end=utc(2026, 9, 6, 10)
    )
    top = rank_alternatives(requested, reg, candidates=[cand])
    assert len(top) == 1
    assert top[0].slot.resource_id == "stage-2"


def test_check_collisions_empty_and_report_shape() -> None:
    report = check_collisions([])
    assert isinstance(report, CollisionReport)
    assert report.has_conflict is False
    assert report.conflicts == []
    assert report.self_overlap_merged is False
    assert report.merged_slots == []


def test_check_collisions_registry_separation_reported() -> None:
    reg = SlotRegistry(
        [make_slot(sid="a", start=utc(2026, 9, 6, 8), end=utc(2026, 9, 6, 10))]
    )
    tight = make_slot(sid="b", start=utc(2026, 9, 6, 10, 5), end=utc(2026, 9, 6, 11))
    report = check_collisions([tight], reg)
    assert report.has_conflict is True
    assert report.conflicts[0].reason == "SEPARATION_VIOLATION"
