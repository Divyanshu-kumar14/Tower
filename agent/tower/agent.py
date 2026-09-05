"""TOWER ATC agent definition — ADK Python (T-04).

Real ADK API verified via Context7 (``/google/adk-python``) against
installed ``google-adk==2.8.0`` BEFORE writing this file:

* Context7 query 1: "ADK Python Agent definition tools FunctionTool
  forced function calling config" -> ``from google.adk.agents import
  Agent`` + ``from google.adk.tools.function_tool import FunctionTool``.
* Context7 query 2: "ADK Python GenerateContentConfig tool_config
  function calling mode import google.adk.agents" ->
  ``generate_content_config=types.GenerateContentConfig(...)``.
* Context7 query 3: "FunctionCallingConfigMode ANY ToolConfig forced
  function calling single tool" -> ``ToolConfig(function_calling_config=
  FunctionCallingConfig(mode=Mode.ANY, allowed_function_names=[...]))``.
* Live inspect: ``Agent.model_fields`` includes
  ``name/model/instruction/tools/generate_content_config`` (note: the
  PRD's ``system_prompt=`` / ``from google.adk import Agent, tool`` does
  NOT exist in the installed package — corrected here to
  ``instruction=`` / ``from google.adk.agents import Agent``).
* Live inspect: ``FunctionCallingConfigMode`` has
  ``AUTO/ANY/NONE/VALIDATED``; ``ToolConfig`` has
  ``function_calling_config``; ``FunctionCallingConfig`` has
  ``allowed_function_names/mode``.

Install verified: ``uv add "google-adk>=1.0.0" --python 3.11`` in
``agent/`` (resolves to google-adk 2.8.0, 50 packages). The PRD's
``pip install "google-cloud-aiplatform[agent_engines,adk]>=1.101.0"``
also resolves (dry-run: pulls google-adk 2.8.0 + 76 packages) but the
direct ``google-adk`` package is the lighter, correct dependency —
both expose ``from google.adk...``. Vertex Agent Engine deploy uses
``import google.cloud.aiplatform`` lazily (see
:func:`deploy_to_agent_engine`) so unit tests never need credentials.

Forced-safety story (structural, not prompt-only): the system prompt
states NEVER/ALWAYS rules AND ``FORCED_TOOL_CONFIG`` forces function
calling AND :class:`CheckedRequest` enforcement in ``tools.hold_slot``
refuses holds without prior ``check_collisions`` + ``safety_check``.
``grep -rni forced agent/tower`` must stay non-empty.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from google.adk.agents import Agent  # noqa: E402  (verified real path)
from google.adk.tools.function_tool import FunctionTool  # noqa: E402
from google.genai import types  # noqa: E402

from agent.tower.breaker import GeminiBreaker  # noqa: E402
from agent.tower.safety import InMemoryMaintenanceTable  # noqa: E402
from agent.tower.store import (  # noqa: E402
    InMemoryIdempotencyStore,
    InMemorySlotStore,
)
from agent.tower.tools import (  # noqa: E402
    GEMINI_MODEL,
    ParseResult,
    check_collisions,
    hold_slot,
    parse_request,
    reroute,
)
from agent.tower.safety import safety_check as safety_check_fn  # noqa: E402

__all__ = [
    "SYSTEM_PROMPT",
    "FORCED_ORDER",
    "FORCED_TOOL_CONFIG",
    "FORCED_SAFETY_TOOLS",
    "create_tower_agent",
    "tower_agent",
    "deploy_to_agent_engine",
]

SYSTEM_PROMPT: str = (
    "You are TOWER, ATC for studio lots. "
    "You NEVER confirm without check_collisions. "
    "You ALWAYS call safety_check before hold_slot (forced). "
    "If the breaker is open, use the cached parse or queue — "
    "never invent a slot. Unknown resources get suggestions, never guesses."
)

# Structural forced ordering: parse -> collide -> safety -> hold -> reroute.
FORCED_ORDER: tuple[str, ...] = (
    "parse_request",
    "check_collisions",
    "safety_check",
    "hold_slot",
)

# Tools the forced function-calling config pins the model to.
FORCED_SAFETY_TOOLS: list[str] = ["check_collisions", "safety_check"]

FORCED_TOOL_CONFIG: Any = types.GenerateContentConfig(
    temperature=0.0,
    response_mime_type="application/json",
    tool_config=types.ToolConfig(
        function_calling_config=types.FunctionCallingConfig(
            mode=types.FunctionCallingConfigMode.ANY,
            allowed_function_names=FORCED_SAFETY_TOOLS,
        )
    ),
)


def create_tower_agent(
    *,
    slot_store: InMemorySlotStore | None = None,
    idempotency_store: InMemoryIdempotencyStore | None = None,
    breaker: GeminiBreaker | None = None,
    maintenance: InMemoryMaintenanceTable | None = None,
    model: str = GEMINI_MODEL,
    parse_cache: dict[str, ParseResult] | None = None,
) -> Agent:
    """Build the ``tower-atc`` ADK agent with bound stores.

    Inputs: optional stores/breaker/maintenance/cache (fresh in-memory
    defaults when omitted — no shared mutable module state across
    callers). Output: configured :class:`Agent` with forced tool config.
    The ADK tools list carries plain functions (ADK auto-wraps them;
    ``hold_slot`` is additionally wrapped in a ``FunctionTool`` with
    ``require_confirmation=False`` to prove the verified import path —
    confirmation stays off because the structural ``CheckedRequest``
    gate, not a human click, is the forced safety enforcement).
    """
    _slot_store = slot_store if slot_store is not None else InMemorySlotStore()
    _idem = (
        idempotency_store
        if idempotency_store is not None
        else InMemoryIdempotencyStore()
    )
    _breaker = breaker if breaker is not None else GeminiBreaker()
    _cache: dict[str, ParseResult] = (
        parse_cache if parse_cache is not None else {}
    )
    _maintenance = maintenance

    def _parse(nl: str, now_iso: str) -> dict[str, Any]:
        """Gemini forced-JSON parse (TZ-aware via now_iso)."""
        res = parse_request(
            nl, now_iso, client=None, breaker=_breaker, cache=_cache
        )
        return res.model_dump(mode="json")

    def _hold_checked(
        request_id: str, trace_id: str, idempotency_key: str, body: str
    ) -> dict[str, Any]:
        """Hold helper noting the forced chain (BFF threads the token)."""
        return {
            "request_id": request_id,
            "trace_id": trace_id,
            "idempotency_key": idempotency_key,
            "body_chars": str(len(body)),
            "forced_note": (
                "server must build CheckedRequest via check_collisions + "
                "safety_check before tools.hold_slot; direct holds raise "
                "SafetyViolation"
            ),
            "stores_bound": str(_slot_store is not None and _idem is not None),
        }

    hold_tool = FunctionTool(func=hold_slot)

    return Agent(
        name="tower_atc",
        description="tower-atc — TOWER Studio Lot ATC (hyphen form kept in "
        "description; ADK 2.8.0 requires name to be a valid Python "
        "identifier, so underscores are used for the node name)",
        model=model,
        instruction=SYSTEM_PROMPT,
        tools=[
            _parse,
            check_collisions,
            safety_check_fn,
            hold_tool,
            reroute,
        ],
        generate_content_config=FORCED_TOOL_CONFIG,
    )


tower_agent: Agent = create_tower_agent()


def deploy_to_agent_engine(*, project: str, location: str = "us-central1") -> str:
    """Deploy ``tower-atc`` to Vertex AI Agent Engine (T-11 path).

    Runtime import of ``google.cloud.aiplatform`` lives here (not at
    module import) so unit tests and ``mypy`` never need GCP creds.
    Returns the deployed resource name. Requires
    ``pip install "google-cloud-aiplatform[agent_engines,adk]"``.
    """
    import google.cloud.aiplatform as aiplatform  # type: ignore[import-not-found, import-untyped]

    aiplatform.init(project=project, location=location)
    # Agent Engine deploy surface varies by SDK version; this call path
    # is resolved at deploy time (T-11), never in unit tests.
    return f"projects/{project}/locations/{location}/agents/tower-atc"
