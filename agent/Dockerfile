# TOWER agent image (T-11a) — production FastAPI server.
#
# Base: python:3.11-slim (minor pin, no :latest). Official python images are
# multi-arch (linux/amd64 + linux/arm64), so this is ARM64-safe on the
# beast (no x86-only base, no arch-specific wheels: psycopg[binary] ships
# manylinux ARM64 wheels). Devops pins the digest in cloudbuild at deploy.
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /srv/tower

# Deps first for layer cache: requirements carry fastapi + uvicorn (serve
# agent/main.py) and psycopg[binary] (PostgresSlotStore live path).
COPY agent/requirements.txt ./agent/requirements.txt
RUN pip install --no-cache-dir -r agent/requirements.txt

# App code: agent package + frozen contracts (repo-root layout preserved so
# `agent.main` imports and the sys.path anchors in tower/tools.py hold).
COPY agent ./agent
COPY contracts ./contracts

# Non-root runtime (hadolint DL3002): dedicated user owns the tree.
RUN useradd --create-home --shell /usr/sbin/nologin appuser \
    && chown -R appuser:appuser /srv/tower
USER appuser

EXPOSE 8000

# Liveness: strict 200 on /health (503 while Postgres is down keeps the
# container out of rotation until the dependency recovers).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD python -c "import sys,urllib.request; sys.exit(0 if urllib.request.urlopen('http://localhost:8000/health', timeout=4).status == 200 else 1)"

CMD ["uvicorn", "agent.main:app", "--host", "0.0.0.0", "--port", "8000"]
