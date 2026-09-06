# TOWER on the beast (T-11b) — ampere-beast (Oracle ARM64, 132.226.187.232)

Live URL: **http://132.226.187.232:3100**

## Topology

```
internet ──:3100──▶ frontend (Next.js standalone, node:20-alpine)
                        │ AGENT_BASE_URL=http://agent:8000 (compose DNS)
                        ▼
                     agent (FastAPI, python:3.11-slim) ──▶ postgres:16-alpine
                        │                                     ▲ DATABASE_URL
                        │                                     │ (host `postgres`)
                        └──── redis:7-alpine (reserved: T-11 event bus)
```

All four services sit on the isolated `tower-net` bridge under compose
project name **`tower`**. Host-published ports: **only frontend `:3100`**.
Agent (8000), postgres (5432) and redis (6379) expose container ports only —
no host bindings — so Traefik (`:80/:443/:8080`) and Coolify (`:8000`
host-mapped) never collide.

## Ports

| Endpoint                 | What              | Expected            |
|--------------------------|-------------------|---------------------|
| `:3100/`                 | frontend (radar)  | 200, radar UI       |
| `:3100/api/health`       | BFF health        | 200 `status:"ok"`   |
| `:3100/api/requests`     | NL → conflict     | POST, see demo      |
| `:3100/api/reroute`      | reroute & hold    | POST, see demo      |
| `:3100/api/slots?date=`  | day view          | GET, slot list      |
| (internal) `agent:8000/health` | agent liveness + pg probe | 200 (503 = pg down) |

## Secret layout (mandatory discipline)

Values are NEVER printed, echoed, or committed. Local `.env` holds real
keys (git-ignored — `.gitignore` carries the exact `.env` line; verify with
`git check-ignore .env`).

Remote env file build (all local, values never shown):

1. `python3 - <<'EOF'` reads local `.env` keys, generates a fresh
   `openssl rand -hex 24` postgres password, writes `/tmp/tower-beast.env`
   mode `0600` with key=value lines:
   `POSTGRES_DB=tower`, `POSTGRES_USER=tower`, `POSTGRES_PASSWORD=<fresh>`,
   `DATABASE_URL=postgresql://tower:<fresh>@postgres:5432/tower`
   (password MUST match `POSTGRES_PASSWORD`, host MUST be the compose
   service name `postgres`), plus `GOOGLE_API_KEY` and
   `GRAFANA_CLOUD_OTLP_ENDPOINT` / `GRAFANA_CLOUD_INSTANCE_ID` /
   `GRAFANA_CLOUD_API_KEY` / `GRAFANA_CLOUD_URL` /
   `GRAFANA_STACK_API_TOKEN` copied from local `.env` without printing.
2. `scp /tmp/tower-beast.env ubuntu@132.226.187.232:/opt/tower/.env`
   (after `ssh … 'sudo mkdir -p /opt/tower'`), remote `chmod 600`,
   verify key NAMES only (`cut -d= -f1`), then `shred -u` the local copy.

Compose references the file via `env_file` on postgres/agent/frontend.
`environment:` carries only non-secret wiring (`AGENT_BASE_URL`,
`AGENT_TIMEOUT_MS`) — never literals of secrets.

## Deploy sequence (as run)

Preflight (obey the SRE dossier — HIGH blast radius, control plane
untouched): `free -h` / `df -h /` / `docker ps` (8 control-plane
containers: traefik, coolify, coolify-db, coolify-redis, coolify-realtime,
coolify-sentinel, ollama, uptime-kuma) / port `:3100` free / `docker
system df`.

1. Copy repo WITHOUT build artefacts (never `node_modules/`, `.venv/`):
   `tar czf - --exclude=node_modules --exclude=.venv --exclude=.git … | ssh … 'tar xzf -'`.
2. `scp` the env file (above). Build SEQUENTIALLY (RAM watch):
   `docker compose … build postgres` (pull only), then `build agent`,
   then `build frontend`.
3. `docker compose --project-name tower up -d`, wait for
   `service_healthy` gates (postgres → agent → frontend).
