"""TOWER ATC tool layer — parse / collide / safety / hold / reroute (T-04).

Ordering is STRUCTURAL, not prompt-only (the forced-safety story):

* ``parse_request`` (LLM) -> ``check_collisions`` (pure graph, no LLM)
  -> ``safety_check`` (forced gate) -> ``hold_slot`` (atomic).
* ``hold_slot`` refuses with :class:`SafetyViolation` unless the caller
  presents a validated :class:`CheckedRequest` token proving both gates
  passed for the same request. The agent threads that token through;
  the model can never fabricate it into existence because ``hold_slot``
  additionally re-validates against the live registry (E12 stale gate).
* ``reroute`` releases + holds + moves crew atomically via graph
  ``hold_cascade`` with rollback + ``PARTIAL_REROUTE_FAILED``.

``grep -rni forced agent/tower`` must stay non-empty: this file holds
the forced-ordering enforcement plus the forced-JSON Gemini path and
the forced-breaker fallback. See also ``agent.py`` (forced tool
config) and the tests (forced-ordering proofs).

Gemini sits behind an injected :class:`GeminiClient` so unit tests
inject a mock — NO real API key, NO secrets in the repo. The live
client reads ``GOOGLE_API_KEY``/``GEMINI_API_KEY`` from the environment
at call time only.
"""

from __future__ import annotations

import difflib
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Protocol

from pydantic import BaseModel, ConfigDict

_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from agent.graph.slot_graph import (  # noqa: E402
    CollisionReport,
    SlotRegistry,
    check_collisions as graph_check_collisions,
    hold_cascade as graph_hold_cascade,
    revalidate as graph_revalidate,
)
from agent.tower.breaker import (  # noqa: E402
    BreakerOpenError,
    GeminiBreaker,
    GeminiError,
)
from agent.tower.safety import (  # noqa: E402
    InMemoryMaintenanceTable,
    SafetyReport,
    SafetyViolation,
    safety_check as run_safety_check,
)
from agent.tower.store import (  # noqa: E402
    IdempotencyKeyReuse,
    IdempotencyRecord,
    IdempotencyStore,
    SlotStore,
    compute_body_hash,
)
from contracts.slot import AlternativeSlot, ParsedSlot, Slot  # noqa: E402

__all__ = [
    "MAX_NL_CHARS",
    "KNOWN_RESOURCE_IDS",
    "RESOURCE_TYPE_BY_ID",
    "GEMINI_MODEL",
    "ParseResult",
    "GeminiClient",
    "LiveGeminiClient",
    "MissingGeminiKeyError",
    "StaleAlternativeError",
    "PartialRerouteFailedError",
    "CheckedRequest",
    "HoldResult",
    "RerouteResult",
    "suggest_resources",
    "parse_request",
    "check_collisions",
    "build_checked_request",
    "hold_slot",
    "reroute",
]

MAX_NL_CHARS: int = 500
# Live Flash-tier model (verified via ListModels 2026-09-05; 1.5-flash is
# retired and 404s). Pinned without "-latest" suffix for reproducibility.
GEMINI_MODEL: str = "gemini-2.5-flash"

# Seed-catalog canonical ids (from infra/seed.sql knowledge).
KNOWN_RESOURCE_IDS: list[str] = [
    "stage-1",
    "stage-2",
    "stage-3",
    "adr-suite",
    "alexa-65",
    "alexa-mini",
    "sony-venice",
    "gfm-primavera",
    "maya",
    "jon",
    "priya",
]

RESOURCE_TYPE_BY_ID: dict[str, str] = {
    "stage-1": "stage",
    "stage-2": "stage",
    "stage-3": "stage",
    "adr-suite": "stage",
    "alexa-65": "gear",
    "alexa-mini": "gear",
    "sony-venice": "gear",
    "gfm-primavera": "gear",
    "maya": "crew",
    "jon": "crew",
    "priya": "crew",
}

_ALIAS_TO_ID: dict[str, str] = {
    "stage 1": "stage-1",
    "stage 2": "stage-2",
    "stage 3": "stage-3",
    "adr suite": "adr-suite",
    "adr": "adr-suite",
    "alexa 65": "alexa-65",
    "alexa mini": "alexa-mini",
    "sony venice": "sony-venice",
    "venice": "sony-venice",
    "gfm primavera": "gfm-primavera",
    "primavera": "gfm-primavera",
    "maya": "maya",
    "jon": "jon",
    "priya": "priya",
}


