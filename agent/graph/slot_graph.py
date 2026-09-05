"""TOWER Slot Graph — deterministic collision engine (T-03).

Heart that blocks all downstream work. Stdlib + pydantic only —
no generative-model imports are allowed in this package.
Interval index per ``resource_id`` sorted by
start; O(log n) search via :mod:`bisect`, O(n) shift on insert.

Frozen contracts (T-04 will import these names — keep stable):

- :class:`SlotRegistry`
- :func:`check_collisions`
- :func:`rank_alternatives`
- :func:`canPlace` (camelCase frozen) + :func:`can_place` alias
- :func:`revalidate` (E12 stale-alternative hook)
- :func:`hold_slot` / :func:`hold_cascade` (E08 / E11 hooks)
- :func:`split_overnight` (E07 helper)
- :func:`merge_self_overlaps` (E04 helper)
- :func:`validate_interval` (E06 helper)
- :class:`Conflict`, :class:`RankedAlternative`, :class:`CollisionReport`
- ``Top3`` alias

Rules implemented:

- Overlap: ``existing.start < S.end and S.start < existing.end``.
- Separation minima enforced in :func:`canPlace`:
  stage 30 min turnaround, gear 15 min swap, crew 11 h rest (union).
- Machine-readable reasons: ``OK``, ``OVERLAP:<id>``,
  ``SEPARATION_VIOLATION``, ``CREW_REST_VIOLATION``, ``INVALID_INTERVAL``.
- ``released`` slots never block placement (audit only).
"""

from __future__ import annotations

import bisect
import sys
import threading
from collections.abc import Iterable
from datetime import datetime, time, timedelta, timezone
from pathlib import Path

from pydantic import AwareDatetime, BaseModel, ConfigDict, field_validator

# ---------------------------------------------------------------------------
# Import frozen Slot contract — do NOT redefine.
# Proactive repo-root insertion keeps `from contracts...` working whether
# pytest runs from repo root (`pytest agent/graph`) or from `agent/`.
# ---------------------------------------------------------------------------
_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))
from contracts.slot import AlternativeSlot, ResourceType, Slot

__all__ = [
    "CREW_REST",
    "GEAR_SWAP",
    "STAGE_TURNAROUND",
    "REASON_OK",
    "REASON_SEPARATION",
    "REASON_CREW_REST",
    "REASON_INVALID_INTERVAL",
    "REASON_PARTIAL_REROUTE_FAILED",
    "STALE_ALTERNATIVE",
    "DEFAULT_SPEC_EQUIVALENT",
    "Conflict",
    "RankedAlternative",
    "CollisionReport",
    "Top3",
    "SlotConflictError",
    "SlotRegistry",
    "validate_interval",
    "slots_overlap",
    "required_gap",
    "merge_self_overlaps",
    "split_overnight",
    "check_collisions",
    "rank_alternatives",
    "canPlace",
    "can_place",
    "revalidate",
    "hold_slot",
    "hold_cascade",
]

# ---------------------------------------------------------------------------
# Constants (named — no magic numbers).
# ---------------------------------------------------------------------------

STAGE_TURNAROUND: timedelta = timedelta(minutes=30)
GEAR_SWAP: timedelta = timedelta(minutes=15)
CREW_REST: timedelta = timedelta(hours=11)

REASON_OK: str = "OK"
REASON_SEPARATION: str = "SEPARATION_VIOLATION"
REASON_CREW_REST: str = "CREW_REST_VIOLATION"
REASON_INVALID_INTERVAL: str = "INVALID_INTERVAL"
REASON_PARTIAL_REROUTE_FAILED: str = "PARTIAL_REROUTE_FAILED"
STALE_ALTERNATIVE: str = "STALE_ALTERNATIVE"


def _overlap_prefix(slot_id: str) -> str:
    """Build the ``OVERLAP:<id>`` machine-readable reason."""
    return f"OVERLAP:{slot_id}"


