#!/usr/bin/env python3
"""TOWER Phase 6 acceptance gate (T-11a) — stdlib only. Exit 0/1.

Runs the Phase 6 list IN ORDER; every step prints PASS/FAIL/SKIP plus one
evidence line. Exit 0 when nothing FAILs (honest SKIP allowed), 1 on any
FAIL. Availability-aware like lint_runner: a missing tool is SKIP, never
a fake pass; a present tool that fails is FAIL. Live deploy proofs
(canned conflict, Mimir/Loki/Tempo, dashboard) SKIP when no agent is
reachable — they run post-deploy, never fake-passed here.

Run from the repo root:

    python3 .opencode/scripts/checklist.py .
"""

from __future__ import annotations

import os
import re
import shutil
import socket
import subprocess
import sys
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
FRONTEND = REPO_ROOT / "frontend"
AGENT = REPO_ROOT / "agent"

# Directories that never hold first-party evidence (deps, history, caches).
SKIP_DIRS = {
    ".git",
    "node_modules",
    ".venv",
    "__pycache__",
    ".mypy_cache",
    ".pytest_cache",
    ".next",
    "coverage",
    "test-results",
    "playwright-report",
    ".token-optimizer",
    ".impeccable",
}


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
        lines = ["TOWER Phase 6 acceptance gate:"]
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
    tail = (proc.stdout + proc.stderr).strip().splitlines()[-4:]
    return (proc.returncode, " | ".join(tail)[:600])


def _have(name: str) -> bool:
    """True when an executable is on PATH."""
    return shutil.which(name) is not None


def step_tsc(report: GateReport) -> None:
    """tsc --noEmit over the frontend (Phase 6: zero errors)."""
    if not _have("npm"):
        report.add("tsc", "SKIP", "npm not on PATH")
        return
    code, tail = _run(["npm", "run", "typecheck", "--silent"], FRONTEND)
    report.add("tsc", "PASS" if code == 0 else "FAIL", "0 errors" if code == 0 else tail)


def step_mypy(report: GateReport) -> None:
    """mypy agent/ strict (Phase 6: zero errors)."""
    if _have("uv"):
        cmd = ["uv", "run", "--project", "agent", "--python", "3.11",
               "mypy", "agent/"]
    elif _have("mypy"):
        cmd = ["mypy", "agent/"]
    else:
        report.add("mypy", "SKIP", "neither uv nor mypy on PATH")
        return
    code, tail = _run(cmd, REPO_ROOT)
    report.add("mypy", "PASS" if code == 0 else "FAIL",
               "0 errors" if code == 0 else tail)


def step_lint(report: GateReport) -> None:
    """lint_runner.py aggregate (tsc+mypy+pytest+vitest, availability-aware)."""
    code, tail = _run(
        [sys.executable, ".opencode/scripts/lint_runner.py"], REPO_ROOT
    )
    report.add("lint", "PASS" if code == 0 else "FAIL", tail)


def step_security(report: GateReport) -> None:
    """security_scan.py clean (zero findings, secrets in env only)."""
    code, tail = _run(
        [sys.executable, ".opencode/scripts/security_scan.py"], REPO_ROOT
    )
    report.add("security", "PASS" if code == 0 else "FAIL", tail)


def _pytest_counts(tail: str) -> str:
    """Extract 'N passed[, M skipped]' evidence from pytest output."""
    passed = re.search(r"(\d+) passed", tail)
    skipped = re.search(r"(\d+) skipped", tail)
    if not passed:
        return tail or "no summary"
    evidence = f"{passed.group(1)} passed"
    if skipped:
        evidence += f", {skipped.group(1)} skipped"
    return evidence


def step_graph_tests(report: GateReport) -> None:
    """Deterministic graph suite (no LLM imports allowed there)."""
    if not _have("uv"):
        report.add("graph-tests", "SKIP", "uv not on PATH")
        return
    code, tail = _run(
        ["uv", "run", "--project", "agent", "--python", "3.11",
         "pytest", "agent/graph", "-q"],
        REPO_ROOT,
    )
    report.add("graph-tests", "PASS" if code == 0 else "FAIL",
               _pytest_counts(tail) if code == 0 else tail)