def suggest_resources(unknown: str, limit: int = 3) -> list[str]:
    """Suggest canonical ids for an unknown resource string (E05).

    Inputs: raw unknown text. Output: up to ``limit`` canonical ids —
    alias hit first, then difflib close matches, then same-type
    fallbacks. Never empty when the catalog is non-empty.
    """
    key = unknown.strip().lower().replace("_", " ").replace("-", " ")
    alias_hit = _ALIAS_TO_ID.get(key) or _ALIAS_TO_ID.get(unknown.strip().lower())
    if alias_hit is not None:
        return [alias_hit]
    close = difflib.get_close_matches(
        unknown.strip().lower(), KNOWN_RESOURCE_IDS, n=limit, cutoff=0.4
    )
    if close:
        return close[:limit]
    # Fallback: guess type by keyword, else stage alternatives.
    lowered = unknown.lower()
    if "alexa" in lowered or "sony" in lowered or "venice" in lowered:
        return ["alexa-65", "alexa-mini", "sony-venice"][:limit]
    if "maya" in lowered or "jon" in lowered or "priya" in lowered:
        return ["maya", "jon", "priya"][:limit]
    return ["stage-2", "stage-3", "stage-1"][:limit]


class ParseResult(BaseModel):
    """Structured parse output (extra=forbid, fail loudly)."""

    model_config = ConfigDict(extra="forbid")

    slots: list[ParsedSlot]
    confidence: float
    clarifications: list[str] = []
    needs_clarification: bool = False
    unknown_resources: list[str] = []
    suggestions: list[str] = []
    truncated: bool = False
    from_cache: bool = False


class GeminiClient(Protocol):
    """Injectable Gemini forced-JSON interface (mocked in tests)."""

    def generate_json(self, prompt: str) -> dict[str, Any]:
        """Return the model's forced-JSON dict for ``prompt``."""
        ...  # pragma: no cover


class MissingGeminiKeyError(RuntimeError):
    """No GOOGLE_API_KEY/GEMINI_API_KEY in the environment at call time."""


class StaleAlternativeError(ValueError):
    """Alternative went stale between check and hold (409 STALE_ALTERNATIVE)."""

    def __init__(self, reason: str) -> None:
        super().__init__(f"STALE_ALTERNATIVE: {reason}")
        self.reason: str = reason
        self.code: str = "STALE_ALTERNATIVE"


class PartialRerouteFailedError(ValueError):
    """Atomic cascade failed; registry unchanged (PARTIAL_REROUTE_FAILED)."""

    def __init__(self, reason: str) -> None:
        super().__init__(f"PARTIAL_REROUTE_FAILED: {reason}")
        self.reason: str = reason
        self.code: str = "PARTIAL_REROUTE_FAILED"


class LiveGeminiClient:
    """Live Gemini 1.5 Flash forced-JSON client (never used in tests).

    Reads ``GOOGLE_API_KEY`` (fallback ``GEMINI_API_KEY``) from the
    environment at call time — never at import, never hardcoded.
    Uses ``google.genai`` (pulled transitively by ``google-adk``);
    the import is lazy so unit tests never require credentials.
    Install: ``uv add "google-adk>=1.0.0"`` (verified 2.8.0) or
    ``pip install "google-cloud-aiplatform[agent_engines,adk]>=1.101.0"``.
    """

    def __init__(self, model: str = GEMINI_MODEL) -> None:
        self._model = model

    def generate_json(self, prompt: str) -> dict[str, Any]:
        api_key = os.environ.get("GOOGLE_API_KEY") or os.environ.get(
            "GEMINI_API_KEY"
        )
        if not api_key:
            raise MissingGeminiKeyError(
                "set GOOGLE_API_KEY (or GEMINI_API_KEY) in the environment"
            )
        try:
            from google import genai  # type: ignore[import-not-found]
            from google.genai import types  # type: ignore[import-not-found]
        except ImportError as exc:
            raise RuntimeError(
                'live Gemini needs google-adk: uv add "google-adk>=1.0.0"'
            ) from exc
        client: Any = genai.Client(api_key=api_key)
        resp: Any = client.models.generate_content(
            model=self._model,
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                temperature=0.0,
            ),
        )
        text: str = getattr(resp, "text", "") or ""
        import json as _json

        parsed: Any = _json.loads(text) if text else {}
        if not isinstance(parsed, dict):
            raise ValueError("Gemini forced-JSON did not return an object")
        return dict(parsed)