# Stage 2 == Stage 3 specs per PRD assumption (update if lot survey differs).
DEFAULT_SPEC_EQUIVALENT: dict[str, list[str]] = {
    "stage-3": ["stage-2"],
    "stage-2": ["stage-3"],
}

# Scoring weights: (1) spec match dominates, (2) time delta, (3) crew.
_SPEC_WEIGHT: float = 0.5
_TIME_WEIGHT: float = 0.3
_CREW_WEIGHT: float = 0.2


# ---------------------------------------------------------------------------
# Pydantic report models (fail loudly, extra="forbid" like contracts).
# ---------------------------------------------------------------------------


class Conflict(BaseModel):
    """One blocked placement: requested slot vs the holder."""

    model_config = ConfigDict(extra="forbid")

    resource_id: str
    resource_type: ResourceType
    requested: Slot
    blocked_by: Slot
    overlap_start: AwareDatetime
    overlap_end: AwareDatetime
    reason: str


class RankedAlternative(BaseModel):
    """One viable reroute target with score in [0, 1] + human reason."""

    model_config = ConfigDict(extra="forbid")

    slot: AlternativeSlot
    score: float
    reason: str

    @field_validator("score")
    @classmethod
    def _score_in_range(cls, v: float) -> float:
        if not 0.0 <= v <= 1.0:
            raise ValueError("score must be in [0, 1]")
        return v


class CollisionReport(BaseModel):
    """Result of :func:`check_collisions`."""

    model_config = ConfigDict(extra="forbid")

    has_conflict: bool
    conflicts: list[Conflict]
    self_overlap_merged: bool
    merged_slots: list[Slot]


# Top-3 ranked alternatives (stable alias for T-04).
Top3 = list[RankedAlternative]


class SlotConflictError(ValueError):
    """Raised by :meth:`SlotRegistry.add` on overlap/separation.

    Carries the machine-readable ``reason`` (``OVERLAP:<id>`` etc.)
    so callers can map to 409-style responses without parsing text.
    """

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason: str = reason


# ---------------------------------------------------------------------------
# Pure helpers.
# ---------------------------------------------------------------------------


def validate_interval(start: datetime, end: datetime) -> None:
    """Validate ``end > start``.

    Inputs: two timezone-aware datetimes. Output: None.
    Error: raises ``ValueError("INVALID_INTERVAL: ...")`` matching
    ``contracts/slot.py`` when ``end <= start`` (E06).
    """
    if end <= start:
        raise ValueError("INVALID_INTERVAL: end must be after start")


def slots_overlap(
    a_start: datetime, a_end: datetime, b_start: datetime, b_end: datetime
) -> bool:
    """Return True iff intervals overlap (strict).

    Rule: ``existing.start < S.end and S.start < existing.end``.
    Touching (``a_end == b_start``) is NOT an overlap — separation
    minima may still reject it in :func:`canPlace`.
    """
    return a_start < b_end and b_start < a_end


def required_gap(resource_type: str) -> timedelta:
    """Return the ATC separation minimum for a resource type.

    Inputs: ``stage`` | ``gear`` | ``crew``.
    Error: raises ``ValueError`` on unknown type (fail loudly).
    """
    if resource_type == "stage":
        return STAGE_TURNAROUND
    if resource_type == "gear":
        return GEAR_SWAP
    if resource_type == "crew":
        return CREW_REST
    raise ValueError(f"unknown resource_type: {resource_type}")