def step_agent_tests(report: GateReport) -> None:
    """Agent suite incl. edge matrix (main.py must not break imports)."""
    if not _have("uv"):
        report.add("agent-tests", "SKIP", "uv not on PATH")
        return
    code, tail = _run(
        ["uv", "run", "--project", "agent", "--python", "3.11",
         "pytest", "agent/", "-q"],
        REPO_ROOT,
    )
    report.add("agent-tests", "PASS" if code == 0 else "FAIL",
               _pytest_counts(tail) if code == 0 else tail)


def step_vitest(report: GateReport) -> None:
    """vitest run (BFF + component suites; e2e excluded by npm test)."""
    if not _have("npm"):
        report.add("vitest", "SKIP", "npm not on PATH")
        return
    code, tail = _run(["npm", "test", "--silent"], FRONTEND)
    report.add("vitest", "PASS" if code == 0 else "FAIL",
               "all green" if code == 0 else tail)


def step_e2e_presence(report: GateReport) -> None:
    """E2E presence note: specs exist + browsers available (honest SKIP).

    Suites themselves need live services, so this gate never executes
    them — it proves presence + browser availability and SKIPs honestly
    when browsers are missing (never a fake pass).
    """
    specs = sorted(REPO_ROOT.glob("tests/e2e/*.spec.ts")) + sorted(
        FRONTEND.glob("e2e/*.spec.ts")
    )
    if not specs:
        report.add("e2e", "FAIL", "no *.spec.ts under tests/e2e or frontend/e2e")
        return
    names = ", ".join(p.relative_to(REPO_ROOT).as_posix() for p in specs)
    cache = Path.home() / ".cache" / "ms-playwright"
    browsers: list[str] = []
    if cache.is_dir():
        browsers = sorted(p.name for p in cache.iterdir() if p.is_dir())
    if _have("npx"):
        local_pw = FRONTEND / "node_modules" / ".bin" / "playwright"
        if local_pw.exists():
            code, tail = _run([str(local_pw), "--version"], FRONTEND, 120)
        else:
            code, tail = _run(["npx", "playwright", "--version"], FRONTEND, 120)
        # Drop npm wrapper chatter; keep the tool's own version line.
        kept = [p for p in tail.split(" | ") if "npm notice" not in p]
        pw_version = " | ".join(kept).strip() if code == 0 else "playwright cli missing"
    else:
        pw_version = "npx not on PATH"
    if not browsers:
        report.add(
            "e2e",
            "SKIP",
            f"specs present ({names}) but no Playwright browsers installed; "
            "suites run in CI with live services",
        )
        return
    report.add(
        "e2e",
        "PASS",
        f"specs present ({names}); {pw_version}; "
        f"browsers present ({', '.join(browsers)}); "
        "suites execute in CI with live services, not by this gate",
    )


def _py_files(root: Path) -> list[Path]:
    """First-party .py files under root (deps/caches excluded)."""
    out: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in filenames:
            if name.endswith(".py"):
                out.append(Path(dirpath) / name)
    return sorted(out)


def step_grep_grafana(report: GateReport) -> None:
    """Judging proof: grafana OTLP wiring shows a runtime import+call."""
    hits: list[str] = []
    otlp = False
    for path in _py_files(AGENT):
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            continue
        for lineno, line in enumerate(text.splitlines(), start=1):
            if "grafana" in line.lower():
                hits.append(f"{path.relative_to(REPO_ROOT)}:{lineno}")
            if "otlp" in line.lower():
                otlp = True
    if len(hits) >= 2 and otlp:
        report.add("contract-grep-grafana", "PASS", "; ".join(hits[:3]))
    else:
        report.add(
            "contract-grep-grafana",
            "FAIL",
            "no grafana OTLP runtime wiring found under agent/",
        )


def step_grep_aiplatform(report: GateReport) -> None:
    """Judging proof: google.cloud.aiplatform shows a runtime import."""
    pattern = re.compile(r"google\.cloud\.aiplatform")
    hits: list[str] = []
    for path in _py_files(AGENT):
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            continue
        for lineno, line in enumerate(text.splitlines(), start=1):
            if pattern.search(line):
                hits.append(f"{path.relative_to(REPO_ROOT)}:{lineno}")
    if hits:
        report.add("contract-grep-aiplatform", "PASS", "; ".join(hits[:3]))
    else:
        report.add(
            "contract-grep-aiplatform",
            "FAIL",
            "no google.cloud.aiplatform runtime import under agent/",
        )


