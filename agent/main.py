"""TOWER production agent server — FastAPI /invoke + /slots + /health (T-11a).

Wire contract (mirrors ``frontend/lib/agent.ts`` exactly):

* ``POST /invoke`` op-dispatched: ``create_request`` | ``reroute``.
* ``GET /slots?date=YYYY-MM-DD`` day-view reads.
* ``GET /health`` liveness + Postgres probe.

Real wiring, no mocks: :class:`LiveGeminiClient` behind the shared
:class:`GeminiBreaker`, :class:`LiveSlotStore` (Postgres; the
``DATABASE_URL`` setting is required and missing/invalid values fail LOUD
at startup, E17), :class:`InMemoryIdempotencyStore`, and an EMPTY
:class:`InMemoryMaintenanceTable` (seed knowledge lives in the DB
``availability`` rows, never in process memory).

create_request flow: parse -> unknown/clarify 422 -> Slot build (holding)
-> check_collisions -> conflict ? 200 report + ranked alternatives (AND a
best-effort hold of the requested slots so a later reroute can still find
them) : build_checked_request -> hold_slot -> 200 confirmed.

reroute flow: AlternativeSlot validate -> reroute() -> 200 confirmed.
Errors map to STALE_ALTERNATIVE 409 / IDEMPOTENCY_KEY_REUSE 422 /
PARTIAL_REROUTE_FAILED 500 / unknown request 404.

Tracing: incoming ``x-trace-id`` wins, else the body's ``traceId``, else a
generated ``trace_<12hex>``. Every response echoes ``x-trace-id`` and
carries ``traceId`` in the body. Tracebacks never leave the process:
unexpected failures return a generic AGENT_UPSTREAM envelope and are
logged loudly server-side with the trace id.

Concurrency: the drivers are blocking (sync psycopg, sync Gemini SDK), so
the /invoke handler awaits the body (async) then offloads the whole
domain flow to ``run_in_threadpool`` — the event loop never stalls and
/health stays snappy while a parse is in flight. Sync GET handlers run in
FastAPI's threadpool automatically.
"""

from __future__ import annotations

import logging
import os
import re
import sys
import threading
import time
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import date, datetime, time as dtime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from starlette.concurrency import run_in_threadpool

_REPO_ROOT = Path(__file__).resolve().parents[1]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from agent.graph.slot_graph import (  # noqa: E402
    RankedAlternative,
    SlotRegistry,
    rank_alternatives,
)
from agent.observability import emitter as obs  # noqa: E402
from agent.tower.breaker import (  # noqa: E402
    BreakerOpenError,
    GeminiBreaker,
    GeminiError,
)
from agent.tower.safety import (  # noqa: E402
    InMemoryMaintenanceTable,
    SafetyViolation,
)
from agent.tower.store import (  # noqa: E402
    IdempotencyKeyReuse,
    IdempotencyRecord,
    InMemoryIdempotencyStore,
    PostgresSlotStore,
    compute_body_hash,
)
from agent.tower.tools import (  # noqa: E402
    LiveGeminiClient,
    MissingGeminiKeyError,
    PartialRerouteFailedError,
    ParseResult,
    StaleAlternativeError,
    build_checked_request,
    check_collisions,
    hold_slot,
    parse_request,
    reroute,
)
from contracts.slot import AlternativeSlot, Slot  # noqa: E402

__all__ = [
    "app",
    "SlotStoreUnavailable",
    "LiveSlotStore",
    "CreateRequestOp",
    "RerouteOp",
    "get_slot_store",
]

_LOGGER = logging.getLogger("tower.agent_server")

_DATABASE_URL_ENV = "DATABASE_URL"
_TRACE_HEADER = "x-trace-id"
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# Columns mirror contracts/slot.py Slot field names (start/end map to the
# ledger start_ts/end_ts columns per services/ledger/schema.sql).
_SLOT_COLUMNS = (
    "id, production, resource_type, resource_id, "
    "start_ts, end_ts, status, request_id, trace_id"
)


class SlotStoreUnavailable(RuntimeError):
    """Postgres dependency failure (maps to 503, never leaks details)."""


def _connect_pg(url: str) -> Any:
    """Open one sync psycopg connection (lazy import, short timeout).

    The import is lazy so unit tests and mypy never need the driver or a
    live database; only request/startup paths that touch Postgres pay it.
    """
    from psycopg import connect  # type: ignore[import-not-found]

    return connect(url, connect_timeout=5)