def _parse_now_iso(now_iso: str) -> datetime:
    """Parse ``now_iso``; require timezone-aware (fail loudly)."""
    try:
        dt = datetime.fromisoformat(now_iso.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"invalid now_iso: {now_iso!r}") from exc
    if dt.tzinfo is None:
        raise ValueError("now_iso must be timezone-aware (include Z/offset)")
    return dt


def _build_prompt(nl: str, now_iso: str) -> str:
    """Build the forced-JSON prompt (TZ-aware via now_iso)."""
    catalog = ", ".join(KNOWN_RESOURCE_IDS)
    return (
        "You are TOWER ATC slot parser. Return FORCED JSON only, no prose.\n"
        f"now_iso (resolve relative dates against this, TZ-aware): {now_iso}\n"
        f"known resources (use ONLY these ids): {catalog}\n"
        "Day inheritance (no floating times): the primary day is the day "
        "of the first explicitly dated window, else now_iso's day. Every "
        "slot MUST carry a full TZ-aware start+end: attach bare times to "
        "the primary day; give a dateless resource the primary day's full "
        "span (earliest start to latest end of the dated slots). Only use "
        "another day when the text names it.\n"
        "Schema: {\"slots\": [{\"resource_type\": \"stage|gear|crew\", "
        "\"resource_id\": \"<id>\", \"start\": \"<ISO TZ-aware>\", "
        "\"end\": \"<ISO TZ-aware>\"}], \"confidence\": 0.0-1.0, "
        "\"clarifications\": [\"...\"]}\n"
        f"Request: {nl}"
    )