def merge_self_overlaps(slots: list[Slot]) -> tuple[list[Slot], bool]:
    """Merge same-``request_id`` + same-``resource_id`` overlaps (E04).

    Inputs: candidate slots (e.g. one NL request parsed to N slots).
    Outputs: ``(merged_list, did_merge)`` — ``did_merge`` is the
    caller-visible ``self_overlap_merged`` signal.
    Normal: disjoint inputs return unchanged with ``False``.
    Edge: touching (``next.start == cur.end``) merges into one
    continuous hold. Empty input returns ``([], False)``.
    Invalid: ``end <= start`` slots cannot exist via Pydantic; a
    ``model_construct`` bypass is detected defensively and raises
    ``ValueError(INVALID_INTERVAL)``.
    """
    if not slots:
        return ([], False)
    for s in slots:
        if s.end <= s.start:
            raise ValueError("INVALID_INTERVAL: end must be after start")

    # Group by (request_id, resource_id) preserving first-seen order.
    groups: dict[tuple[str, str], list[Slot]] = {}
    order: list[tuple[str, str]] = []
    for s in slots:
        key = (s.request_id, s.resource_id)
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(s)

    merged: list[Slot] = []
    did_merge = False
    for key in order:
        group = sorted(groups[key], key=lambda s: (s.start, s.end))
        cur: Slot | None = None
        for nxt in group:
            if cur is None:
                cur = nxt
                continue
            # Overlap OR contiguous -> merge (same request, same resource).
            # Sorted by start, so nxt.start >= cur.start; merge iff
            # nxt touches or overlaps cur (nxt.start <= cur.end).
            if nxt.start <= cur.end:
                # Extend to union [cur.start, max(cur.end, nxt.end)].
                new_end = nxt.end if nxt.end > cur.end else cur.end
                cur = Slot(
                    id=cur.id,
                    production=cur.production,
                    resource_type=cur.resource_type,
                    resource_id=cur.resource_id,
                    start=cur.start,
                    end=new_end,
                    status=cur.status,
                    request_id=cur.request_id,
                    trace_id=cur.trace_id,
                )
                did_merge = True
            else:
                merged.append(cur)
                cur = nxt
        if cur is not None:
            merged.append(cur)
    # Stable output order by start for determinism.
    merged.sort(key=lambda s: (s.start, s.end, s.resource_id))
    return (merged, did_merge)


def split_overnight(slot: Slot) -> list[Slot]:
    """Split a midnight-crossing slot at UTC midnights (E07).

    Inputs: one :class:`Slot`. Outputs: ``[slot]`` when the slot lies
    within a single UTC date; otherwise one slot per UTC date spanned
    (``22:00-06:00`` -> ``[22:00-24:00, 00:00-06:00]``).
    Parts keep all metadata; ids are ``<id>__p1..pN`` (original id when
    no split). Invalid: ``end <= start`` raises ``ValueError``.
    """
    if slot.end <= slot.start:
        raise ValueError("INVALID_INTERVAL: end must be after start")
    if slot.start.date() == slot.end.date():
        return [slot]
    tz = slot.start.tzinfo if slot.start.tzinfo is not None else timezone.utc
    parts: list[Slot] = []
    cur_start: datetime = slot.start
    idx = 1
    # Walk midnight to midnight until the tail date is reached.
    while cur_start.date() != slot.end.date():
        nxt_midnight = datetime.combine(
            cur_start.date() + timedelta(days=1), time.min
        ).replace(tzinfo=tz)
        # Guard: midnight must advance (DST-safe fallback to UTC).
        if nxt_midnight <= cur_start:
            nxt_midnight = datetime(
                cur_start.year,
                cur_start.month,
                cur_start.day,
                23,
                59,
                59,
                tzinfo=tz,
            ) + timedelta(seconds=1)
        parts.append(
            Slot(
                id=f"{slot.id}__p{idx}",
                production=slot.production,
                resource_type=slot.resource_type,
                resource_id=slot.resource_id,
                start=cur_start,
                end=nxt_midnight,
                status=slot.status,
                request_id=slot.request_id,
                trace_id=slot.trace_id,
            )
        )
        cur_start = nxt_midnight
        idx += 1
    parts.append(
        Slot(
            id=f"{slot.id}__p{idx}" if len(parts) > 0 else slot.id,
            production=slot.production,
            resource_type=slot.resource_type,
            resource_id=slot.resource_id,
            start=cur_start,
            end=slot.end,
            status=slot.status,
            request_id=slot.request_id,
            trace_id=slot.trace_id,
        )
    )
    # Single-day fallthrough already returned; fix id when exactly 1 part.
    if len(parts) == 1:
        sole = parts[0]
        parts[0] = Slot(
            id=slot.id,
            production=sole.production,
            resource_type=sole.resource_type,
            resource_id=sole.resource_id,
            start=sole.start,
            end=sole.end,
            status=sole.status,
            request_id=sole.request_id,
            trace_id=sole.trace_id,
        )
    return parts