def _fetch_rows(url: str, query: str, params: dict[str, Any]) -> list[tuple[Any, ...]]:
    """Run a SELECT and return rows (fail loudly as SlotStoreUnavailable)."""
    try:
        conn = _connect_pg(url)
    except Exception as exc:
        raise SlotStoreUnavailable(f"postgres connect failed: {exc}") from exc
    try:
        with conn.cursor() as cur:
            cur.execute(query, params)
            fetched: Any = cur.fetchall()
            return [tuple(row) for row in fetched]
    except Exception as exc:
        raise SlotStoreUnavailable(f"postgres query failed: {exc}") from exc
    finally:
        try:
            conn.close()
        except Exception:
            pass


def _row_to_slot(row: tuple[Any, ...]) -> Slot:
    """Map one ledger row to a validated Slot (fail loudly on bad data)."""
    sid, production, rtype, rid, start, end, status, request_id, trace_id = row
    return Slot(
        id=sid,
        production=production,
        resource_type=rtype,
        resource_id=rid,
        start=start,
        end=end,
        status=status,
        request_id=request_id,
        trace_id=trace_id,
    )


class LiveSlotStore(PostgresSlotStore):
    """PostgresSlotStore plus the SELECT paths main.py needs.

    Atomic holds come straight from the base class (same SQL, same
    E08/E12 semantics); this subclass only adds reads (single-row get,
    per-resource / whole-lot / per-request / per-day listings) and
    translates driver failures into :class:`SlotStoreUnavailable` so
    handlers map them to 503 without leaking internals.
    """

    def __init__(self, url: str) -> None:
        self._url = url
        super().__init__(lambda: _connect_pg(url))

    def _select(self, where: str, params: dict[str, Any], order: str) -> list[Slot]:
        rows = _fetch_rows(
            self._url,
            f"SELECT {_SLOT_COLUMNS} FROM slots WHERE {where} ORDER BY {order}",
            params,
        )
        return [_row_to_slot(r) for r in rows]

    def get(self, slot_id: str) -> Slot | None:
        """Return one slot by id, any status (released rows stay visible)."""
        rows = self._select("id = %(id)s", {"id": slot_id}, "start_ts")
        return rows[0] if rows else None

    def slots_for(self, resource_id: str) -> list[Slot]:
        """Return live holds for one resource (sorted by start)."""
        return self._select(
            "resource_id = %(resource_id)s AND status != 'released'",
            {"resource_id": resource_id},
            "start_ts, end_ts, id",
        )

    def all_slots(self) -> list[Slot]:
        """Return every live hold (registry snapshot source)."""
        return self._select("status != 'released'", {}, "resource_id, start_ts")

    def slots_for_request(self, request_id: str) -> list[Slot]:
        """Return every hold tagged with request_id (any status)."""
        return self._select(
            "request_id = %(request_id)s",
            {"request_id": request_id},
            "start_ts, end_ts, resource_id",
        )

    def slots_for_date(self, start: datetime, end: datetime) -> list[Slot]:
        """Return live holds overlapping the half-open window [start, end)."""
        return self._select(
            "start_ts < %(end)s AND end_ts > %(start)s AND status != 'released'",
            {"start": start, "end": end},
            "start_ts, end_ts, resource_id",
        )

    def hold(self, slot: Slot, idempotency_key: str) -> tuple[bool, str]:
        """Atomic hold, translating driver failures to 503-safe errors."""
        try:
            return super().hold(slot, idempotency_key)
        except Exception as exc:
            raise SlotStoreUnavailable(f"postgres hold failed: {exc}") from exc

    def hold_all_atomic(
        self, slots: list[Slot], idempotency_key: str = ""
    ) -> tuple[bool, str]:
        """Atomic cascade hold, translating driver failures to 503-safe errors."""
        try:
            return super().hold_all_atomic(slots, idempotency_key)
        except Exception as exc:
            raise SlotStoreUnavailable(
                f"postgres cascade hold failed: {exc}"
            ) from exc

    def release(self, slot_id: str) -> bool:
        """Mark slot_id released, translating driver failures to 503-safe errors."""
        try:
            return super().release(slot_id)
        except Exception as exc:
            raise SlotStoreUnavailable(
                f"postgres release failed: {exc}"
            ) from exc


def _require_database_url() -> str:
    """Return DATABASE_URL or fail LOUD (E17: refuse to start without it)."""
    url = os.environ.get(_DATABASE_URL_ENV, "").strip()
    if not url:
        raise RuntimeError(
            "E17: DATABASE_URL is required but missing or empty; "
            "refusing to start the agent server"
        )
    return url


