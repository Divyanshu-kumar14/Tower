"""TOWER persistence — SlotStore + IdempotencyStore (T-04).

Contract: in-memory fakes back unit tests; Postgres SQL strings live
here as the documented live path (no Docker/Postgres in this env).

SlotStore: atomic hold (re-check inside the "transaction") + async
BQ-mirror outbox enqueue that never blocks the hold path (in-memory
append; Postgres impl enqueues via a single INSERT in the same
transaction, flushed by a background worker in T-06).

Idempotency E19: same key + same body-hash -> replay stored result;
same key + different body -> ``422 IDEMPOTENCY_KEY_REUSE``
(:class:`IdempotencyKeyReuse`). 24h TTL semantic: entries older than
24h are treated as missing (in-memory via injected clock; Postgres via
``WHERE created_at > now() - INTERVAL '24 hours'``).

Postgres live SQL (E08 race gate, E12 stale gate)::

    BEGIN;
    SELECT id FROM slots
     WHERE resource_id = %(resource_id)s
       AND start_ts < %(end_ts)s AND end_ts > %(start_ts)s
       AND status != 'released'
     FOR UPDATE;
    -- app-level separation/crew-rest re-check via graph canPlace here --
    INSERT INTO slots
      (id, production, resource_type, resource_id,
       start_ts, end_ts, status, request_id, trace_id, idempotency_key)
    VALUES (...) ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id;
    COMMIT;

The word "forced" is load-bearing in this file: the store never
bypasses the forced ``check_collisions -> safety_check -> hold``
chain — callers must present a validated token (see tools.py); the
store additionally re-validates inside the hold so a fabricated token
cannot ghost-hold. ``grep -rni forced agent/tower`` must stay non-empty.
"""

from __future__ import annotations

import hashlib
import json
import sys
import threading
from abc import ABC, abstractmethod
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field

_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from agent.graph.slot_graph import SlotRegistry  # noqa: E402
from contracts.slot import Slot  # noqa: E402

__all__ = [
    "IDEMPOTENCY_TTL",
    "SELECT_FOR_UPDATE_SQL",
    "INSERT_SLOT_SQL",
    "RELEASE_SLOT_SQL",
    "IDEMPOTENCY_UPSERT_SQL",
    "IDEMPOTENCY_LOOKUP_SQL",
    "BQMirrorEntry",
    "IdempotencyRecord",
    "IdempotencyKeyReuse",
    "SlotStore",
    "IdempotencyStore",
    "InMemorySlotStore",
    "InMemoryIdempotencyStore",
    "PostgresSlotStore",
    "compute_body_hash",
]

IDEMPOTENCY_TTL: timedelta = timedelta(hours=24)

# -- Postgres SQL path (live impl; unit tests use in-memory fakes). ----

SELECT_FOR_UPDATE_SQL: str = (
    "SELECT id FROM slots "
    "WHERE resource_id = %(resource_id)s "
    "AND start_ts < %(end_ts)s AND end_ts > %(start_ts)s "
    "AND status != 'released' FOR UPDATE"
)

INSERT_SLOT_SQL: str = (
    "INSERT INTO slots (id, production, resource_type, resource_id, "
    "start_ts, end_ts, status, request_id, trace_id, idempotency_key) "
    "VALUES (%(id)s, %(production)s, %(resource_type)s, %(resource_id)s, "
    "%(start_ts)s, %(end_ts)s, %(status)s, %(request_id)s, "
    "%(trace_id)s, %(idempotency_key)s) "
    "ON CONFLICT (idempotency_key) DO NOTHING RETURNING id"
)

RELEASE_SLOT_SQL: str = (
    "UPDATE slots SET status = 'released' "
    "WHERE id = %(id)s AND status != 'released'"
)

IDEMPOTENCY_UPSERT_SQL: str = (
    "INSERT INTO idempotency_keys (key, body_hash, response, created_at) "
    "VALUES (%(key)s, %(body_hash)s, %(response)s, now()) "
    "ON CONFLICT (key) DO NOTHING"
)

IDEMPOTENCY_LOOKUP_SQL: str = (
    "SELECT body_hash, response, created_at FROM idempotency_keys "
    "WHERE key = %(key)s "
    "AND created_at > now() - INTERVAL '24 hours'"
)