# ---------------------------------------------------------------------------
# Registry: per-resource start-sorted lists + RLock for E08 serialization.
# ---------------------------------------------------------------------------


class SlotRegistry:
    """Deterministic interval index.

    Holds one start-sorted list per ``resource_id``. Search is O(log n)
    via :func:`bisect.bisect_left` on a parallel starts list; list
    insert shifts O(n) (standard for array-backed interval indexes at
    lot scale). All mutating + checking paths hold an :class:`RLock`
    so concurrent :meth:`hold_slot` calls serialize (E08): exactly one
    racer wins, the other gets ``(False, "OVERLAP:<id>")``.
    """

    def __init__(self, slots: Iterable[Slot] | None = None) -> None:
        self._by_resource: dict[str, list[Slot]] = {}
        self._starts_by_resource: dict[str, list[datetime]] = {}
        self._lock: threading.RLock = threading.RLock()
        if slots is not None:
            for s in slots:
                self.add(s)

    # -- internal (caller must hold self._lock) ---------------------------

    def _insert_sorted_locked(self, slot: Slot) -> None:
        lst = self._by_resource.setdefault(slot.resource_id, [])
        starts = self._starts_by_resource.setdefault(slot.resource_id, [])
        idx = bisect.bisect_left(starts, slot.start)
        lst.insert(idx, slot)
        starts.insert(idx, slot.start)

    def _can_place_locked(self, slot: Slot) -> tuple[bool, str]:
        # Invalid interval first (model_construct bypass path, E06).
        if slot.end <= slot.start:
            return (False, REASON_INVALID_INTERVAL)
        # released holds are audit-only and never block.
        lst = self._by_resource.get(slot.resource_id, [])
        starts = self._starts_by_resource.get(slot.resource_id, [])
        if not lst:
            return (True, REASON_OK)
        idx = bisect.bisect_left(starts, slot.start)

        # Overlap: predecessor + forward scan while start < slot.end.
        if idx > 0:
            prev = lst[idx - 1]
            if prev.status != "released" and slots_overlap(
                prev.start, prev.end, slot.start, slot.end
            ):
                return (False, _overlap_prefix(prev.id))
        j = idx
        while j < len(lst) and lst[j].start < slot.end:
            cur = lst[j]
            if cur.status != "released" and slots_overlap(
                cur.start, cur.end, slot.start, slot.end
            ):
                return (False, _overlap_prefix(cur.id))
            j += 1

        # Separation: only immediate live neighbours matter.
        gap_needed = required_gap(slot.resource_type)
        crew_case = slot.resource_type == "crew"
        # Predecessor gap (nearest live slot ending at/before slot.start).
        k = idx - 1
        while k >= 0 and lst[k].status == "released":
            k -= 1
        if k >= 0:
            prev_live = lst[k]
            # No overlap here (checked above), so prev_live.end <= slot.start.
            if prev_live.end <= slot.start:
                if slot.start - prev_live.end < gap_needed:
                    return (
                        (False, REASON_CREW_REST)
                        if crew_case
                        else (False, REASON_SEPARATION)
                    )
        # Successor gap (nearest live slot starting at/after slot.start).
        m = idx
        while m < len(lst) and lst[m].status == "released":
            m += 1
        if m < len(lst):
            next_live = lst[m]
            # No overlap here, so slot.end <= next_live.start.
            if slot.end <= next_live.start:
                if next_live.start - slot.end < gap_needed:
                    return (
                        (False, REASON_CREW_REST)
                        if crew_case
                        else (False, REASON_SEPARATION)
                    )
        return (True, REASON_OK)

    # -- public ------------------------------------------------------------

    def can_place(self, slot: Slot) -> tuple[bool, str]:
        """Check placement without mutating. Returns ``(ok, reason)``."""
        with self._lock:
            return self._can_place_locked(slot)

    def add(self, slot: Slot) -> None:
        """Insert, raising :class:`SlotConflictError` on conflict (E08).

        Prefer :meth:`hold_slot` when a 409-style tuple is wanted.
        """
        with self._lock:
            ok, reason = self._can_place_locked(slot)
            if not ok:
                raise SlotConflictError(reason)
            self._insert_sorted_locked(slot)

    def hold_slot(self, slot: Slot) -> tuple[bool, str]:
        """Atomic re-check + insert (E08 race gate, E12 stale gate).

        Inputs: candidate slot. Outputs: ``(True, "OK")`` on hold,
        ``(False, reason)`` when stale/conflicting — the graph-level
        409-like signal. Thread-safe: concurrent callers serialize on
        the registry lock so double-hold is impossible.
        """
        with self._lock:
            ok, reason = self._can_place_locked(slot)
            if not ok:
                return (False, reason)
            self._insert_sorted_locked(slot)
            return (True, REASON_OK)

    def hold_all_atomic(self, slots: list[Slot]) -> tuple[bool, str]:
        """Hold N slots atomically; rollback on first failure (E11).

        Inputs: cascade batch (e.g. stage + gear + crew). Outputs:
        ``(True, "OK")`` when all held, else
        ``(False, "PARTIAL_REROUTE_FAILED:<reason>")`` with the
        registry unchanged (no partial holds).
        The batch is validated against the registry *and* against
        itself (earlier batch items act as blockers for later ones),
        so same-resource overlaps within the batch fail atomically.
        Edge: empty batch returns ``(True, "OK")`` (no-op).
        """
        with self._lock:
            if not slots:
                return (True, REASON_OK)
            # Validate against registry + intra-batch via scratch copy.
            scratch = SlotRegistry()
            for existing in self.all_slots():
                scratch._insert_sorted_locked(existing)
            for s in slots:
                ok, reason = scratch._can_place_locked(s)
                if not ok:
                    return (False, f"{REASON_PARTIAL_REROUTE_FAILED}:{reason}")
                scratch._insert_sorted_locked(s)
            for s in slots:
                self._insert_sorted_locked(s)
            return (True, REASON_OK)

    def slots_for(self, resource_id: str) -> list[Slot]:
        """Return a copy of holds for one resource (sorted by start)."""
        with self._lock:
            return list(self._by_resource.get(resource_id, []))

    def all_slots(self) -> list[Slot]:
        """Return every hold across resources (grouped, start-sorted)."""
        with self._lock:
            out: list[Slot] = []
            for rid in sorted(self._by_resource.keys()):
                out.extend(self._by_resource[rid])
            return out

    def __len__(self) -> int:
        with self._lock:
            return sum(len(v) for v in self._by_resource.values())