_store: LiveSlotStore | None = None
_store_lock = threading.Lock()


def get_slot_store() -> LiveSlotStore:
    """Return the process-wide live store (built once from DATABASE_URL)."""
    global _store
    if _store is not None:
        return _store
    with _store_lock:
        if _store is None:
            _store = LiveSlotStore(_require_database_url())
        return _store


# Process-wide shared collaborators (no mocks): one breaker, one
# idempotency store, one identical-text parse cache for breaker fallback.
_breaker = GeminiBreaker()
_idempotency = InMemoryIdempotencyStore()
_parse_cache: dict[str, ParseResult] = {}


class CreateRequestOp(BaseModel):
    """POST /invoke create_request body (extra=forbid, fail loudly)."""

    model_config = ConfigDict(extra="forbid")

    op: Literal["create_request"]
    text: str
    idempotencyKey: str
    now: str
    actor: str = "unknown-production"
    traceId: str = ""


class RerouteOp(BaseModel):
    """POST /invoke reroute body (extra=forbid, fail loudly)."""

    model_config = ConfigDict(extra="forbid")

    op: Literal["reroute"]
    requestId: str = Field(min_length=1)
    alternative: AlternativeSlot
    idempotencyKey: str
    actor: str = "unknown-production"
    traceId: str = ""


def _new_trace_id() -> str:
    """Generate a fresh trace_<12hex> correlation id."""
    return f"trace_{uuid.uuid4().hex[:12]}"


def _header_trace(request: Request) -> str:
    """Return the incoming x-trace-id when present and sane, else empty."""
    incoming = request.headers.get(_TRACE_HEADER)
    if isinstance(incoming, str):
        candidate = incoming.strip()
        if candidate and len(candidate) <= 128:
            return candidate
    return ""


def _resolve_trace(header_trace: str, body_trace: str) -> str:
    """Trace precedence: incoming header, else body traceId, else generated."""
    if header_trace:
        return header_trace
    if body_trace.strip():
        return body_trace.strip()[:128]
    return _new_trace_id()


def _json(status_code: int, body: dict[str, Any], trace_id: str) -> JSONResponse:
    """Build a JSON response echoing the trace id header."""
    return JSONResponse(
        status_code=status_code, content=body, headers={_TRACE_HEADER: trace_id}
    )


def _upstream_500(trace_id: str, exc: Exception, where: str) -> JSONResponse:
    """Generic 500 envelope: log loudly server-side, leak nothing."""
    _LOGGER.exception("(%s) %s failed: %s", trace_id, where, exc)
    obs.emit_error(
        trace_id=trace_id, code="AGENT_UPSTREAM", message=f"{where} failed"
    )
    return _json(
        500,
        {"code": "AGENT_UPSTREAM", "message": "agent upstream failure"},
        trace_id,
    )


def _validation_error_body(exc: ValidationError) -> tuple[int, dict[str, Any]]:
    """Map a pydantic ValidationError to a contract-coded 422 body."""
    errors = exc.errors()
    parts = [str(p) for p in errors[0].get("loc", ())] if errors else []
    if "alternative" in parts and ("end" in parts or "start" in parts):
        return (
            422,
            {
                "code": "INVALID_INTERVAL",
                "message": "alternative end must be after start",
            },
        )
    if "idempotencyKey" in parts:
        return (
            422,
            {
                "code": "IDEMPOTENCY_KEY_REUSE",
                "message": "idempotencyKey must be uuidv4",
            },
        )
    if "alternative" in parts:
        return (
            422,
            {
                "code": "NEEDS_CLARIFICATION",
                "field": "alternative",
                "message": "alternative slot is invalid",
            },
        )
    if "requestId" in parts:
        return (
            422,
            {
                "code": "NEEDS_CLARIFICATION",
                "field": "requestId",
                "message": "requestId is required",
            },
        )
    field = ".".join(parts) if parts else "body"
    return (
        422,
        {
            "code": "NEEDS_CLARIFICATION",
            "field": field,
            "message": "invalid request body",
        },
    )


def _overlap_label(start: datetime, end: datetime) -> str:
    """Format an overlap window as HH:MM-HH:MM in UTC (contract shape)."""
    s = start.astimezone(timezone.utc).strftime("%H:%M")
    e = end.astimezone(timezone.utc).strftime("%H:%M")
    return f"{s}-{e}"


