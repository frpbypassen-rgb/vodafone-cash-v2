#!/usr/bin/env bash
# Cloud Agent install phase for Al-Ahram Pay (Vodafone Cash v2).
# Idempotent: refreshes system packages, MongoDB, Node dependencies and the
# local development .env. Safe to run repeatedly.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

log() { echo "[install] $*"; }

# ---------------------------------------------------------------------------
# 1) System packages: native build deps for `canvas` and Puppeteer's Chromium
# ---------------------------------------------------------------------------
if ! dpkg -s libcairo2-dev >/dev/null 2>&1 || ! dpkg -s libnss3 >/dev/null 2>&1; then
  log "installing system packages for canvas + Chromium"
  sudo DEBIAN_FRONTEND=noninteractive apt-get update -y
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    build-essential python3 pkg-config \
    libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev libpixman-1-dev \
    ca-certificates fonts-liberation libnss3 libatk-bridge2.0-0 libgtk-3-0 libasound2t64 \
    libxdamage1 libxfixes3 libxrandr2 libgbm1 libxkbcommon0 libpango-1.0-0 libcairo2
else
  log "system packages already present"
fi

# ---------------------------------------------------------------------------
# 2) MongoDB 8.0 (single-node replica set is configured in start.sh)
# ---------------------------------------------------------------------------
if ! command -v mongod >/dev/null 2>&1; then
  log "installing MongoDB 8.0"
  curl -fsSL https://www.mongodb.org/static/pgp/server-8.0.asc \
    | sudo gpg -o /usr/share/keyrings/mongodb-server-8.0.gpg --dearmor
  echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg ] https://repo.mongodb.org/apt/ubuntu noble/mongodb-org/8.0 multiverse" \
    | sudo tee /etc/apt/sources.list.d/mongodb-org-8.0.list >/dev/null
  sudo DEBIAN_FRONTEND=noninteractive apt-get update -y
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y mongodb-org
else
  log "MongoDB already installed: $(mongod --version | head -1)"
fi

# ---------------------------------------------------------------------------
# 3) Node dependencies (also downloads Puppeteer's Chromium into ~/.cache)
# ---------------------------------------------------------------------------
log "installing Node dependencies (npm ci)"
npm ci

# ---------------------------------------------------------------------------
# 4) Local development .env (generated once with random dev-only secrets)
# ---------------------------------------------------------------------------
mkdir -p uploads
if [ ! -f .env ]; then
  log "generating local development .env"
  node .cursor/gen-env.js
else
  log ".env already present; leaving it untouched"
fi

log "install complete"