# ---------------------------------------------------------------------------
# Frozen module-level API (T-04 imports these).
# ---------------------------------------------------------------------------


def canPlace(slot: Slot, registry: SlotRegistry | None = None) -> tuple[bool, str]:
    """Check whether ``slot`` can be placed (frozen camelCase name).

    Inputs: candidate + optional registry (``None`` = empty lot).
    Outputs: ``(True, "OK")`` or ``(False, reason)`` where reason is
    ``OVERLAP:<id>`` | ``SEPARATION_VIOLATION`` |
    ``CREW_REST_VIOLATION`` | ``INVALID_INTERVAL``.
    """
    if slot.end <= slot.start:
        return (False, REASON_INVALID_INTERVAL)
    if registry is None:
        return (True, REASON_OK)
    return registry.can_place(slot)


def can_place(slot: Slot, registry: SlotRegistry | None = None) -> tuple[bool, str]:
    """Snake-case alias of :func:`canPlace` (same semantics)."""
    return canPlace(slot, registry)


def revalidate(slot: Slot, registry: SlotRegistry) -> tuple[bool, str]:
    """Re-check a previously ranked alternative just before hold (E12).

    Inputs: alternative-as-:class:`Slot` + live registry.
    Outputs: same tuple as :func:`canPlace`. Call this inside the
    hold transaction: ``(False, ...)`` means ``409 STALE_ALTERNATIVE``
    — refresh alternatives instead of ghost-holding.
    """
    return canPlace(slot, registry)