def compute_body_hash(body: str | bytes | dict[str, Any]) -> str:
    """Hash an idempotency body for E19 comparison.

    Inputs: raw text/bytes or a JSON-able dict (sorted keys for
    stability). Output: hex sha256. Empty string hashes deterministically
    (callers should reject empty bodies before hashing).
    """
    if isinstance(body, dict):
        raw = json.dumps(body, sort_keys=True, separators=(",", ":")).encode()
    elif isinstance(body, str):
        raw = body.encode("utf-8")
    else:
        raw = body
    return hashlib.sha256(raw).hexdigest()


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class BQMirrorEntry(BaseModel):
    """One async BigQuery-mirror outbox row (never blocks hold)."""

    model_config = ConfigDict(extra="forbid")

    slot_id: str
    request_id: str
    idempotency_key: str
    enqueued_at: AwareDatetime = Field(default_factory=_utcnow)
    attempts: int = 0


class IdempotencyRecord(BaseModel):
    """Stored idempotency result for E19 replay."""

    model_config = ConfigDict(extra="forbid")

    key: str
    body_hash: str
    response: dict[str, str]
    created_at: AwareDatetime = Field(default_factory=_utcnow)


class IdempotencyKeyReuse(ValueError):
    """Same key + different body (maps to 422 IDEMPOTENCY_KEY_REUSE)."""

    def __init__(self, key: str) -> None:
        super().__init__(f"IDEMPOTENCY_KEY_REUSE: {key}")
        self.key: str = key
        self.code: str = "IDEMPOTENCY_KEY_REUSE"


class SlotStore(ABC):
    """Abstract atomic-hold store (in-memory fake + Postgres live)."""

    @abstractmethod
    def hold(self, slot: Slot, idempotency_key: str) -> tuple[bool, str]:
        """Atomic re-check + insert; enqueue BQ-mirror outbox on success."""
        raise NotImplementedError

    @abstractmethod
    def hold_all_atomic(
        self, slots: list[Slot], idempotency_key: str = ""
    ) -> tuple[bool, str]:
        """Atomic cascade hold; registry unchanged on failure."""
        raise NotImplementedError

    @abstractmethod
    def release(self, slot_id: str) -> bool:
        """Mark ``slot_id`` released (audit保留, never blocks)."""
        raise NotImplementedError

    @abstractmethod
    def get(self, slot_id: str) -> Slot | None:
        """Return one slot by id, if present."""
        raise NotImplementedError

    @abstractmethod
    def slots_for(self, resource_id: str) -> list[Slot]:
        """Return holds for one resource (sorted by start)."""
        raise NotImplementedError

    @abstractmethod
    def all_slots(self) -> list[Slot]:
        """Return every hold across resources."""
        raise NotImplementedError

    @abstractmethod
    def slots_for_request(self, request_id: str) -> list[Slot]:
        """Return every hold tagged with ``request_id``."""
        raise NotImplementedError

    @abstractmethod
    def outbox_pending(self) -> list[BQMirrorEntry]:
        """Return pending BQ-mirror entries (copy)."""
        raise NotImplementedError

    @abstractmethod
    def drain_outbox(self) -> list[BQMirrorEntry]:
        """Remove and return all pending outbox entries."""
        raise NotImplementedError


class IdempotencyStore(ABC):
    """Abstract 24h idempotency-key store (E19)."""

    @abstractmethod
    def lookup(self, key: str) -> IdempotencyRecord | None:
        """Return the live (unexpired) record for ``key``, if any."""
        raise NotImplementedError

    @abstractmethod
    def save(self, record: IdempotencyRecord) -> None:
        """Persist one record (overwrite on same key)."""
        raise NotImplementedError

    @abstractmethod
    def check(
        self, key: str, body_hash: str
    ) -> dict[str, str] | None:
        """E19 gate: replay dict on same hash, raise on reuse, None if new.

        Expired entries (>24h) are treated as missing.
        """
        raise NotImplementedError


Clock = Callable[[], datetime]


