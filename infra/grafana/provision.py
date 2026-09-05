#!/usr/bin/env python3
"""TOWER Grafana Cloud provisioner — datasources + dashboard (T-06).

Stdlib only (``urllib``); credentials come from the environment, never
from the repo. T-11 runs this for real; T-06 verifies with ``--dry-run``
which prints the plan without any network.

Required env (names only — values in the shell / Secret Manager):

* ``GRAFANA_CLOUD_URL`` — stack URL, e.g. https://tower-xxx.grafana.net
* ``GRAFANA_STACK_API_TOKEN`` — stack service-account token (Admin) for the
  Grafana HTTP API (Administration → Service accounts). Falls back to
  ``GRAFANA_CLOUD_API_KEY`` for backwards compat, but note the Cloud
  access-policy token (``glc_...``, OTLP password) is NOT valid here —
  the stack API needs a service-account token.
* ``GRAFANA_CLOUD_OTLP_ENDPOINT`` — OTLP base (documented, not called here)
* ``GRAFANA_CLOUD_INSTANCE_ID`` — OTLP basic-auth user (documented)

Usage:
    python3 infra/grafana/provision.py --dry-run
    GRAFANA_CLOUD_URL=... GRAFANA_STACK_API_TOKEN=... \\
        python3 infra/grafana/provision.py
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DASHBOARD = REPO_ROOT / "infra" / "grafana" / "dashboard.json"

GRAFANA_URL_ENV = "GRAFANA_CLOUD_URL"
GRAFANA_API_KEY_ENV = "GRAFANA_CLOUD_API_KEY"
GRAFANA_STACK_TOKEN_ENV = "GRAFANA_STACK_API_TOKEN"
GRAFANA_INSTANCE_ENV = "GRAFANA_CLOUD_INSTANCE_ID"

DATASOURCES: list[dict[str, Any]] = [
    {
        "name": "Mimir",
        "uid": "mimir",
        "type": "prometheus",
        "access": "proxy",
        "url": "https://prometheus-prod-01-eu-west-0.grafana.net/api/prom",
        "jsonData": {"httpMethod": "POST"},
        "note": "Grafana Cloud Mimir (Prometheus) — tower_slots_total et al.",
    },
    {
        "name": "Loki",
        "uid": "loki",
        "type": "loki",
        "access": "proxy",
        "url": "https://logs-prod-006.grafana.net",
        "jsonData": {"maxLines": 1000},
        "note": 'Loki — {service="tower"} collision logs with trace_id fields.',
    },
    {
        "name": "Tempo",
        "uid": "tempo",
        "type": "tempo",
        "access": "proxy",
        "url": "https://tempo-prod-04-prod-us-central-0.grafana.net:443",
        "jsonData": {"tracesToLogsV2": {"datasourceUid": "loki"}},
        "note": "Tempo — trace_id lineage for hold/reroute spans.",
    },
]


def _fail_missing(name: str) -> int:
    print(f"MISSING_SECRET_{name}: set {name} in the environment", file=sys.stderr)
    return 2


def _grafana_request(
    base_url: str, api_key: str, method: str, path: str, payload: Any = None
) -> Any:
    """One authenticated Grafana HTTP API call (raises loudly on error)."""
    url = base_url.rstrip("/") + path
    body: bytes | None = None
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=body, method=method)
    request.add_header("Authorization", f"Bearer {api_key}")
    request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read().decode("utf-8") or "{}"
            return json.loads(raw)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:1000]
        raise RuntimeError(f"grafana api {method} {path} -> {exc.code}: {detail}") from exc


def _discover_stack_backend_urls(existing: list[dict[str, Any]]) -> dict[str, str]:
    """Map datasource type -> stack-local backend URL from built-ins.

    Prefers the exact hosted UIDs (``grafanacloud-prom`` / ``-logs`` /
    ``-traces``); falls back to the first non-usage entry of the same
    type. Skips billing/usage/alert-history entries. Returns ``{}`` when
    nothing matches (caller keeps placeholder URLs).
    """
    preferred_uid = {
        "prometheus": "grafanacloud-prom",
        "loki": "grafanacloud-logs",
        "tempo": "grafanacloud-traces",
    }
    skip_substrings = ("usage", "billing", "alert-state-history", "cardinality")
    found: dict[str, str] = {}
    by_uid = {str(i.get("uid")): i for i in existing}
    for dtype, uid in preferred_uid.items():
        item = by_uid.get(uid)
        if isinstance(item, dict) and item.get("url"):
            found[dtype] = str(item["url"])
    for item in existing:
        dtype = str(item.get("type", ""))
        if dtype not in preferred_uid or dtype in found:
            continue
        name = f"{item.get('uid', '')} {item.get('name', '')}".lower()
        if any(s in name for s in skip_substrings):
            continue
        if item.get("url"):
            found[dtype] = str(item["url"])
    return found


def upsert_datasources(
    base_url: str, api_key: str, *, dry_run: bool = False
) -> list[dict[str, Any]]:
    """Create or update the Mimir/Loki/Tempo datasources.

    Returns the datasource specs. With ``dry_run`` prints the plan and
    performs zero network calls.
    """
    if dry_run:
        print("DRY-RUN upsert_datasources:")
        for spec in DATASOURCES:
            print(f"  - {spec['uid']} ({spec['type']}): {spec['name']} -> {spec['url']}")
        print("  contact point: tower-oncall-webhook (webhook placeholder)")
        return list(DATASOURCES)
    existing: Any = _grafana_request(base_url, api_key, "GET", "/api/datasources")
    by_uid: dict[str, Any] = {}
    if isinstance(existing, list):
        for item in existing:
            if isinstance(item, dict) and item.get("uid"):
                by_uid[str(item["uid"])] = item
    # Prefer the stack's own hosted backends over the placeholder URLs in
    # DATASOURCES: a stack in ap-south-1 serves Mimir/Loki/Tempo from
    # region-local hosts, which vary per stack. Exact built-in UIDs first,
    # then first non-usage match of the same type.
    discovered = _discover_stack_backend_urls(
        [i for i in existing if isinstance(i, dict)] if isinstance(existing, list) else []
    )
    result: list[dict[str, Any]] = []
    # Backend auth for proxy queries: hosted Mimir/Loki/Tempo expect the
    # Cloud basic-auth pair (instance id + access-policy token), stored by
    # Grafana encrypted in secureJsonData (standard practice).
    backend_user = os.environ.get(GRAFANA_INSTANCE_ENV, "").strip()
    backend_password = os.environ.get(GRAFANA_API_KEY_ENV, "").strip()
    for spec in DATASOURCES:
        spec = dict(spec)
        if spec["type"] in discovered:
            spec["url"] = discovered[spec["type"]]
            print(f"resolved {spec['uid']} backend from stack: {spec['url']}")
        payload: dict[str, Any] = {
            "name": spec["name"],
            "uid": spec["uid"],
            "type": spec["type"],
            "access": spec["access"],
            "url": spec["url"],
            "jsonData": spec.get("jsonData", {}),
        }
        if backend_user and backend_password:
            payload["basicAuth"] = True
            payload["basicAuthUser"] = backend_user
            payload["secureJsonData"] = {"basicAuthPassword": backend_password}
        if spec["uid"] in by_uid:
            current_id = by_uid[spec["uid"]].get("id")
            payload["id"] = current_id
            out: Any = _grafana_request(
                base_url, api_key, "PUT", f"/api/datasources/{current_id}", payload
            )
            print(f"updated datasource {spec['uid']}: {out}")
        else:
            out = _grafana_request(base_url, api_key, "POST", "/api/datasources", payload)
            print(f"created datasource {spec['uid']}: {out}")
        result.append(spec)
    return result


def upsert_dashboard(
    base_url: str, api_key: str, dashboard_path: str, *, dry_run: bool = False
) -> dict[str, Any]:
    """Create or update the TOWER Radar dashboard from ``dashboard_path``.

    Returns the dashboard payload summary. With ``dry_run`` prints the
    plan (title, panels, alerts, metric names) without network.
    """
    path = Path(dashboard_path)
    if not path.exists():
        raise FileNotFoundError(f"dashboard not found: {path}")
    dashboard: Any = json.loads(path.read_text())
    title = str(dashboard.get("title", ""))
    panels: Any = dashboard.get("panels", [])
    alerts: Any = dashboard.get("towerAlerts", [])
    if dry_run:
        print("DRY-RUN upsert_dashboard:")
        print(f"  - file: {path}")
        print(f"  - title: {title}")
        print(f"  - panels: {len(panels)}")
        for panel in panels:
            if isinstance(panel, dict):
                print(f"    - #{panel.get('id')} {panel.get('title')} ({panel.get('type')})")
        print(f"  - alerts: {len(alerts)}")
        for alert in alerts:
            if isinstance(alert, dict):
                print(f"    - {alert.get('name')}: {alert.get('expr')}")
        contact = dashboard.get("towerContactPoint", {})
        if isinstance(contact, dict):
            print(f"  - contact point: {contact.get('name')} -> {contact.get('url')}")
        return {"title": title, "panels": len(panels), "dry_run": True}
    payload = {"dashboard": dashboard, "overwrite": True}
    out = _grafana_request(base_url, api_key, "POST", "/api/dashboards/db", payload)
    print(f"upserted dashboard {title}: {out}")
    if not isinstance(out, dict):
        return {"title": title}
    return dict(out)


def main(argv: list[str] | None = None) -> int:
    """CLI entrypoint (returns process exit code)."""
    parser = argparse.ArgumentParser(description="Provision TOWER Grafana Cloud resources")
    parser.add_argument("--dry-run", action="store_true", help="print plan, no network")
    parser.add_argument(
        "--grafana-url",
        default="",
        help="override $GRAFANA_CLOUD_URL (stack URL)",
    )
    parser.add_argument(
        "--dashboard",
        default=str(DEFAULT_DASHBOARD),
        help="path to dashboard.json",
    )
    args = parser.parse_args(argv)

    if args.dry_run:
        base_url = args.grafana_url or os.environ.get(GRAFANA_URL_ENV, "") or (
            "https://tower-xxx.grafana.net (from $GRAFANA_CLOUD_URL)"
        )
        print(f"DRY-RUN grafana provision plan for {base_url} (no network)")
        upsert_datasources(base_url, "***", dry_run=True)
        upsert_dashboard(base_url, "***", args.dashboard, dry_run=True)
        print("DRY-RUN complete: no network calls made")
        return 0

    base_url = args.grafana_url or os.environ.get(GRAFANA_URL_ENV, "").strip()
    api_key = os.environ.get(GRAFANA_STACK_TOKEN_ENV, "").strip() or os.environ.get(
        GRAFANA_API_KEY_ENV, ""
    ).strip()
    if not base_url:
        return _fail_missing(GRAFANA_URL_ENV)
    if not api_key:
        return _fail_missing(GRAFANA_STACK_TOKEN_ENV)
    upsert_datasources(base_url, api_key, dry_run=False)
    upsert_dashboard(base_url, api_key, args.dashboard, dry_run=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
