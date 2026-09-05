"""TOWER Gemini circuit breaker — E13 (T-04).

Contract: 5 consecutive Gemini 429/5xx -> open 30s, queue + fallback
cached parse for identical text; half-open probe; fake-clock testable.

Inputs: ``status_code`` on failure, ``clock`` (defaults to
:func:`time.monotonic`). Outputs: ``can_execute()`` gate + queue.
Normal: successes reset the counter. Edge: non-429/5xx errors do NOT
trip the breaker (fail loudly to caller). Invalid: negative threshold
raises ``ValueError`` at construction.

The word "forced" appears here deliberately: this breaker is part of
the forced-safety story — when the breaker is forced-open, parse calls
are forced to the cached fallback or the pending queue, never to a
live Gemini call. ``grep -rni forced agent/tower`` must stay non-empty.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from typing import Literal

__all__ = [
    "BreakerState",
    "GeminiError",
    "BreakerOpenError",
    "GeminiBreaker",
    "FAILURE_THRESHOLD",
    "OPEN_SECS",
]

BreakerState = Literal["closed", "open", "half-open"]

FAILURE_THRESHOLD: int = 5
OPEN_SECS: float = 30.0

Clock = Callable[[], float]


class GeminiError(Exception):
    """Transport error from the Gemini call.

    Carries the HTTP-ish ``status_code`` so the breaker counts only
    429/5xx (E13). Other codes (e.g. 400 validation) propagate without
    tripping the breaker.
    """

    def __init__(self, status_code: int, message: str = "") -> None:
        super().__init__(f"GeminiError {status_code}: {message}")
        self.status_code: int = status_code
        self.message: str = message


class BreakerOpenError(Exception):
    """Raised when a call is attempted while the breaker is forced-open.

    Carries ``retry_after_secs`` so callers can surface
    "Tower is holding — retry in Ns" without sleeping in-process.
    ``queued`` is True when the request text was added to the pending
    queue for replay after the half-open probe succeeds.
    """

    def __init__(self, retry_after_secs: float, *, queued: bool) -> None:
        super().__init__(f"breaker open, retry in {retry_after_secs:.1f}s")
        self.retry_after_secs: float = retry_after_secs
        self.queued: bool = queued


def _is_retryable_status(status_code: int) -> bool:
    """Return True iff the status counts toward the E13 breaker."""
    return status_code == 429 or 500 <= status_code <= 599


class GeminiBreaker:
    """Consecutive-failure circuit breaker with fake-clock support.

    State machine: closed -> open (after ``failure_threshold``
    consecutive retryable failures) -> half-open (after ``open_secs``
    elapse, single probe allowed) -> closed (probe succeeds) or open
    (probe fails, cooldown restarts).

    The pending queue holds request texts that arrived while
    forced-open so the agent can replay them after recovery instead
    of dropping user input.
    """

    def __init__(
        self,
        failure_threshold: int = FAILURE_THRESHOLD,
        open_secs: float = OPEN_SECS,
        clock: Clock | None = None,
    ) -> None:
        if failure_threshold <= 0:
            raise ValueError("failure_threshold must be > 0")
        if open_secs <= 0:
            raise ValueError("open_secs must be > 0")
        self._threshold: int = failure_threshold
        self._open_secs: float = open_secs
        self._clock: Clock = clock if clock is not None else time.monotonic
        self._failures: int = 0
        self._opened_at: float | None = None
        self._half_open_probe_in_flight: bool = False
        self._queue: list[str] = []

    @property
    def consecutive_failures(self) -> int:
        """Number of consecutive retryable failures counted so far."""
        return self._failures

    @property
    def pending_queue(self) -> list[str]:
        """Copy of texts queued while the breaker was forced-open."""
        return list(self._queue)

    def current_state(self) -> BreakerState:
        """Return the present state, advancing open -> half-open on time."""
        if self._opened_at is None:
            return "closed"
        elapsed = self._clock() - self._opened_at
        if elapsed >= self._open_secs:
            return "half-open"
        return "open"

    def time_remaining(self) -> float:
        """Seconds until the half-open probe is allowed (0 when closed)."""
        if self._opened_at is None:
            return 0.0
        remaining = self._open_secs - (self._clock() - self._opened_at)
        return max(0.0, remaining)

    def can_execute(self) -> bool:
        """Return True iff a live Gemini call is allowed right now.

        Closed -> True. Forced-open -> False. Half-open -> True exactly
        once per cooldown window (single probe); concurrent probe
        attempts return False until the in-flight probe resolves.
        """
        state = self.current_state()
        if state == "closed":
            return True
        if state == "open":
            return False
        # half-open: allow a single probe.
        if self._half_open_probe_in_flight:
            return False
        self._half_open_probe_in_flight = True
        return True

    def record_success(self) -> None:
        """Record a live-call success: reset counter, close breaker."""
        self._failures = 0
        self._opened_at = None
        self._half_open_probe_in_flight = False

    def record_failure(self, status_code: int) -> None:
        """Record a live-call failure; trip open on threshold.

        Only 429/5xx count (E13). Non-retryable codes reset the
        in-flight probe flag but leave the counter untouched.
        """
        if not _is_retryable_status(status_code):
            self._half_open_probe_in_flight = False
            return
        self._failures += 1
        self._half_open_probe_in_flight = False
        if self._failures >= self._threshold:
            self._opened_at = self._clock()

    def enqueue_while_open(self, text: str) -> float:
        """Queue ``text`` for replay; return seconds until probe allowed."""
        if text not in self._queue:
            self._queue.append(text)
        return self.time_remaining()

    def drain_queue(self) -> list[str]:
        """Remove and return all queued texts (replay after recovery)."""
        out = list(self._queue)
        self._queue.clear()
        return out
