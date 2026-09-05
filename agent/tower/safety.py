"""TOWER safety gate — forced pre-hold check (T-04).

Contract: ``safety_check`` enforces union/turnaround separation plus
gear/stage maintenance windows. It is the second half of the
structurally-forced ordering ``check_collisions -> safety_check ->
hold_slot``: :mod:`agent.tower.tools` refuses ``hold_slot`` unless both
gates passed for the same request (see ``CheckedRequest``).

Deterministic core is never reimplemented: separation/crew-rest verdicts
delegate to :func:`agent.graph.slot_graph.canPlace`; only the
maintenance-window table (which the graph does not know) is checked
locally with a strict overlap rule.

In-memory maintenance table is seeded from ``infra/seed.sql``
knowledge: that seed defines the lot catalog (stage-1/2/3, adr-suite,
alexa-65/mini, sony-venice, gfm-primavera, maya/jon/priya) with zero
``availability`` rows, so this module seeds one illustrative
``alexa-65`` calibration window plus an empty-by-default table that
tests and operators extend via :meth:`InMemoryMaintenanceTable.add`.
"""

from __future__ import annotations

import sys
from collections.abc import Sequence
from datetime import datetime, timezone
from pathlib import Path

from pydantic import AwareDatetime, BaseModel, ConfigDict

_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from agent.graph.slot_graph import SlotRegistry, canPlace  # noqa: E402
from contracts.slot import ParsedSlot, Slot  # noqa: E402

__all__ = [
    "SafetyViolation",
    "SafetyReport",
    "MaintenanceWindow",
    "InMemoryMaintenanceTable",
    "DEFAULT_MAINTENANCE",
    "safety_check",
]


class SafetyViolation(ValueError):
    """Raised when the forced safety ordering is violated.

    Raised when (a) ``hold_slot`` is called without a validated
    ``CheckedRequest`` proving ``check_collisions`` + ``safety_check``
    both passed, or (b) a live re-check fails inside the hold path.
    Maps to 422/409 at the BFF boundary; message carries the
    machine-readable reason (``FORCED_ORDER:...``, ``MAINTENANCE:...``,
    ``SEPARATION_VIOLATION``, ``CREW_REST_VIOLATION``).
    """


class SafetyReport(BaseModel):
    """Result of :func:`safety_check` (fail loudly, extra=forbid)."""

    model_config = ConfigDict(extra="forbid")

    passed: bool
    violations: list[str]
    checked_slots: int
    request_id: str = ""


class MaintenanceWindow(BaseModel):
    """One blocked resource window (mirrors ``availability`` rows)."""

    model_config = ConfigDict(extra="forbid")

    resource_id: str
    start: AwareDatetime
    end: AwareDatetime
    reason: str


def _utc(
    year: int, month: int, day: int, hour: int, minute: int = 0
) -> datetime:
    return datetime(year, month, day, hour, minute, tzinfo=timezone.utc)


# Illustrative seed consistent with infra/seed.sql catalog (which ships
# zero availability rows). Operators replace/extend at runtime.
DEFAULT_MAINTENANCE: list[MaintenanceWindow] = [
    MaintenanceWindow(
        resource_id="alexa-65",
        start=_utc(2026, 9, 6, 12, 0),
        end=_utc(2026, 9, 6, 14, 0),
        reason="sensor calibration",
    ),
]


class InMemoryMaintenanceTable:
    """Thread-unsafe-in-part (single RLock-free) maintenance lookup.

    Small-N linear scan is fine at lot scale (a handful of windows).
    For Postgres, the equivalent is
    ``SELECT 1 FROM availability WHERE resource_id=%s
    AND start_ts < %s AND end_ts > %s LIMIT 1`` (see store.py docs).
    """

    def __init__(
        self, windows: list[MaintenanceWindow] | None = None
    ) -> None:
        self._windows: list[MaintenanceWindow] = (
            list(DEFAULT_MAINTENANCE) if windows is None else list(windows)
        )

    def add(self, window: MaintenanceWindow) -> None:
        """Add one maintenance window (fail loudly on bad interval)."""
        if window.end <= window.start:
            raise ValueError("INVALID_INTERVAL: maintenance end <= start")
        self._windows.append(window)

    def windows_for(self, resource_id: str) -> list[MaintenanceWindow]:
        """Return windows for one resource (copy, sorted by start)."""
        out = [w for w in self._windows if w.resource_id == resource_id]
        out.sort(key=lambda w: w.start)
        return out

    def blocking_window(
        self, resource_id: str, start: datetime, end: datetime
    ) -> MaintenanceWindow | None:
        """Return the first window overlapping ``[start, end)``, if any."""
        for w in self._windows:
            if w.resource_id != resource_id:
                continue
            if w.start < end and start < w.end:
                return w
        return None


def _as_probe(slot: object, idx: int) -> Slot:
    """Normalize to a :class:`Slot` probe for ``canPlace`` reuse."""
    if isinstance(slot, Slot):
        return slot
    if isinstance(slot, ParsedSlot):
        rid = slot.resource_id
        return Slot(
            id=f"safety-probe-{idx}-{rid}",
            production="safety-probe",
            resource_type=slot.resource_type,
            resource_id=rid,
            start=slot.start,
            end=slot.end,
            status="holding",
            request_id="safety-probe",
            trace_id="safety-probe",
        )
    raise TypeError(f"_as_probe expects Slot|ParsedSlot, got {type(slot)!r}")


def safety_check(
    slots: Sequence[Slot] | Sequence[ParsedSlot],
    registry: SlotRegistry | None = None,
    maintenance: InMemoryMaintenanceTable | None = None,
    request_id: str = "",
) -> SafetyReport:
    """Run the forced safety gate over candidate slots.

    Inputs: candidate slots, live ``registry`` (None = empty lot),
    maintenance table (None = defaults), request id for tracing.
    Output: :class:`SafetyReport` with ``passed`` + machine-readable
    ``violations``. Checks, in order: (1) gear/stage maintenance-window
    overlap -> ``MAINTENANCE:<resource_id>:<reason>``; (2) delegated
    separation/crew-rest via graph ``canPlace`` -> its reason verbatim.
    Normal: empty input passes with zero checks. Edge: ``released``
    registry entries never block (graph semantics preserved).
    """
    table = maintenance if maintenance is not None else InMemoryMaintenanceTable()
    live = registry if registry is not None else SlotRegistry()
    violations: list[str] = []
    typed: Sequence[Slot] | Sequence[ParsedSlot] = slots
    for idx, s in enumerate(typed):
        probe = _as_probe(s, idx)
        blocked = table.blocking_window(
            probe.resource_id, probe.start, probe.end
        )
        if blocked is not None:
            violations.append(
                f"MAINTENANCE:{blocked.resource_id}:{blocked.reason}"
            )
            continue
        ok, reason = canPlace(probe, live)
        if not ok and reason in (
            "SEPARATION_VIOLATION",
            "CREW_REST_VIOLATION",
        ):
            violations.append(reason)
        elif not ok and reason.startswith("OVERLAP:"):
            # Overlap is a collision, not a safety violation per se, but
            # the forced chain surfaces it here too so hold_slot can
            # refuse with a single SafetyViolation type.
            violations.append(reason)
        elif not ok:
            violations.append(reason)
    return SafetyReport(
        passed=len(violations) == 0,
        violations=violations,
        checked_slots=len(typed),
        request_id=request_id,
    )