def hold_slot(slot: Slot, registry: SlotRegistry) -> tuple[bool, str]:
    """Module-level hold hook delegating to the registry (E08/E12)."""
    return registry.hold_slot(slot)


def hold_cascade(
    slots: list[Slot], registry: SlotRegistry
) -> tuple[bool, str]:
    """Module-level atomic cascade hook delegating to registry (E11)."""
    return registry.hold_all_atomic(slots)


def check_collisions(
    slots: list[Slot], registry: SlotRegistry | None = None
) -> CollisionReport:
    """Detect collisions within ``slots`` and optionally vs ``registry``.

    Inputs: new slots (one request batch) + optional live registry.
    ``registry=None`` preserves the frozen single-arg call shape and
    checks internal consistency only.
    Outputs: :class:`CollisionReport` with ``has_conflict``,
    per-resource :class:`Conflict` entries (overlap window + reason),
    and the E04 ``self_overlap_merged`` flag + ``merged_slots``.
    Normal: empty input -> no conflict, no merge. Edge: touching
    intervals are not overlaps. Invalid: ``end <= start`` raises
    ``ValueError(INVALID_INTERVAL)``.
    """
    merged, did_merge = merge_self_overlaps(slots)
    conflicts: list[Conflict] = []
    # Internal batch check via scratch registry (per-resource, in order).
    scratch = SlotRegistry()
    for s in merged:
        ok, reason = scratch.can_place(s)
        if not ok:
            # Find the blocker for overlap window + ids.
            blocker: Slot | None = None
            for cand in scratch.slots_for(s.resource_id):
                if cand.status == "released":
                    continue
                if slots_overlap(cand.start, cand.end, s.start, s.end):
                    blocker = cand
                    break
            if blocker is None:
                # Separation case: blocker is nearest live neighbour.
                cands = [
                    c
                    for c in scratch.slots_for(s.resource_id)
                    if c.status != "released"
                ]
                # Pick the neighbour with minimal gap.
                best: Slot | None = None
                best_gap: timedelta | None = None
                for c in cands:
                    if c.end <= s.start:
                        gap = s.start - c.end
                    elif s.end <= c.start:
                        gap = c.start - s.end
                    else:
                        gap = timedelta(0)
                    if best_gap is None or gap < best_gap:
                        best_gap = gap
                        best = c
                blocker = best if best is not None else s
            ov_start = (
                s.start if s.start > blocker.start else blocker.start
            )
            ov_end = s.end if s.end < blocker.end else blocker.end
            # Separation conflicts have no true overlap window; report
            # the requested window so callers can show next-viable time.
            if ov_start >= ov_end:
                ov_start = s.start
                ov_end = s.end
            conflicts.append(
                Conflict(
                    resource_id=s.resource_id,
                    resource_type=s.resource_type,
                    requested=s,
                    blocked_by=blocker,
                    overlap_start=ov_start,
                    overlap_end=ov_end,
                    reason=reason,
                )
            )
        else:
            scratch.add(s)

    # Registry check for slots that survived the internal check.
    if registry is not None:
        # Only check slots not already conflicting internally.
        conflicting_ids = {c.requested.id for c in conflicts}
        for s in merged:
            if s.id in conflicting_ids:
                continue
            ok2, reason2 = registry.can_place(s)
            if not ok2:
                blocker2: Slot | None = None
                for cand2 in registry.slots_for(s.resource_id):
                    if cand2.status == "released":
                        continue
                    if slots_overlap(cand2.start, cand2.end, s.start, s.end):
                        blocker2 = cand2
                        break
                if blocker2 is None:
                    live = [
                        c
                        for c in registry.slots_for(s.resource_id)
                        if c.status != "released"
                    ]
                    blocker2 = live[0] if live else s
                ov2_start = (
                    s.start if s.start > blocker2.start else blocker2.start
                )
                ov2_end = s.end if s.end < blocker2.end else blocker2.end
                if ov2_start >= ov2_end:
                    ov2_start = s.start
                    ov2_end = s.end
                conflicts.append(
                    Conflict(
                        resource_id=s.resource_id,
                        resource_type=s.resource_type,
                        requested=s,
                        blocked_by=blocker2,
                        overlap_start=ov2_start,
                        overlap_end=ov2_end,
                        reason=reason2,
                    )
                )
    return CollisionReport(
        has_conflict=len(conflicts) > 0,
        conflicts=conflicts,
        self_overlap_merged=did_merge,
        merged_slots=merged,
    )