4. Seed IN ORDER via compose exec (assert `stages=4`, `req_atlas=1`):
   `services/inventory/schema.sql` → `services/ledger/schema.sql` →
   `infra/seed.sql`.
5. Health: agent `/health` 200 through no public port (exec/curl from the
   frontend net), frontend `/api/health` 200 from the laptop.
6. Live 60s demo flow via curl against `:3100` — full transcript in
   `demo/script.md` (submit canned text → `hasConflict:true` + Stage-2
   alternative → reroute → `confirmed` + trace → slots show the hold).

## Rollback

- Code/config: `docker compose -f infra/beast/docker-compose.yml
  --project-name tower down` (stops in reverse dependency order:
  frontend → agent → redis → postgres). Images stay tagged
  `tower-agent:beast` / `tower-frontend:beast`; before any rebuild, keep
  the last-good tags: `docker tag tower-agent:beast tower-agent:prev`
  (same for frontend) so rollback is `down` → `tag …:prev …:beast` →
  `up -d` with zero rebuild.
- Data: `tower-pgdata` is a NAMED volume — plain `down` preserves it.
  NEVER `down -v` / `volume rm` (same caution as `rm -rf`); that deletes
  the ledger. To re-seed from scratch instead: exec `psql` TRUNCATE +
  re-apply the three SQL files (they are `IF NOT EXISTS` /
  `ON CONFLICT DO NOTHING` safe).
- Control plane: untouched by design — no `traefik` / `coolify*`
  container or volume is ever stopped, restarted, or pruned by any tower
  command (project name `tower` isolates `ps/down/logs`).

## Ops notes

- ARM64 only: `postgres:16-alpine`, `redis:7-alpine`,
  `python:3.11-slim`, `node:20-alpine` are all official multi-arch —
  no x86-only layers. No `:latest` anywhere (checklist FAILs on it).
- Frontend builds from `infra/beast/Dockerfile.frontend`, NOT
  `frontend/Dockerfile` (sole delta: `npm ci --legacy-peer-deps` —
  npm 10 on node:20 ERESOLVEs the vitest/`@types/node` peer conflict in
  the committed lockfile; the lock still pins the exact tree). `frontend/`
  itself is untouched per the T-11b packet; revert the compose pointer and
  delete the shim once frontend resolves the peers (header in the file).
- Oracle has TWO firewall layers (OS + VCN security list). OBSERVED
  2026-09-06: `:3100` binds `0.0.0.0` and returns 200 on-box and over
  Tailscale, but public inbound times out — as do long-standing public
  ports (`:80`, `:3002`, `:8000`) from the operator network — while the OS
  `INPUT` policy is ACCEPT. Verdict: the VCN security list is the blocker.
  Fix (OCI console only — no `oci` CLI/credentials on either end): VCN
  ingress allow **TCP 3100 from 0.0.0.0/0**. No SSH action can substitute.
- Frontend `/api/health` is 503 `LOT_OPS_DEGRADED` (reads-only) when
  `DATABASE_URL` is absent — with the shared `env_file` it reports ok.
- Auth posture (orchestrator decision, verbatim): header-actor mode stays
  for the hackathon demo surface; F-AUTH-01 (`verified:true` lockdown)
  is accepted risk until Google login lands post-hackathon — see
  `docs/SECURITY_AUDIT.md`.
- Ghost-hold janitor (T-11a suggestion): NOT implemented — recorded as
  follow-up. `revalidate()` (`agent/graph/slot_graph.py`) already blocks
  ghost-holding at hold time (`409 STALE_ALTERNATIVE`), but abandoned
  `holding` rows have no dated `DELETE`/release yet. Trivial shape when
  wanted: a periodic `DELETE FROM slots WHERE status='holding' AND
  created_at < now() - INTERVAL '<N> minutes'` plus a note — parked
  until post-hackathon so the demo surface stays frozen.

## What remains manual (not this stack)

DNS (bare IP only), Google login (`verified:true` lockdown), BigQuery
mirror (Postgres is the hot store; BQ stays async), Grafana dashboard
provision (`infra/grafana/provision.py` run).