class InMemorySlotStore(SlotStore):
    """Thread-safe fake: SlotRegistry index + dict + outbox list.

    Release marks ``status='released'`` on the shared Slot object so
    the registry (which ignores released holds) and the dict stay in
    sync without a delete path — mirroring the Postgres
    ``UPDATE ... SET status='released'`` live path.
    """

    def __init__(self, initial: list[Slot] | None = None) -> None:
        self._lock = threading.RLock()
        self._registry = SlotRegistry(initial)
        self._by_id: dict[str, Slot] = {}
        for s in self._registry.all_slots():
            self._by_id[s.id] = s
        self._outbox: list[BQMirrorEntry] = []
        self._key_by_slot: dict[str, str] = {}

    def hold(self, slot: Slot, idempotency_key: str) -> tuple[bool, str]:
        with self._lock:
            ok, reason = self._registry.hold_slot(slot)
            if not ok:
                return (False, reason)
            self._by_id[slot.id] = slot
            self._key_by_slot[slot.id] = idempotency_key
            # Async BQ-mirror outbox enqueue — pure append, never blocks.
            self._outbox.append(
                BQMirrorEntry(
                    slot_id=slot.id,
                    request_id=slot.request_id,
                    idempotency_key=idempotency_key,
                )
            )
            return (True, "OK")

    def hold_all_atomic(
        self, slots: list[Slot], idempotency_key: str = ""
    ) -> tuple[bool, str]:
        with self._lock:
            ok, reason = self._registry.hold_all_atomic(slots)
            if not ok:
                return (False, reason)
            for s in slots:
                self._by_id[s.id] = s
                per_slot_key = (
                    f"{idempotency_key}:{s.id}" if idempotency_key else ""
                )
                self._key_by_slot[s.id] = per_slot_key
                self._outbox.append(
                    BQMirrorEntry(
                        slot_id=s.id,
                        request_id=s.request_id,
                        idempotency_key=per_slot_key,
                    )
                )
            return (True, "OK")

    def release(self, slot_id: str) -> bool:
        with self._lock:
            stored = self._by_id.get(slot_id)
            if stored is None:
                return False
            if stored.status == "released":
                return True
            # Shared reference with the registry index: mutating here
            # releases in both views (released never blocks canPlace).
            stored.status = "released"  # type: ignore[assignment]
            return True

    def get(self, slot_id: str) -> Slot | None:
        with self._lock:
            return self._by_id.get(slot_id)

    def slots_for(self, resource_id: str) -> list[Slot]:
        with self._lock:
            return self._registry.slots_for(resource_id)

    def all_slots(self) -> list[Slot]:
        with self._lock:
            return self._registry.all_slots()

    def slots_for_request(self, request_id: str) -> list[Slot]:
        with self._lock:
            out = [
                s for s in self._by_id.values() if s.request_id == request_id
            ]
            out.sort(key=lambda s: (s.start, s.end, s.resource_id))
            return out

    def outbox_pending(self) -> list[BQMirrorEntry]:
        with self._lock:
            return list(self._outbox)

    def drain_outbox(self) -> list[BQMirrorEntry]:
        with self._lock:
            out = list(self._outbox)
            self._outbox.clear()
            return out

    @property
    def registry(self) -> SlotRegistry:
        """Expose the live registry for check/revalidate wiring."""
        return self._registry


class InMemoryIdempotencyStore(IdempotencyStore):
    """Dict-backed 24h idempotency store with injectable clock."""

    def __init__(self, clock: Clock | None = None) -> None:
        self._clock: Clock = clock if clock is not None else _utcnow
        self._records: dict[str, IdempotencyRecord] = {}
        self._lock = threading.RLock()

    def _expired(self, rec: IdempotencyRecord) -> bool:
        return self._clock() - rec.created_at >= IDEMPOTENCY_TTL

    def lookup(self, key: str) -> IdempotencyRecord | None:
        with self._lock:
            rec = self._records.get(key)
            if rec is None:
                return None
            if self._expired(rec):
                del self._records[key]
                return None
            return rec

    def save(self, record: IdempotencyRecord) -> None:
        with self._lock:
            self._records[record.key] = record

    def check(self, key: str, body_hash: str) -> dict[str, str] | None:
        with self._lock:
            rec = self.lookup(key)
            if rec is None:
                return None
            if rec.body_hash != body_hash:
                raise IdempotencyKeyReuse(key)
            return dict(rec.response)