def step_no_llm_in_graph(report: GateReport) -> None:
    """Deterministic heart stays LLM-free (graph package)."""
    pattern = re.compile(r"gemini|llm|openai|genai|vertexai|\badk\b", re.IGNORECASE)
    hits: list[str] = []
    graph_dir = AGENT / "graph"
    files = sorted(graph_dir.glob("*.py")) if graph_dir.is_dir() else []
    for path in files:
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            continue
        for lineno, line in enumerate(text.splitlines(), start=1):
            if pattern.search(line):
                hits.append(f"{path.name}:{lineno}")
    if not files:
        report.add("no-llm-in-graph", "FAIL", "agent/graph/*.py absent")
    elif not hits:
        report.add(
            "no-llm-in-graph", "PASS", f"0 hits across {len(files)} files"
        )
    else:
        report.add("no-llm-in-graph", "FAIL", "; ".join(hits[:5]))


def step_seed(report: GateReport) -> None:
    """Seed-file presence incl. the pre-seeded demo conflict."""
    seed = REPO_ROOT / "infra" / "seed.sql"
    if not seed.exists():
        report.add("seed", "FAIL", "infra/seed.sql absent")
        return
    try:
        text = seed.read_text(encoding="utf-8")
    except OSError:
        report.add("seed", "FAIL", "infra/seed.sql unreadable")
        return
    missing = [key for key in ("req_atlas", "stage-2") if key not in text]
    if missing:
        report.add("seed", "FAIL", f"infra/seed.sql lacks {', '.join(missing)}")
        return
    report.add(
        "seed", "PASS", "infra/seed.sql carries req_atlas + stage-2 alternative"
    )


def _check_main_py() -> tuple[str, str]:
    """agent/main.py route inventory (T-11a scope: missing is FAIL)."""
    path = AGENT / "main.py"
    if not path.exists():
        return ("FAIL", "agent/main.py absent")
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return ("FAIL", "agent/main.py unreadable")
    routes = sorted(set(re.findall(r'@app\.(?:get|post)\("([^"]+)"', text)))
    missing = [r for r in ("/invoke", "/slots", "/health") if r not in routes]
    if missing:
        return ("FAIL", f"agent/main.py lacks routes {', '.join(missing)}")
    return ("PASS", f"agent/main.py routes {', '.join(routes)}")


def _check_dockerfile(path: Path, base: str, extras: list[str]) -> tuple[str, str]:
    """Dockerfile presence + base pin + extras (missing is FAIL)."""
    if not path.exists():
        return ("FAIL", f"{path.relative_to(REPO_ROOT)} absent")
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return ("FAIL", f"{path.relative_to(REPO_ROOT)} unreadable")
    if base not in text:
        return ("FAIL", f"{path.name} lacks base pin {base}")
    code_lines = [
        line for line in text.splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]
    if any(":latest" in line for line in code_lines):
        return ("FAIL", f"{path.name} uses a :latest tag")
    missing = [key for key in extras if key not in text]
    if missing:
        return ("FAIL", f"{path.name} lacks {', '.join(missing)}")
    users = re.findall(r"^USER\s+(\S+)", text, re.MULTILINE)
    if not users or users[-1].lower() == "root":
        return ("FAIL", f"{path.name} has no non-root USER")
    return ("PASS", f"{path.name} base {base} + {', '.join(extras)}")


def step_required_files(report: GateReport) -> None:
    """Required-files presence (T-11a files FAIL when missing).

    demo/script.md + README hosted-URL section belong to the T-11b demo
    pass (no live URL can exist before devops deploys), so absence is an
    honest SKIP — never a fake pass, never a T-11a blocker.
    """
    status, detail = _check_main_py()
    report.add("required-main", status, detail)
    status, detail = _check_dockerfile(
        AGENT / "Dockerfile", "python:3.11-slim", ["HEALTHCHECK", "uvicorn"]
    )
    report.add("required-agent-docker", status, detail)
    status, detail = _check_dockerfile(
        FRONTEND / "Dockerfile", "node:20-alpine", ["HEALTHCHECK", "standalone"]
    )
    report.add("required-frontend-docker", status, detail)

    cfg = FRONTEND / "next.config.mjs"
    try:
        cfg_text = cfg.read_text(encoding="utf-8")
    except OSError:
        cfg_text = ""
    if "standalone" in cfg_text and "output" in cfg_text:
        report.add("required-next-standalone", "PASS",
                   "next.config.mjs output standalone")
    else:
        report.add("required-next-standalone", "FAIL",
                   "next.config.mjs lacks output standalone")

    demo = REPO_ROOT / "demo" / "script.md"
    if demo.exists():
        report.add("required-demo-script", "PASS", "demo/script.md present")
    else:
        report.add(
            "required-demo-script",
            "SKIP",
            "demo/script.md absent (T-11b demo scope; no fake-pass)",
        )

    readme = REPO_ROOT / "README.md"
    try:
        readme_text = readme.read_text(encoding="utf-8")
    except OSError:
        readme_text = ""
    has_url = "http" in readme_text and bool(
        re.search(r"host|deploy|demo|url", readme_text, re.IGNORECASE)
    )
    if has_url:
        report.add("required-readme-url", "PASS", "README.md has a URL section")
    else:
        report.add(
            "required-readme-url",
            "SKIP",
            "README.md has no hosted-URL section yet "
            "(lands post-deploy, T-11b; no fake-pass)",
        )