def _to_alternative_slot(
    candidate: Slot | AlternativeSlot, fallback_type: ResourceType
) -> AlternativeSlot:
    """Normalize a candidate to :class:`AlternativeSlot`."""
    if isinstance(candidate, AlternativeSlot):
        if candidate.resource_type is None:
            return AlternativeSlot(
                resource_id=candidate.resource_id,
                resource_type=fallback_type,
                start=candidate.start,
                end=candidate.end,
            )
        return candidate
    return AlternativeSlot(
        resource_id=candidate.resource_id,
        resource_type=candidate.resource_type,
        start=candidate.start,
        end=candidate.end,
    )


def _generate_candidates(
    requested: Slot,
    spec_equivalent: dict[str, list[str]],
    crew_ids: list[str],
) -> list[AlternativeSlot]:
    """Auto-generate fallback candidates when none are supplied."""
    out: list[AlternativeSlot] = []
    duration = requested.end - requested.start
    gap = required_gap(requested.resource_type)
    # (a) spec-equivalent resources, same time.
    for alt_id in spec_equivalent.get(requested.resource_id, []):
        out.append(
            AlternativeSlot(
                resource_id=alt_id,
                resource_type=requested.resource_type,
                start=requested.start,
                end=requested.end,
            )
        )
    # (b) same resource, time-shifted to next viable windows.
    for n in (1, 2):
        shift = (duration + gap) * n
        out.append(
            AlternativeSlot(
                resource_id=requested.resource_id,
                resource_type=requested.resource_type,
                start=requested.start + shift,
                end=requested.end + shift,
            )
        )
    # (c) crew substitution at same time (E10: suggest Priya for Maya).
    if requested.resource_type == "crew":
        for cid in crew_ids:
            if cid != requested.resource_id:
                out.append(
                    AlternativeSlot(
                        resource_id=cid,
                        resource_type="crew",
                        start=requested.start,
                        end=requested.end,
                    )
                )
    return out


