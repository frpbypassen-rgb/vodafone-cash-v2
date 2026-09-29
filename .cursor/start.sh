#!/usr/bin/env bash
# Cloud Agent start phase for Al-Ahram Pay (Vodafone Cash v2).
# Starts MongoDB as a single-node replica set (required for financial
# transactions), initiates the replica set, and seeds local dev data.
# Idempotent and safe to run on every boot.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

log() { echo "[start] $*"; }

node .cursor/validate-dev-target.js
DBPATH="$REPO_DIR/.cloud-dev-data/db"
LOGPATH="$REPO_DIR/.cloud-dev-data/mongod.log"
PORT=27019

# ---------------------------------------------------------------------------
# 1) Ensure MongoDB is running with the rs0 replica set
# ---------------------------------------------------------------------------
mkdir -p "$DBPATH" "$(dirname "$LOGPATH")"

if mongosh --quiet --port "$PORT" --eval 'db.adminCommand({ ping: 1 })' >/dev/null 2>&1; then
  log "MongoDB already running on port $PORT"
else
  log "starting mongod (replSet rs0)"
  mongod --replSet clouddev --dbpath "$DBPATH" --bind_ip 127.0.0.1 --port "$PORT" \
    --logpath "$LOGPATH" --fork
  for i in $(seq 1 30); do
    if mongosh --quiet --port "$PORT" --eval 'db.adminCommand({ ping: 1 })' >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
fi

# ---------------------------------------------------------------------------
# 2) Initiate the replica set if it has not been initiated yet
# ---------------------------------------------------------------------------
if ! mongosh --quiet --port "$PORT" --eval 'rs.status().ok' >/dev/null 2>&1; then
  log "initiating replica set rs0"
  mongosh --quiet --port "$PORT" --eval \
    'rs.initiate({ _id: "clouddev", members: [{ _id: 0, host: "127.0.0.1:27019" }] })' >/dev/null
fi

log "waiting for replica set PRIMARY"
for i in $(seq 1 30); do
  if mongosh --quiet --port "$PORT" --eval 'quit(rs.status().myState === 1 ? 0 : 1)' >/dev/null 2>&1; then
    log "replica set is PRIMARY"
    break
  fi
  sleep 1
done

# ---------------------------------------------------------------------------
# 3) Seed local development data (tenant, relaxed security state, demo accounts)
# ---------------------------------------------------------------------------
if [ -f .env ]; then
  log "seeding local development data"
  node .cursor/seed-dev.js
else
  log ".env missing; skipping dev seed (run install first)"
fi

log "start complete"