def parse_request(
    nl: str,
    now_iso: str,
    *,
    client: GeminiClient | None = None,
    breaker: GeminiBreaker | None = None,
    cache: dict[str, ParseResult] | None = None,
) -> ParseResult:
    """Parse NL to structured slots via Gemini forced-JSON (E02/E03/E05).

    Inputs: raw ``nl`` text, TZ-aware ``now_iso`` reference.
    Outputs: :class:`ParseResult`. Normal: Gemini slots validated via
    Pydantic. Empty: ``needs_clarification`` with empty slots. Edge
    (>500 chars): truncate + ``truncated`` + ``needs_clarification``.
    Invalid: naive ``now_iso`` raises ``ValueError``. Unknown resource
    ids surface as ``unknown_resources`` + ``suggestions`` (E05).
    Breaker (E13): when the breaker is forced-open, identical-text
    cache hits return with ``from_cache=True``; misses enqueue + raise
    :class:`BreakerOpenError`. 429/5xx count toward the breaker; other
    errors propagate without tripping it.
    """
    _parse_now_iso(now_iso)
    clarifications: list[str] = []
    truncated = False
    text = nl
    if len(nl) > MAX_NL_CHARS:
        text = nl[:MAX_NL_CHARS]
        truncated = True
        clarifications.append(
            f"input truncated to {MAX_NL_CHARS} chars; "
            "please restate briefly (needs_clarification)"
        )
    if not text.strip():
        return ParseResult(
            slots=[],
            confidence=0.0,
            clarifications=["empty request: describe stage, time, gear"],
            needs_clarification=True,
            truncated=truncated,
        )

    active_breaker = breaker
    if active_breaker is not None and not active_breaker.can_execute():
        if cache is not None and text in cache:
            hit = cache[text]
            return ParseResult(
                slots=list(hit.slots),
                confidence=hit.confidence,
                clarifications=list(hit.clarifications),
                needs_clarification=hit.needs_clarification,
                unknown_resources=list(hit.unknown_resources),
                suggestions=list(hit.suggestions),
                truncated=hit.truncated,
                from_cache=True,
            )
        retry_after = active_breaker.enqueue_while_open(text)
        raise BreakerOpenError(retry_after, queued=True)

    active_client: GeminiClient = (
        client if client is not None else LiveGeminiClient()
    )
    try:
        raw = active_client.generate_json(_build_prompt(text, now_iso))
    except GeminiError as exc:
        if active_breaker is not None and (
            exc.status_code == 429 or 500 <= exc.status_code <= 599
        ):
            active_breaker.record_failure(exc.status_code)
            if cache is not None and text in cache:
                hit = cache[text]
                return ParseResult(
                    slots=list(hit.slots),
                    confidence=hit.confidence,
                    clarifications=list(hit.clarifications),
                    needs_clarification=hit.needs_clarification,
                    unknown_resources=list(hit.unknown_resources),
                    suggestions=list(hit.suggestions),
                    truncated=hit.truncated,
                    from_cache=True,
                )
        raise
    if active_breaker is not None:
        active_breaker.record_success()

    raw_slots = raw.get("slots", [])
    if not isinstance(raw_slots, list):
        raise ValueError("Gemini forced-JSON 'slots' must be a list")
    parsed_slots: list[ParsedSlot] = []
    unknown: list[str] = []
    suggestions: list[str] = []
    for entry in raw_slots:
        if not isinstance(entry, dict):
            raise ValueError("each Gemini slot must be an object")
        slot = ParsedSlot(
            resource_type=entry["resource_type"],
            resource_id=entry["resource_id"],
            start=entry["start"],
            end=entry["end"],
        )
        parsed_slots.append(slot)
        if slot.resource_id not in KNOWN_RESOURCE_IDS:
            unknown.append(slot.resource_id)
            for s in suggest_resources(slot.resource_id):
                if s not in suggestions:
                    suggestions.append(s)
    confidence_raw = raw.get("confidence", 0.0)
    try:
        confidence = float(confidence_raw)
    except (TypeError, ValueError) as exc:
        raise ValueError("Gemini 'confidence' must be numeric") from exc
    if not 0.0 <= confidence <= 1.0:
        raise ValueError("Gemini 'confidence' must be in [0, 1]")
    raw_clars = raw.get("clarifications", [])
    if raw_clars is None:
        raw_clars = []
    if not isinstance(raw_clars, list):
        raise ValueError("Gemini 'clarifications' must be a list")
    clarifications.extend(str(c) for c in raw_clars)
    needs_clar = bool(truncated) or bool(unknown) or bool(clarifications)
    if unknown:
        clarifications.append(
            f"unknown_resource: {', '.join(unknown)}; "
            f"did you mean {', '.join(suggestions)}?"
        )
    result = ParseResult(
        slots=parsed_slots,
        confidence=confidence,
        clarifications=clarifications,
        needs_clarification=needs_clar,
        unknown_resources=unknown,
        suggestions=suggestions,
        truncated=truncated,
    )
    if cache is not None:
        cache[text] = result
    return result


def check_collisions(
    slots: list[Slot], registry: SlotRegistry | None = None
) -> CollisionReport:
    """Thin deterministic wrapper over the graph (no LLM, ever).

    Inputs: candidate slots + live registry (None = empty lot).
    Output: graph :class:`CollisionReport`. This function performs no
    I/O and imports no generative-model code — the forced chain's
    collision gate.
    """
    return graph_check_collisions(slots, registry)


class CheckedRequest(BaseModel):
    """Validated token proving the forced chain passed for one request.

    Created ONLY via :func:`build_checked_request`, which requires
    ``check_collisions`` (no conflict) AND ``safety_check`` (passed)
    for the same slots. ``hold_slot`` refuses anything else with
    :class:`SafetyViolation` — this is the structural (not prompt-only)
    forced-ordering enforcement.
    """

    model_config = ConfigDict(extra="forbid")

    request_id: str
    trace_id: str
    slots: list[Slot]
    collision_passed: bool
    safety_passed: bool
    body_hash: str = ""


def build_checked_request(
    *,
    request_id: str,
    slots: list[Slot],
    registry: SlotRegistry | None = None,
    maintenance: InMemoryMaintenanceTable | None = None,
    trace_id: str = "",
    body_hash: str = "",
) -> CheckedRequest:
    """Run the forced gates and mint a :class:`CheckedRequest`.

    Raises :class:`SafetyViolation` (``FORCED_ORDER:...``) when either
    gate fails, so ``hold_slot`` can never be reached without both.
    """
    if not request_id:
        raise ValueError("request_id is required")
    live = registry if registry is not None else SlotRegistry()
    report = graph_check_collisions(slots, live)
    if report.has_conflict:
        reasons = ";".join(c.reason for c in report.conflicts)
        raise SafetyViolation(f"FORCED_ORDER:collisions-blocked:{reasons}")
    safety: SafetyReport = run_safety_check(
        slots, live, maintenance, request_id=request_id
    )
    if not safety.passed:
        raise SafetyViolation(
            f"FORCED_ORDER:safety-blocked:{';'.join(safety.violations)}"
        )
    return CheckedRequest(
        request_id=request_id,
        trace_id=trace_id,
        slots=list(slots),
        collision_passed=True,
        safety_passed=True,
        body_hash=body_hash,
    )