def _alternative_json(alt: AlternativeSlot) -> dict[str, Any]:
    """Serialize an alternative without null resource_type (BFF-strict)."""
    return dict(alt.model_dump(mode="json", exclude_none=True))


def _check_now(now: str) -> str | None:
    """Validate TZ-aware ISO now; return an error message or None when ok."""
    try:
        parsed = datetime.fromisoformat(now.replace("Z", "+00:00"))
    except ValueError:
        return "now must be TZ-aware ISO 8601"
    if parsed.tzinfo is None:
        return "now must be TZ-aware ISO 8601"
    return None


def _check_key(key: str) -> str | None:
    """Validate the idempotency key shape; return an error or None when ok."""
    try:
        uuid.UUID(key)
    except (ValueError, AttributeError, TypeError):
        return "idempotencyKey must be uuidv4"
    return None


def _create_request_sync(body: CreateRequestOp, trace_id: str) -> JSONResponse:
    """Run the create_request flow (sync: blocking drivers, threadpooled)."""
    try:
        if not body.text.strip():
            return _json(
                422,
                {
                    "code": "NEEDS_CLARIFICATION",
                    "field": "text",
                    "message": "text must not be empty",
                },
                trace_id,
            )
        key_problem = _check_key(body.idempotencyKey)
        if key_problem is not None:
            return _json(
                422,
                {"code": "IDEMPOTENCY_KEY_REUSE", "message": key_problem},
                trace_id,
            )
        now_problem = _check_now(body.now)
        if now_problem is not None:
            return _json(
                422,
                {
                    "code": "NEEDS_CLARIFICATION",
                    "field": "now",
                    "message": now_problem,
                },
                trace_id,
            )

        # Canonical E19 body: trace ids are per-attempt metadata and must
        # NOT affect the hash, or retries would false-positive as reuse.
        canonical: dict[str, Any] = {
            "text": body.text,
            "now": body.now,
            "idempotencyKey": body.idempotencyKey,
            "actor": body.actor,
        }
        body_hash = compute_body_hash(canonical)

        try:
            replayed = _idempotency.check(body.idempotencyKey, body_hash)
        except IdempotencyKeyReuse:
            return _json(
                422,
                {
                    "code": "IDEMPOTENCY_KEY_REUSE",
                    "message": "idempotencyKey already used with a different body",
                },
                trace_id,
            )
        if replayed is not None:
            return _json(
                409,
                {
                    "code": "IDEMPOTENT_REPLAY",
                    "requestId": replayed.get("request_id", ""),
                    "message": "Same idempotencyKey already processed",
                },
                trace_id,
            )

        started = time.monotonic()
        try:
            parsed = parse_request(
                body.text,
                body.now,
                client=LiveGeminiClient(),
                breaker=_breaker,
                cache=_parse_cache,
            )
        except BreakerOpenError as exc:
            _LOGGER.warning(
                "(%s) breaker open, retry in %.1fs (queued=%s)",
                trace_id,
                exc.retry_after_secs,
                exc.queued,
            )
            obs.emit_error(
                trace_id=trace_id,
                code="AGENT_UPSTREAM",
                message="breaker open",
                production=body.actor,
            )
            return _json(
                503,
                {
                    "code": "AGENT_UPSTREAM",
                    "message": (
                        "tower is holding "
                        f"(retry in {exc.retry_after_secs:.0f}s)"
                    ),
                },
                trace_id,
            )
        except MissingGeminiKeyError as exc:
            _LOGGER.error("(%s) model key absent: %s", trace_id, exc)
            obs.emit_error(
                trace_id=trace_id,
                code="AGENT_UPSTREAM",
                message="model key absent",
                production=body.actor,
            )
            return _json(
                500,
                {
                    "code": "AGENT_UPSTREAM",
                    "message": "agent misconfigured: model key absent",
                },
                trace_id,
            )
        except ValidationError:
            _LOGGER.warning("(%s) model returned an invalid interval", trace_id)
            return _json(
                422,
                {
                    "code": "INVALID_INTERVAL",
                    "message": "model returned end <= start",
                },
                trace_id,
            )
        except GeminiError as exc:
            _LOGGER.warning(
                "(%s) model upstream %s: %s", trace_id, exc.status_code, exc.message
            )
            return _json(
                502,
                {"code": "AGENT_UPSTREAM", "message": "model upstream failure"},
                trace_id,
            )
        except ValueError as exc:
            if "now_iso" in str(exc):
                return _json(
                    422,
                    {
                        "code": "NEEDS_CLARIFICATION",
                        "field": "now",
                        "message": "now must be TZ-aware ISO 8601",
                    },
                    trace_id,
                )
            _LOGGER.warning("(%s) model returned bad shape: %s", trace_id, exc)
            return _json(
                502,
                {"code": "AGENT_UPSTREAM", "message": "model upstream failure"},
                trace_id,
            )
        duration_s = time.monotonic() - started
        obs.emit_parse(
            trace_id=trace_id,
            duration_s=duration_s,
            confidence=parsed.confidence,
            slot_count=len(parsed.slots),
            text=body.text,
            production=body.actor,
        )

        if parsed.needs_clarification or not parsed.slots:
            if parsed.truncated:
                field = "text"
            elif parsed.unknown_resources:
                field = "resource_id"
            else:
                field = "text"
            if parsed.unknown_resources:
                message = (
                    f"unknown_resource: {', '.join(parsed.unknown_resources)}; "
                    f"did you mean {', '.join(parsed.suggestions)}?"
                )
            elif parsed.clarifications:
                message = "; ".join(parsed.clarifications)
            elif not parsed.slots:
                message = "model returned no slots; please restate the request"
            else:
                message = "needs clarification"
            obs.emit_error(
                trace_id=trace_id,
                code="NEEDS_CLARIFICATION",
                message=message[:200],
                production=body.actor,
            )
            return _json(
                422,
                {
                    "code": "NEEDS_CLARIFICATION",
                    "field": field,
                    "message": message,
                    "clarifications": list(parsed.clarifications),
                    "unknown_resources": list(parsed.unknown_resources),
                    "suggestions": list(parsed.suggestions),
                },
                trace_id,
            )

        request_id = f"req_{uuid.uuid4().hex[:12]}"
        production = body.actor.strip() or "unknown-production"
        slots: list[Slot] = []
        for index, ps in enumerate(parsed.slots):
            slots.append(
                Slot(
                    id=f"{request_id}--{ps.resource_id}--{index}",
                    production=production,
                    resource_type=ps.resource_type,
                    resource_id=ps.resource_id,
                    start=ps.start,
                    end=ps.end,
                    status="holding",
                    request_id=request_id,
                    trace_id=trace_id,
                )
            )

        try:
            store = get_slot_store()
            snapshot = SlotRegistry(store.all_slots())
        except SlotStoreUnavailable as exc:
            _LOGGER.error("(%s) snapshot unavailable: %s", trace_id, exc)
            return _json(
                503,
                {"code": "AGENT_UPSTREAM", "message": "dependency unavailable"},
                trace_id,
            )
        except RuntimeError as exc:
            _LOGGER.error("(%s) store misconfigured: %s", trace_id, exc)
            return _json(
                500,
                {"code": "AGENT_UPSTREAM", "message": "agent misconfigured"},
                trace_id,
            )

        report = check_collisions(slots, snapshot)

        if report.has_conflict:
            conflicts_out: list[dict[str, Any]] = []
            alternatives_out: list[dict[str, Any]] = []
            for conflict in report.conflicts:
                ranked: list[RankedAlternative] = rank_alternatives(
                    conflict, snapshot, limit=3
                )
                overlap = _overlap_label(
                    conflict.overlap_start, conflict.overlap_end
                )
                conflicts_out.append(
                    {
                        "resource_id": conflict.resource_id,
                        "overlap": overlap,
                        "blockedBy": conflict.blocked_by.request_id,
                    }
                )
                for alt in ranked:
                    alternatives_out.append(
                        {
                            "slot": _alternative_json(alt.slot),
                            "score": alt.score,
                            "reason": alt.reason,
                        }
                    )
                obs.emit_collision(
                    trace_id=trace_id,
                    resource=conflict.resource_id,
                    overlap=overlap,
                    blocked_by=conflict.blocked_by.request_id,
                    alternative_count=len(ranked),
                    production=production,
                )
            # Hold the requested slots (best-effort, conflicting ones
            # included) so a later reroute(request_id) resolves instead of
            # 404ing. The reroute releases the displaced same-type holds
            # once the alternative lands.
            try:
                for slot in slots:
                    ok, reason = store.hold(
                        slot, f"{body.idempotencyKey}:{slot.id}"
                    )
                    if ok:
                        obs.emit_hold(
                            trace_id=trace_id,
                            resource_id=slot.resource_id,
                            status="holding",
                            start=slot.start.isoformat(),
                            end=slot.end.isoformat(),
                            production=production,
                        )
                    else:
                        _LOGGER.info(
                            "(%s) conflict-path hold skipped %s: %s",
                            trace_id,
                            slot.id,
                            reason,
                        )
            except SlotStoreUnavailable as exc:
                _LOGGER.error("(%s) conflict-path hold failed: %s", trace_id, exc)
                return _json(
                    503,
                    {
                        "code": "AGENT_UPSTREAM",
                        "message": "dependency unavailable",
                    },
                    trace_id,
                )
            _idempotency.save(
                IdempotencyRecord(
                    key=body.idempotencyKey,
                    body_hash=body_hash,
                    response={
                        "slot_ids": ",".join(s.id for s in slots),
                        "request_id": request_id,
                        "trace_id": trace_id,
                    },
                )
            )
            return _json(
                200,
                {
                    "requestId": request_id,
                    "parsed": {
                        "slots": [
                            ps.model_dump(mode="json") for ps in parsed.slots
                        ],
                        "confidence": parsed.confidence,
                    },
                    "collision": {
                        "hasConflict": True,
                        "conflicts": conflicts_out,
                        "alternatives": alternatives_out,
                    },
                    "traceId": trace_id,
                },
                trace_id,
            )

        try:
            checked = build_checked_request(
                request_id=request_id,
                slots=slots,
                registry=snapshot,
                maintenance=InMemoryMaintenanceTable(windows=[]),
                trace_id=trace_id,
                body_hash=body_hash,
            )
        except SafetyViolation as exc:
            _LOGGER.error("(%s) forced gate refused: %s", trace_id, exc)
            obs.emit_error(
                trace_id=trace_id,
                code="AGENT_UPSTREAM",
                message="forced gate refused",
                production=production,
            )
            return _json(
                500,
                {"code": "AGENT_UPSTREAM", "message": "agent upstream failure"},
                trace_id,
            )
        try:
            held = hold_slot(
                checked,
                body.idempotencyKey,
                slot_store=store,
                idempotency_store=_idempotency,
                body=canonical,
            )
        except IdempotencyKeyReuse:
            return _json(
                422,
                {
                    "code": "IDEMPOTENCY_KEY_REUSE",
                    "message": "idempotencyKey already used with a different body",
                },
                trace_id,
            )
        except StaleAlternativeError as exc:
            _LOGGER.warning("(%s) stale hold: %s", trace_id, exc.reason)
            return _json(
                409,
                {"code": "STALE_ALTERNATIVE", "message": exc.reason},
                trace_id,
            )
        except SafetyViolation as exc:
            _LOGGER.error("(%s) hold refused: %s", trace_id, exc)
            return _json(
                500,
                {"code": "AGENT_UPSTREAM", "message": "agent upstream failure"},
                trace_id,
            )
        except SlotStoreUnavailable as exc:
            _LOGGER.error("(%s) hold unavailable: %s", trace_id, exc)
            return _json(
                503,
                {"code": "AGENT_UPSTREAM", "message": "dependency unavailable"},
                trace_id,
            )
        if held.replayed:
            record = _idempotency.lookup(body.idempotencyKey)
            replay_id = request_id
            if record is not None:
                replay_id = record.response.get("request_id", request_id)
            return _json(
                409,
                {
                    "code": "IDEMPOTENT_REPLAY",
                    "requestId": replay_id,
                    "message": "Same idempotencyKey already processed",
                },
                trace_id,
            )
        for slot in slots:
            obs.emit_hold(
                trace_id=trace_id,
                resource_id=slot.resource_id,
                status="holding",
                start=slot.start.isoformat(),
                end=slot.end.isoformat(),
                production=production,
            )
        return _json(
            200,
            {
                "requestId": request_id,
                "parsed": {
                    "slots": [ps.model_dump(mode="json") for ps in parsed.slots],
                    "confidence": parsed.confidence,
                },
                "collision": {
                    "hasConflict": False,
                    "conflicts": [],
                    "alternatives": [],
                },
                "traceId": trace_id,
            },
            trace_id,
        )
    except Exception as exc:
        return _upstream_500(trace_id, exc, "create_request")