def rank_alternatives(
    conflict: Conflict | Slot,
    registry: SlotRegistry | None = None,
    candidates: list[Slot] | list[AlternativeSlot] | None = None,
    *,
    spec_equivalent: dict[str, list[str]] | None = None,
    crew_availability: dict[str, bool] | None = None,
    limit: int = 3,
) -> list[RankedAlternative]:
    """Rank viable alternatives for a conflict (Top-3).

    Inputs: ``conflict`` (or the requested :class:`Slot` directly for
    convenience), live ``registry`` (``None`` = empty), explicit
    ``candidates`` (defaults to auto-generated: spec-equivalent same
    time + time-shifted same resource + crew substitution), optional
    ``spec_equivalent`` map, optional ``crew_availability``
    (``False`` = that crew id is out), ``limit`` (default 3).
    Scoring: (1) spec match, (2) min time delta, (3) crew
    availability — ``score = 0.5*spec + 0.3*time + 0.2*crew`` in
    ``[0, 1]`` with a human ``reason``. Only placeable candidates
    (``canPlace == OK``) are returned, sorted by score desc then
    time-delta asc, truncated to ``limit``.
    Edge: no viable candidates -> ``[]``. Empty registry -> all
    candidates viable (subject to separation among themselves? No —
    each is checked independently vs the registry only).
    """
    requested: Slot = conflict.requested if isinstance(conflict, Conflict) else conflict
    equiv: dict[str, list[str]] = (
        dict(DEFAULT_SPEC_EQUIVALENT) if spec_equivalent is None else spec_equivalent
    )
    live_registry: SlotRegistry = registry if registry is not None else SlotRegistry()

    pool: list[AlternativeSlot]
    if candidates is None:
        crew_ids = sorted(crew_availability.keys()) if crew_availability else []
        pool = _generate_candidates(requested, equiv, crew_ids)
    else:
        pool = [_to_alternative_slot(c, requested.resource_type) for c in candidates]

    scored: list[tuple[float, float, RankedAlternative]] = []
    for idx, alt in enumerate(pool):
        # Crew filter first (explicit unavailability, E10).
        crew_ok = True
        if crew_availability is not None and alt.resource_id in crew_availability:
            crew_ok = bool(crew_availability[alt.resource_id])
        if not crew_ok:
            continue
        # Viability gate: must be placeable right now.
        probe = Slot(
            id=f"probe-{idx}-{alt.resource_id}",
            production=requested.production,
            resource_type=alt.resource_type
            if alt.resource_type is not None
            else requested.resource_type,
            resource_id=alt.resource_id,
            start=alt.start,
            end=alt.end,
            status="holding",
            request_id=requested.request_id,
            trace_id=requested.trace_id,
        )
        ok, _ = live_registry.can_place(probe)
        if not ok:
            continue
        eff_type: str = (
            alt.resource_type if alt.resource_type is not None else requested.resource_type
        )
        if alt.resource_id == requested.resource_id:
            spec_score = 1.0
            spec_note = "same resource"
        elif alt.resource_id in equiv.get(requested.resource_id, []):
            spec_score = 0.95
            spec_note = f"same specs ({alt.resource_id}={requested.resource_id})"
        elif eff_type == requested.resource_type:
            spec_score = 0.7
            spec_note = f"same type ({eff_type})"
        else:
            spec_score = 0.4
            spec_note = "different type"
        delta_h = abs((alt.start - requested.start).total_seconds()) / 3600.0
        time_score = 1.0 / (1.0 + delta_h)
        crew_score = 1.0  # filtered above; kept as scoring input for weights.
        total = round(
            _SPEC_WEIGHT * spec_score
            + _TIME_WEIGHT * time_score
            + _CREW_WEIGHT * crew_score,
            3,
        )
        if delta_h < 0.05:
            when = "same time"
        else:
            when = f"{delta_h:.1f}h shift"
        reason = f"{spec_note}, {when}, crew available"
        scored.append(
            (
                total,
                delta_h,
                RankedAlternative(slot=alt, score=total, reason=reason),
            )
        )
    scored.sort(key=lambda t: (-t[0], t[1]))
    return [r for _, _, r in scored[:limit]]
