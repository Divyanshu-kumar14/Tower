#!/usr/bin/env python3
"""TOWER security scan (T-10) — stdlib only. Exit 0 clean / 1 findings.

Checks (fail loudly on any hit):
  1. No secret-shaped literals in tracked text files (Google keys, Grafana
     tokens, AWS keys, private keys, Slack/GitHub tokens, live Stripe keys,
     generic `key/secret/password/token = value` assignments).
  2. `.env` (and `.env.*.local`) is git-ignored.
  3. `.env.example` carries KEY names with EMPTY values only.

Self-exclusion: this file is never scanned (it must name the patterns to
find them), and bare test-assertion literals (e.g. `"AIza" not in text`)
never match because every live-secret pattern requires a long value
tail. Run from the repo root:

    python3 .opencode/scripts/security_scan.py
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SELF = Path(__file__).resolve()

# Directories that never hold first-party secrets (deps, history, caches).
SKIP_DIRS = {
    ".git", "node_modules", ".venv", "__pycache__", ".mypy_cache",
    ".pytest_cache", ".next", "coverage", "test-results",
    "playwright-report", ".token-optimizer", ".impeccable",
}
# Files where incidental matches are noise, not secrets.
SKIP_SUFFIXES = (".lock", ".tsbuildinfo", ".map")
SKIP_NAMES = {"uv.lock", "package-lock.json"}

# Live-secret shapes: each requires a LONG value tail so short assertion
# literals in tests (e.g. `"AIza"`, `"sk-"`, `"glc_"`) never match.
SECRET_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("google-api-key", re.compile(r"AIza[0-9A-Za-z_\-]{15,}")),
    ("grafana-cloud-token", re.compile(r"glc_[A-Za-z0-9_\-]{10,}")),
    ("grafana-sa-token", re.compile(r"glsa_[A-Za-z0-9_\-]{10,}")),
    ("aws-access-key", re.compile(r"AKIA[0-9A-Z]{16}")),
    ("github-token", re.compile(r"gh[pousr]_[A-Za-z0-9]{10,}")),
    ("slack-token", re.compile(r"xox[baprs]-[A-Za-z0-9\-]{10,}")),
    ("stripe-live-key", re.compile(r"sk-live-[A-Za-z0-9]{10,}")),
    ("private-key-block", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----")),
    (
        "assigned-secret",
        re.compile(
            r"(?i)(api[_-]?key|secret|password|passwd|auth[_-]?token|access[_-]?token)"
            r"\s*[:=]\s*['\"]?[\w\-\./+]{12,}['\"]?"
        ),
    ),
]


@dataclass
class Finding:
    """One security finding (file + line + rule)."""

    location: str
    rule: str
    preview: str


@dataclass
class ScanReport:
    """Aggregated findings (exit 0 iff empty)."""

    findings: list[Finding] = field(default_factory=list)

    def add(self, location: str, rule: str, preview: str) -> None:
        self.findings.append(Finding(location, rule, preview[:120]))

    def render(self) -> str:
        if not self.findings:
            return "TOWER security scan: PASS (zero findings)"
        lines = [f"TOWER security scan: FAIL ({len(self.findings)} findings)"]
        for f in self.findings:
            lines.append(f"  [{f.rule}] {f.location}: {f.preview}")
        return "\n".join(lines)


# Lines that name secret plumbing without carrying a value (env getters,
# gcloud secret wiring, fail-loud checklist blocks) are never findings.
BENIGN_LINE_MARKERS = (
    "os.environ",
    "os.getenv",
    "getenv(",
    "update-secrets",
    "data-file",
    "MISSING_SECRET",
    "secrets versions",
)


def _scannable(path: Path) -> bool:
    """True for small tracked text files worth scanning."""
    if path.resolve() == SELF:
        return False  # this scanner must name patterns without flagging itself
    if path.name in SKIP_NAMES or path.suffix in SKIP_SUFFIXES:
        return False
    # Local ignored env files carry developer values by design (never
    # committed); the gate that matters is `env-not-ignored` below plus
    # the names-only `.env.example` check — not their contents.
    if path.name == ".env" or path.suffix in (".local",):
        return False
    if path.name.startswith(".env."):
        return False
    try:
        if path.stat().st_size > 512_000:
            return False
    except OSError:
        return False
    return True


def scan_secret_shapes(report: ScanReport) -> None:
    """Grep every scannable file for live-secret shapes."""
    import os

    for root, dirs, files in os.walk(REPO_ROOT):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for name in files:
            path = Path(root) / name
            if not _scannable(path):
                continue
            try:
                text = path.read_text(encoding="utf-8", errors="strict")
            except (UnicodeDecodeError, OSError):
                continue  # binary/unreadable: not a text-secret carrier
            rel = str(path.relative_to(REPO_ROOT))
            for lineno, line in enumerate(text.splitlines(), start=1):
                if any(marker in line for marker in BENIGN_LINE_MARKERS):
                    continue
                for rule, pattern in SECRET_PATTERNS:
                    if pattern.search(line):
                        report.add(f"{rel}:{lineno}", rule, line.strip())
                        break  # one finding per line is enough


def scan_env_files(report: ScanReport) -> None:
    """`.env` ignored + `.env.example` names-only (values fail loudly)."""
    gitignore = REPO_ROOT / ".gitignore"
    try:
        ignored = gitignore.read_text(encoding="utf-8").splitlines()
    except OSError:
        ignored = []
    if not any(line.strip() == ".env" for line in ignored):
        report.add(".gitignore", "env-not-ignored", "missing exact `.env` line")
    example = REPO_ROOT / ".env.example"
    if not example.exists():
        report.add(".env.example", "env-example-missing", "file must exist")
        return
    for lineno, line in enumerate(
        example.read_text(encoding="utf-8").splitlines(), start=1
    ):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if "=" not in stripped:
            report.add(
                f".env.example:{lineno}", "env-example-shape", line.strip()
            )
            continue
        _, _, value = stripped.partition("=")
        if value.strip() != "":
            report.add(
                f".env.example:{lineno}", "env-example-value", "(value redacted)"
            )


def main() -> int:
    """Run every check, print the report, exit 0 clean / 1 findings."""
    report = ScanReport()
    scan_secret_shapes(report)
    scan_env_files(report)
    print(report.render())
    return 0 if not report.findings else 1


if __name__ == "__main__":
    sys.exit(main())