class HoldResult(BaseModel):
    """Outcome of :func:`hold_slot` (extra=forbid)."""

    model_config = ConfigDict(extra="forbid")

    request_id: str
    slot_ids: list[str]
    trace_id: str
    replayed: bool
    idempotency_key: str


class RerouteResult(BaseModel):
    """Outcome of :func:`reroute` (extra=forbid)."""

    model_config = ConfigDict(extra="forbid")

    request_id: str
    old_slot_ids: list[str]
    new_slot_ids: list[str]
    trace_id: str
    replayed: bool
    idempotency_key: str


def hold_slot(
    checked: CheckedRequest,
    idempotency_key: str,
    *,
    slot_store: SlotStore,
    idempotency_store: IdempotencyStore,
    body: str | bytes | dict[str, Any],
) -> HoldResult:
    """Atomically hold a validated request (forced gate enforced).

    Inputs: ``CheckedRequest`` token, request-level ``idempotency_key``,
    stores, and the raw request ``body`` for E19 hashing. Fails loudly:
    non-CheckedRequest or gates-not-passed -> ``SafetyViolation``
    (``FORCED_ORDER:...``); same key + different body ->
    ``IdempotencyKeyReuse`` (422); stale alternative (E12 re-check
    fails) -> ``StaleAlternativeError`` (409). Same key + same body ->
    replay stored result without touching the registry. Success enqueues
    the async BQ-mirror outbox inside the store (never blocks).
    """
    if not isinstance(checked, CheckedRequest):
        raise SafetyViolation(
            "FORCED_ORDER:hold_slot requires CheckedRequest "
            "(run check_collisions + safety_check first)"
        )
    if not checked.collision_passed or not checked.safety_passed:
        raise SafetyViolation(
            "FORCED_ORDER:hold_slot gates not passed for this request"
        )
    if not checked.slots:
        raise ValueError("CheckedRequest carries no slots")
    if not idempotency_key:
        raise ValueError("idempotency_key is required")
    body_hash = compute_body_hash(body)
    replayed = idempotency_store.check(idempotency_key, body_hash)
    if replayed is not None:
        return HoldResult(
            request_id=checked.request_id,
            slot_ids=[s for s in replayed.get("slot_ids", "").split(",") if s],
            trace_id=checked.trace_id,
            replayed=True,
            idempotency_key=idempotency_key,
        )
    # E12 stale gate: re-check each slot against the live registry when
    # the store exposes one (in-memory path). Postgres re-checks inside
    # its SELECT ... FOR UPDATE transaction (see store.py SQL).
    registry: SlotRegistry | None = getattr(slot_store, "registry", None)
    if registry is not None and isinstance(registry, SlotRegistry):
        for s in checked.slots:
            ok, reason = graph_revalidate(s, registry)
            if not ok:
                raise StaleAlternativeError(reason)
        ok_all, reason_all = slot_store.hold_all_atomic(
            list(checked.slots), idempotency_key
        )
        if not ok_all:
            raise StaleAlternativeError(reason_all)
    else:
        for s in checked.slots:
            per_slot_key = f"{idempotency_key}:{s.id}"
            ok, reason = slot_store.hold(s, per_slot_key)
            if not ok:
                if reason in ("IDEMPOTENT_REPLAY",):
                    continue
                raise StaleAlternativeError(reason)
    slot_ids = [s.id for s in checked.slots]
    idempotency_store.save(
        IdempotencyRecord(
            key=idempotency_key,
            body_hash=body_hash,
            response={
                "slot_ids": ",".join(slot_ids),
                "request_id": checked.request_id,
                "trace_id": checked.trace_id,
            },
        )
    )
    return HoldResult(
        request_id=checked.request_id,
        slot_ids=slot_ids,
        trace_id=checked.trace_id,
        replayed=False,
        idempotency_key=idempotency_key,
    )