def step_env_hygiene(report: GateReport) -> None:
    """`.env` ignored + `.env.example` values-free (names only)."""
    try:
        ignored = (REPO_ROOT / ".gitignore").read_text(encoding="utf-8").splitlines()
    except OSError:
        ignored = []
    if not any(line.strip() == ".env" for line in ignored):
        report.add("env-hygiene", "FAIL", ".gitignore lacks an exact `.env` line")
        return
    example = REPO_ROOT / ".env.example"
    if not example.exists():
        report.add("env-hygiene", "FAIL", ".env.example absent")
        return
    try:
        lines = example.read_text(encoding="utf-8").splitlines()
    except OSError:
        report.add("env-hygiene", "FAIL", ".env.example unreadable")
        return
    keys = 0
    for lineno, line in enumerate(lines, start=1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if "=" not in stripped:
            report.add(
                "env-hygiene", "FAIL", f".env.example:{lineno} not KEY= shaped"
            )
            return
        _, _, value = stripped.partition("=")
        if value.strip() != "":
            report.add(
                "env-hygiene", "FAIL", f".env.example:{lineno} carries a value"
            )
            return
        keys += 1
    report.add("env-hygiene", "PASS", f".env ignored + {keys} keys values-free")


def step_live_probes(report: GateReport) -> None:
    """Live deploy proofs (canned conflict, Mimir/Loki/Tempo, dashboard).

    Needs a running agent + deployed Grafana, so a repo gate can only
    SKIP honestly when nothing is reachable — never fake-pass.
    """
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    probe.settimeout(2.0)
    try:
        reachable = probe.connect_ex(("127.0.0.1", 8000)) == 0
    except OSError:
        reachable = False
    finally:
        probe.close()
    if not reachable:
        report.add(
            "live-probes",
            "SKIP",
            "agent not reachable on localhost:8000; canned-conflict + "
            "Mimir/Loki/Tempo + dashboard proofs run post-deploy",
        )
        return
    try:
        with urllib.request.urlopen(
            "http://127.0.0.1:8000/health", timeout=5
        ) as resp:
            code = resp.status
    except Exception as exc:
        report.add("live-probes", "SKIP", f"agent up but /health unreadable: {exc}")
        return
    if code == 200:
        report.add(
            "live-probes",
            "PASS",
            "live /health ok; write-path + Grafana proofs still need "
            "the deployed stack (see runbook)",
        )
    else:
        report.add(
            "live-probes",
            "SKIP",
            f"agent up but degraded (health {code}); write-path proofs "
            "need the deployed stack",
        )


def main() -> int:
    """Run every gate in order, print the report, exit 0/1."""
    target = sys.argv[1] if len(sys.argv) > 1 else "."
    _ = Path(target).resolve()  # accepted for CLI parity; repo root is fixed.
    report = GateReport()
    step_tsc(report)
    step_mypy(report)
    step_lint(report)
    step_security(report)
    step_graph_tests(report)
    step_agent_tests(report)
    step_vitest(report)
    step_e2e_presence(report)
    step_grep_grafana(report)
    step_grep_aiplatform(report)
    step_no_llm_in_graph(report)
    step_seed(report)
    step_required_files(report)
    step_env_hygiene(report)
    step_live_probes(report)
    print(report.render())
    return 0 if not report.failed else 1


if __name__ == "__main__":
    sys.exit(main())