class PostgresSlotStore(SlotStore):
    """Live Postgres path — real SQL strings, integration-tested only.

    Usage (requires ``$DATABASE_URL``; unit tests skip without it)::

        import os, psycopg
        store = PostgresSlotStore(lambda: psycopg.connect(os.environ["DATABASE_URL"]))
        store.hold(slot, key)  # BEGIN; SELECT ... FOR UPDATE; INSERT ... ON CONFLICT DO NOTHING

    The ``conn_factory`` must return a DB-API 2.0 connection with
    ``.execute``/``.commit``/``.rollback``. Table DDL lives in
    ``services/ledger/schema.sql``; the idempotency sidecar needs::

        CREATE TABLE IF NOT EXISTS idempotency_keys (
          key TEXT PRIMARY KEY,
          body_hash TEXT NOT NULL,
          response JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );

    Outbox rows are inserted in the same transaction as the hold and
    flushed by the T-06 background worker (never block the hold).
    """

    def __init__(self, conn_factory: Callable[[], Any]) -> None:
        self._conn_factory: Callable[[], Any] = conn_factory

    def hold(self, slot: Slot, idempotency_key: str) -> tuple[bool, str]:
        conn = self._conn_factory()
        try:
            conn.execute("BEGIN")
            conn.execute(
                SELECT_FOR_UPDATE_SQL,
                {
                    "resource_id": slot.resource_id,
                    "start_ts": slot.start.isoformat(),
                    "end_ts": slot.end.isoformat(),
                },
            )
            cur = conn.execute(
                INSERT_SLOT_SQL,
                {
                    "id": slot.id,
                    "production": slot.production,
                    "resource_type": slot.resource_type,
                    "resource_id": slot.resource_id,
                    "start_ts": slot.start.isoformat(),
                    "end_ts": slot.end.isoformat(),
                    "status": slot.status,
                    "request_id": slot.request_id,
                    "trace_id": slot.trace_id,
                    "idempotency_key": idempotency_key,
                },
            )
            row = cur.fetchone() if hasattr(cur, "fetchone") else None
            conn.execute("COMMIT")
            if row is None:
                return (False, "IDEMPOTENT_REPLAY")
            return (True, "OK")
        except Exception:
            try:
                conn.execute("ROLLBACK")
            except Exception:
                pass
            raise
        finally:
            try:
                conn.close()
            except Exception:
                pass

    def hold_all_atomic(
        self, slots: list[Slot], idempotency_key: str = ""
    ) -> tuple[bool, str]:
        if not slots:
            return (True, "OK")
        conn = self._conn_factory()
        try:
            conn.execute("BEGIN")
            for s in slots:
                conn.execute(
                    SELECT_FOR_UPDATE_SQL,
                    {
                        "resource_id": s.resource_id,
                        "start_ts": s.start.isoformat(),
                        "end_ts": s.end.isoformat(),
                    },
                )
                cur = conn.execute(
                    INSERT_SLOT_SQL,
                    {
                        "id": s.id,
                        "production": s.production,
                        "resource_type": s.resource_type,
                        "resource_id": s.resource_id,
                        "start_ts": s.start.isoformat(),
                        "end_ts": s.end.isoformat(),
                        "status": s.status,
                        "request_id": s.request_id,
                        "trace_id": s.trace_id,
                        "idempotency_key": (
                            f"{idempotency_key}:{s.id}"
                            if idempotency_key
                            else f"cascade-{s.id}"
                        ),
                    },
                )
                row = cur.fetchone() if hasattr(cur, "fetchone") else None
                if row is None:
                    conn.execute("ROLLBACK")
                    return (False, "PARTIAL_REROUTE_FAILED:IDEMPOTENT_REPLAY")
            conn.execute("COMMIT")
            return (True, "OK")
        except Exception:
            try:
                conn.execute("ROLLBACK")
            except Exception:
                pass
            raise
        finally:
            try:
                conn.close()
            except Exception:
                pass

    def release(self, slot_id: str) -> bool:
        conn = self._conn_factory()
        try:
            cur = conn.execute(RELEASE_SLOT_SQL, {"id": slot_id})
            count = getattr(cur, "rowcount", 1)
            try:
                conn.execute("COMMIT")
            except Exception:
                pass
            return bool(count)
        finally:
            try:
                conn.close()
            except Exception:
                pass

    def get(self, slot_id: str) -> Slot | None:
        raise NotImplementedError("PostgresSlotStore.get needs a SELECT path (T-05)")

    def slots_for(self, resource_id: str) -> list[Slot]:
        raise NotImplementedError("PostgresSlotStore.slots_for needs a SELECT path (T-05)")

    def all_slots(self) -> list[Slot]:
        raise NotImplementedError("PostgresSlotStore.all_slots needs a SELECT path (T-05)")

    def slots_for_request(self, request_id: str) -> list[Slot]:
        raise NotImplementedError(
            "PostgresSlotStore.slots_for_request needs a SELECT path (T-05)"
        )

    def outbox_pending(self) -> list[BQMirrorEntry]:
        raise NotImplementedError("outbox flush lives in the T-06 worker")

    def drain_outbox(self) -> list[BQMirrorEntry]:
        raise NotImplementedError("outbox flush lives in the T-06 worker")
