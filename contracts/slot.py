"""TOWER slot contracts — Pydantic v2 hand-mirror of contracts/api.yaml (T-01).

Field names are frozen across OpenAPI / TS / Zod / Pydantic:
{id, production, resource_type, resource_id, start, end, status, request_id, trace_id}.

Fail loudly: extra="forbid" on every model; end > start enforced
(422 INVALID_INTERVAL); datetimes must be timezone-aware UTC.
"""

from datetime import datetime
from typing import Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, ValidationInfo, field_validator

ResourceType = Literal["stage", "gear", "crew"]
SlotStatus = Literal["holding", "confirmed", "released"]
ErrorCode = Literal[
    "IDEMPOTENT_REPLAY",
    "NEEDS_CLARIFICATION",
    "STALE_ALTERNATIVE",
    "INVALID_INTERVAL",
    "IDEMPOTENCY_KEY_REUSE",
]


class Slot(BaseModel):
    """Canonical slot — mirrors OpenAPI components/schemas/Slot."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    id: str
    production: str
    resource_type: ResourceType
    resource_id: str
    start: AwareDatetime
    end: AwareDatetime
    status: SlotStatus
    request_id: str
    trace_id: str

    @field_validator("end")
    @classmethod
    def _end_after_start(cls, v: datetime, info: ValidationInfo) -> datetime:
        start = info.data.get("start")
        if isinstance(start, datetime) and v <= start:
            raise ValueError("INVALID_INTERVAL: end must be after start")
        return v


class ParsedSlot(BaseModel):
    """Parser output before hold — mirrors OpenAPI ParsedSlot."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    resource_type: ResourceType
    resource_id: str
    start: AwareDatetime
    end: AwareDatetime

    @field_validator("end")
    @classmethod
    def _end_after_start(cls, v: datetime, info: ValidationInfo) -> datetime:
        start = info.data.get("start")
        if isinstance(start, datetime) and v <= start:
            raise ValueError("INVALID_INTERVAL: end must be after start")
        return v


class AlternativeSlot(BaseModel):
    """Ranked alternative / reroute target — mirrors OpenAPI AlternativeSlot."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    resource_id: str
    resource_type: ResourceType | None = None
    start: AwareDatetime
    end: AwareDatetime

    @field_validator("end")
    @classmethod
    def _end_after_start(cls, v: datetime, info: ValidationInfo) -> datetime:
        start = info.data.get("start")
        if isinstance(start, datetime) and v <= start:
            raise ValueError("INVALID_INTERVAL: end must be after start")
        return v
