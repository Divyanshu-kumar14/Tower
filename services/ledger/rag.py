"""TOWER ledger RAG grounding stub (T-02).

Answers "why was <resource> blocked on <date>?" with a grounded BigQuery
query against `tower_ledger.slots` (table definition:
`infra/bigquery/ledger.json`).

Pattern (RAG Q&A with BigQuery): query the ledger first, then (T-04+)
verbalise strictly from the returned rows — never from model memory. There
is deliberately no LLM call in this module yet; `why_blocked` builds the
parameterised query a caller executes and grounds on.

Field names mirror contracts/slot.py Slot
{id, production, resource_type, resource_id, start, end, status,
 request_id, trace_id}; the BQ mirror stores the whole slot as a JSON
column alongside the filter/sort fields.
"""

from __future__ import annotations

import re
from typing import Final, TypedDict

BQ_DATASET: Final[str] = "tower_ledger"
BQ_TABLE: Final[str] = "slots"
BQ_TABLE_FQN: Final[str] = f"`{BQ_DATASET}.{BQ_TABLE}`"

DATE_RE: Final[str] = r"^\d{4}-\d{2}-\d{2}$"

WHY_BLOCKED_SQL: Final[str] = """\
SELECT
  request_id,
  JSON_VALUE(slot, '$.production') AS production,
  status,
  trace_id,
  JSON_VALUE(slot, '$.start') AS start,
  JSON_VALUE(slot, '$.end') AS end
FROM `tower_ledger.slots`
WHERE JSON_VALUE(slot, '$.resource_id') = @resource_id
  AND DATE(JSON_VALUE(slot, '$.start')) = @date
  AND status IN ('holding', 'confirmed')
ORDER BY start
"""


class GroundedQuery(TypedDict):
    """Parameterised BigQuery request: SQL template + named params."""

    sql: str
    params: dict[str, str]


def why_blocked(resource_id: str, date: str) -> GroundedQuery:
    """Build the grounded "why blocked?" query for a resource and date.

    Args:
        resource_id: Inventory id, e.g. "stage-3".
        date: Calendar date "YYYY-MM-DD" in UTC, e.g. "2026-09-06".

    Returns:
        SQL template plus named BigQuery parameters. Execute it, then
        answer only from the rows (production / request_id / trace_id).

    Raises:
        ValueError: On empty resource_id or a non-YYYY-MM-DD date.
    """
    if not resource_id.strip():
        raise ValueError("resource_id must not be empty")
    if re.match(DATE_RE, date) is None:
        raise ValueError(f"date must be YYYY-MM-DD, got {date!r}")
    return GroundedQuery(
        sql=WHY_BLOCKED_SQL,
        params={"resource_id": resource_id, "date": date},
    )