def _reroute_sync(body: RerouteOp, trace_id: str) -> JSONResponse:
    """Run the reroute flow (sync: blocking drivers, threadpooled)."""
    try:
        key_problem = _check_key(body.idempotencyKey)
        if key_problem is not None:
            return _json(
                422,
                {"code": "IDEMPOTENCY_KEY_REUSE", "message": key_problem},
                trace_id,
            )
        if not body.requestId.strip():
            return _json(
                422,
                {
                    "code": "NEEDS_CLARIFICATION",
                    "field": "requestId",
                    "message": "requestId is required",
                },
                trace_id,
            )
        # Canonical E19 body (trace excluded, same rule as create_request).
        canonical: dict[str, Any] = {
            "requestId": body.requestId,
            "alternative": body.alternative.model_dump(
                mode="json", exclude_none=True
            ),
            "idempotencyKey": body.idempotencyKey,
            "actor": body.actor,
        }
        try:
            store = get_slot_store()
        except RuntimeError as exc:
            _LOGGER.error("(%s) store misconfigured: %s", trace_id, exc)
            return _json(
                500,
                {"code": "AGENT_UPSTREAM", "message": "agent misconfigured"},
                trace_id,
            )
        try:
            # Empty production keeps the displaced slot's production: the
            # reroute moves the SAME production, never renames it.
            moved = reroute(
                body.requestId,
                body.alternative,
                slot_store=store,
                idempotency_store=_idempotency,
                idempotency_key=body.idempotencyKey,
                body=canonical,
                production="",
                trace_id=trace_id,
            )
        except IdempotencyKeyReuse:
            return _json(
                422,
                {
                    "code": "IDEMPOTENCY_KEY_REUSE",
                    "message": "idempotencyKey already used with a different body",
                },
                trace_id,
            )
        except StaleAlternativeError as exc:
            _LOGGER.warning("(%s) stale alternative: %s", trace_id, exc.reason)
            return _json(
                409,
                {"code": "STALE_ALTERNATIVE", "message": exc.reason},
                trace_id,
            )
        except PartialRerouteFailedError as exc:
            _LOGGER.error("(%s) partial reroute: %s", trace_id, exc.reason)
            obs.emit_error(
                trace_id=trace_id,
                code="PARTIAL_REROUTE_FAILED",
                message=exc.reason[:200],
            )
            return _json(
                500,
                {"code": "PARTIAL_REROUTE_FAILED", "message": exc.reason},
                trace_id,
            )
        except SlotStoreUnavailable as exc:
            _LOGGER.error("(%s) reroute unavailable: %s", trace_id, exc)
            return _json(
                503,
                {"code": "AGENT_UPSTREAM", "message": "dependency unavailable"},
                trace_id,
            )
        except ValueError as exc:
            if "unknown request_id" in str(exc):
                _LOGGER.warning("(%s) %s", trace_id, exc)
                return _json(
                    404,
                    {"code": "UNKNOWN_REQUEST", "message": str(exc)},
                    trace_id,
                )
            raise
        new_slots: list[dict[str, Any]] = []
        try:
            for sid in moved.new_slot_ids:
                stored = store.get(sid)
                if stored is None:
                    raise RuntimeError(f"rerouted slot vanished: {sid}")
                new_slots.append(stored.model_dump(mode="json"))
        except SlotStoreUnavailable as exc:
            _LOGGER.error("(%s) reroute readback failed: %s", trace_id, exc)
            return _json(
                503,
                {"code": "AGENT_UPSTREAM", "message": "dependency unavailable"},
                trace_id,
            )
        to_resource = body.alternative.resource_id
        from_resource = "unknown"
        if moved.old_slot_ids:
            old = store.get(moved.old_slot_ids[0])
            if old is not None:
                from_resource = old.resource_id
        obs.emit_reroute(
            trace_id=trace_id,
            from_resource=from_resource,
            to_resource=to_resource,
            request_id=body.requestId,
            reason="collision",
        )
        return _json(
            200,
            {"status": "confirmed", "slots": new_slots, "traceId": trace_id},
            trace_id,
        )
    except Exception as exc:
        return _upstream_500(trace_id, exc, "reroute")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Validate DATABASE_URL + Postgres reachability (E17 fail loud)."""
    del app  # lifespan receives the app; nothing per-app to configure.
    url = _require_database_url()
    _LOGGER.info("TOWER agent starting; probing postgres")
    try:
        _fetch_rows(url, "SELECT 1", {})
    except SlotStoreUnavailable as exc:
        raise RuntimeError(f"E17: DATABASE_URL unreachable: {exc}") from exc
    _LOGGER.info("TOWER agent postgres probe ok")
    yield


app = FastAPI(title="TOWER ATC agent", version="0.1.0", lifespan=lifespan)


@app.post("/invoke")
async def invoke(request: Request) -> JSONResponse:
    """Op-dispatched entrypoint: create_request | reroute (async shell)."""
    header_trace = _header_trace(request)
    try:
        payload = await request.json()
    except Exception:
        trace_id = header_trace or _new_trace_id()
        return _json(
            422,
            {
                "code": "NEEDS_CLARIFICATION",
                "field": "body",
                "message": "request body must be valid JSON",
            },
            trace_id,
        )
    if not isinstance(payload, dict):
        trace_id = header_trace or _new_trace_id()
        return _json(
            422,
            {
                "code": "NEEDS_CLARIFICATION",
                "field": "body",
                "message": "request body must be a JSON object",
            },
            trace_id,
        )
    op = payload.get("op")
    body_trace_raw = payload.get("traceId", "")
    body_trace = body_trace_raw if isinstance(body_trace_raw, str) else ""
    if op == "create_request":
        try:
            body = CreateRequestOp.model_validate(payload)
        except ValidationError as exc:
            trace_id = _resolve_trace(header_trace, body_trace)
            status, err = _validation_error_body(exc)
            return _json(status, err, trace_id)
        trace_id = _resolve_trace(header_trace, body.traceId)
        return await run_in_threadpool(_create_request_sync, body, trace_id)
    if op == "reroute":
        try:
            reroute_body = RerouteOp.model_validate(payload)
        except ValidationError as exc:
            trace_id = _resolve_trace(header_trace, body_trace)
            status, err = _validation_error_body(exc)
            return _json(status, err, trace_id)
        trace_id = _resolve_trace(header_trace, reroute_body.traceId)
        return await run_in_threadpool(_reroute_sync, reroute_body, trace_id)
    trace_id = _resolve_trace(header_trace, body_trace)
    return _json(
        422,
        {
            "code": "NEEDS_CLARIFICATION",
            "field": "op",
            "message": "op must be create_request or reroute",
        },
        trace_id,
    )


@app.get("/slots")
def read_slots(request: Request) -> JSONResponse:
    """Day-view slots for ?date=YYYY-MM-DD (sync: threadpooled by FastAPI)."""
    trace_id = _header_trace(request) or _new_trace_id()
    raw_value = request.query_params.get("date")
    raw = raw_value.strip() if isinstance(raw_value, str) else ""
    if not _DATE_RE.match(raw):
        return _json(
            422,
            {"code": "INVALID_INTERVAL", "message": "date must be YYYY-MM-DD"},
            trace_id,
        )
    try:
        day = date.fromisoformat(raw)
    except ValueError:
        return _json(
            422,
            {"code": "INVALID_INTERVAL", "message": "date must be YYYY-MM-DD"},
            trace_id,
        )
    day_start = datetime.combine(day, dtime.min, tzinfo=timezone.utc)
    day_end = day_start + timedelta(days=1)
    try:
        try:
            store = get_slot_store()
            slots = store.slots_for_date(day_start, day_end)
        except SlotStoreUnavailable as exc:
            _LOGGER.error("(%s) slots read unavailable: %s", trace_id, exc)
            return _json(
                503,
                {"code": "AGENT_UPSTREAM", "message": "dependency unavailable"},
                trace_id,
            )
        except RuntimeError as exc:
            _LOGGER.error("(%s) store misconfigured: %s", trace_id, exc)
            return _json(
                500,
                {"code": "AGENT_UPSTREAM", "message": "agent misconfigured"},
                trace_id,
            )
        return _json(
            200,
            {
                "date": raw,
                "slots": [s.model_dump(mode="json") for s in slots],
            },
            trace_id,
        )
    except Exception as exc:
        return _upstream_500(trace_id, exc, "slots")


@app.get("/health")
def health() -> JSONResponse:
    """Liveness + Postgres probe (never throws, never leaks)."""
    try:
        try:
            url = _require_database_url()
            _fetch_rows(url, "SELECT 1", {})
        except (SlotStoreUnavailable, RuntimeError) as exc:
            _LOGGER.warning("agent health degraded: %s", exc)
            return JSONResponse(
                status_code=503,
                content={
                    "status": "degraded",
                    "code": "LOT_OPS_DEGRADED",
                    "deps": {
                        "postgres": "down",
                        "breaker": _breaker.current_state(),
                    },
                },
            )
        return JSONResponse(
            status_code=200,
            content={
                "status": "ok",
                "deps": {
                    "postgres": "up",
                    "breaker": _breaker.current_state(),
                },
            },
        )
    except Exception as exc:
        _LOGGER.exception("agent health probe failed: %s", exc)
        return JSONResponse(
            status_code=503,
            content={"status": "degraded", "code": "LOT_OPS_DEGRADED"},
        )