def reroute(
    request_id: str,
    alternative: AlternativeSlot,
    *,
    slot_store: SlotStore,
    idempotency_store: IdempotencyStore,
    idempotency_key: str,
    body: str | bytes | dict[str, Any],
    production: str = "reroute",
    trace_id: str = "",
) -> RerouteResult:
    """Move one request to ``alternative`` atomically (E11).

    Steps: (1) E19 idempotency gate; (2) look up old slots for
    ``request_id`` (fail loudly when none); (3) build the replacement
    :class:`Slot` preserving production/trace; (4) stale re-check via
    graph ``revalidate`` (409 ``StaleAlternativeError``); (5) atomic
    hold via graph ``hold_cascade``/store (rollback +
    ``PartialRerouteFailedError`` with ``PARTIAL_REROUTE_FAILED`` on
    failure — registry unchanged); (6) release old slot(s) only after
    the new hold succeeds, so a failed reroute never strands the
    request without a stage.
    """
    if not request_id:
        raise ValueError("request_id is required")
    if not idempotency_key:
        raise ValueError("idempotency_key is required")
    body_hash = compute_body_hash(body)
    replayed = idempotency_store.check(idempotency_key, body_hash)
    if replayed is not None:
        return RerouteResult(
            request_id=request_id,
            old_slot_ids=[],
            new_slot_ids=[
                s for s in replayed.get("slot_ids", "").split(",") if s
            ],
            trace_id=trace_id,
            replayed=True,
            idempotency_key=idempotency_key,
        )
    old_slots = slot_store.slots_for_request(request_id)
    if not old_slots:
        raise ValueError(f"unknown request_id: {request_id}")
    rtype = alternative.resource_type
    if rtype is None:
        # Infer from the displaced slot when the caller omits the type.
        rtype = old_slots[0].resource_type
    new_slot = Slot(
        id=f"{request_id}--{alternative.resource_id}--reroute",
        production=production or old_slots[0].production,
        resource_type=rtype,  # type: ignore[arg-type]
        resource_id=alternative.resource_id,
        start=alternative.start,
        end=alternative.end,
        status="holding",
        request_id=request_id,
        trace_id=trace_id or old_slots[0].trace_id,
    )
    registry = getattr(slot_store, "registry", None)
    if registry is not None and isinstance(registry, SlotRegistry):
        ok, reason = graph_revalidate(new_slot, registry)
        if not ok:
            raise StaleAlternativeError(reason)
        ok_cascade, reason_cascade = graph_hold_cascade([new_slot], registry)
        if not ok_cascade:
            raise PartialRerouteFailedError(reason_cascade)
        # Mirror into the store index + outbox (registry already holds).
        if isinstance(slot_store, SlotStore):
            try:
                slot_store.hold(new_slot, f"{idempotency_key}:{new_slot.id}")
            except Exception:
                # Registry holds it; index mirror best-effort. The atomic
                # guarantee (no partial holds) already held via the
                # cascade above; surface the hold error loudly.
                raise
    else:
        ok_hold, reason_hold = slot_store.hold(
            new_slot, f"{idempotency_key}:{new_slot.id}"
        )
        if not ok_hold:
            if "OVERLAP" in reason_hold or "SEPARATION" in reason_hold:
                raise PartialRerouteFailedError(reason_hold)
            raise StaleAlternativeError(reason_hold)
    # Release displaced slots of the same resource type only after success.
    old_ids: list[str] = []
    for old in old_slots:
        if old.resource_type == new_slot.resource_type and (
            old.resource_id != new_slot.resource_id
            or old.start != new_slot.start
            or old.end != new_slot.end
        ):
            if slot_store.release(old.id):
                old_ids.append(old.id)
    idempotency_store.save(
        IdempotencyRecord(
            key=idempotency_key,
            body_hash=body_hash,
            response={
                "slot_ids": new_slot.id,
                "request_id": request_id,
                "trace_id": new_slot.trace_id,
            },
        )
    )
    return RerouteResult(
        request_id=request_id,
        old_slot_ids=old_ids,
        new_slot_ids=[new_slot.id],
        trace_id=new_slot.trace_id,
        replayed=False,
        idempotency_key=idempotency_key,
    )
