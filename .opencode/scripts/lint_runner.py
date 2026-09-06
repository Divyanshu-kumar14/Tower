#!/usr/bin/env python3
"""TOWER lint gate (T-10) — stdlib only. Exit 0 clean / 1 findings.

Aggregates tsc + mypy + pytest + vitest, availability-aware: a missing
tool is reported as SKIP (never a fake pass). A present tool that fails
is a finding. Run from the repo root:

    python3 .opencode/scripts/lint_runner.py
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
FRONTEND = REPO_ROOT / "frontend"
AGENT = REPO_ROOT / "agent"


@dataclass
class GateResult:
    """Outcome of one gate step."""

    name: str
    status: str  # "PASS" | "FAIL" | "SKIP"
    detail: str = ""


@dataclass
class GateReport:
    """Aggregated gate outcomes (exit 0 iff no FAIL)."""

    results: list[GateResult] = field(default_factory=list)

    def add(self, name: str, status: str, detail: str = "") -> None:
        self.results.append(GateResult(name, status, detail))

    @property
    def failed(self) -> list[GateResult]:
        return [r for r in self.results if r.status == "FAIL"]

    def render(self) -> str:
        lines = ["TOWER lint gate:"]
        for r in self.results:
            extra = f" — {r.detail}" if r.detail else ""
            lines.append(f"  [{r.status}] {r.name}{extra}")
        if self.failed:
            lines.append(f"RESULT: FAIL ({len(self.failed)} findings)")
        else:
            lines.append("RESULT: PASS")
        return "\n".join(lines)


def _run(cmd: list[str], cwd: Path, timeout_s: int = 600) -> tuple[int, str]:
    """Run cmd, returning (returncode, tail of combined output)."""
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(cwd),
            capture_output=True,
            text=True,
            timeout=timeout_s,
        )
    except FileNotFoundError:
        return (127, "executable not found")
    except subprocess.TimeoutExpired:
        return (1, f"timed out after {timeout_s}s")
    tail = (proc.stdout + proc.stderr).strip().splitlines()[-15:]
    return (proc.returncode, " | ".join(tail)[:2000])


def _have(*names: str) -> str | None:
    """Return the first available executable path, else None."""
    for name in names:
        found = shutil.which(name)
        if found:
            return found
    return None


def gate_tsc(report: GateReport) -> None:
    """tsc --noEmit over the frontend (T-01 contract, zero errors)."""
    if _have("npm") is None:
        report.add("tsc", "SKIP", "npm not on PATH")
        return
    if not (FRONTEND / "package.json").exists():
        report.add("tsc", "SKIP", "frontend/package.json absent")
        return
    code, tail = _run(["npm", "run", "typecheck", "--silent"], FRONTEND)
    report.add("tsc", "PASS" if code == 0 else "FAIL", tail if code else "0 errors")


def gate_mypy(report: GateReport) -> None:
    """mypy agent/ (strict per agent/pyproject.toml)."""
    if _have("mypy") is None and _have("uv") is None:
        report.add("mypy", "SKIP", "neither mypy nor uv on PATH")
        return
    if _have("mypy") is not None:
        code, tail = _run(["mypy", "agent/"], REPO_ROOT)
    else:
        code, tail = _run(
            ["uv", "run", "--project", "agent", "--python", "3.11", "mypy", "agent/"],
            REPO_ROOT,
        )
    report.add("mypy", "PASS" if code == 0 else "FAIL", tail if code else "0 errors")


def gate_pytest(report: GateReport) -> None:
    """pytest tests/ agent/ (T-10 edge matrix + graph + tools + emitter)."""
    runner: list[str] | None = None
    if _have("uv") is not None:
        runner = ["uv", "run", "--project", "agent", "--python", "3.11",
                  "pytest", "tests/", "agent/", "-q"]
    elif _have("pytest", "python3") is not None:
        runner = ["python3", "-m", "pytest", "tests/", "agent/", "-q"]
    if runner is None:
        report.add("pytest", "SKIP", "neither uv nor pytest on PATH")
        return
    code, tail = _run(runner, REPO_ROOT)
    report.add("pytest", "PASS" if code == 0 else "FAIL", tail)


def gate_vitest(report: GateReport) -> None:
    """vitest run (BFF + component suites, e2e excluded by npm test)."""
    if _have("npm") is None:
        report.add("vitest", "SKIP", "npm not on PATH")
        return
    code, tail = _run(["npm", "test", "--silent"], FRONTEND)
    report.add("vitest", "PASS" if code == 0 else "FAIL", tail if code else "all green")


def main() -> int:
    """Run every gate, print the report, exit 0 clean / 1 findings."""
    report = GateReport()
    gate_tsc(report)
    gate_mypy(report)
    gate_pytest(report)
    gate_vitest(report)
    print(report.render())
    return 0 if not report.failed else 1


if __name__ == "__main__":
    sys.exit(main())
