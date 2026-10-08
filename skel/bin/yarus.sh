#!/bin/bash
# Sourced by start.sh. Publishes the Yarus web root and runs the API.

# Optional: allocations.properties or ALLOCATIONS='{"ip":[primary, extra]}'.
# Stock Wings does not set either. A single extra port may also arrive as ADDITIONAL_PORT.
yarus_additional_port() {
  local raw="" line name f=/home/container/allocations.properties
  # Some panels inject the extra allocation directly. Wings itself does not.
  for name in ADDITIONAL_PORT ALLOC_1 SERVER_PORT_1 P_SERVER_PORT; do
    raw="${!name-}"
    if [[ "$raw" =~ ^[0-9]+$ ]] && [ "$raw" != "${SERVER_PORT:-}" ] && [ "$raw" -ge 1 ] && [ "$raw" -le 65535 ]; then
      echo "$raw"
      return 0
    fi
  done
  raw=""
  if [ -f "$f" ]; then
    line=$(grep -E '^allocations[[:space:]]*=' "$f" | head -n 1 || true)
    raw=${line#*=}
    raw=${raw#"${raw%%[![:space:]]*}"}
  fi
  if [ -z "$raw" ] && [ -n "${ALLOCATIONS:-}" ]; then
    raw=$ALLOCATIONS
  fi
  [ -n "$raw" ] || return 1
  case "$raw" in
    *'{{'*) return 1 ;;
  esac
  SERVER_PORT="${SERVER_PORT:-}" YARUS_ALLOC_RAW="$raw" python3 - <<'PY'
import json, os, sys
raw = os.environ.get("YARUS_ALLOC_RAW", "").strip().strip('"').strip("'")
raw = raw.replace("\\:", ":").replace("\\=", "=").replace("\\\\", "\\")
primary = os.environ.get("SERVER_PORT", "")
try:
    data = json.loads(raw)
except Exception:
    sys.exit(1)
ports = []
if isinstance(data, dict):
    for value in data.values():
        if isinstance(value, list):
            ports.extend(value)
        elif isinstance(value, int):
            ports.append(value)
elif isinstance(data, list):
    ports = data
for port in ports:
    text = str(port)
    if text.isdigit() and text != primary and 1 <= int(text) <= 65535:
        print(text)
        sys.exit(0)
sys.exit(1)
PY
}

yarus_port_ok() {
  [[ "${1:-}" =~ ^[0-9]+$ ]] && [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}

# Stock Wings only publishes SERVER_PORT. The next port is the usual additional allocation.
yarus_next_port() {
  local next=""
  yarus_port_ok "${SERVER_PORT:-}" || return 1
  next=$((SERVER_PORT + 1))
  if [ "$next" -gt 65535 ]; then
    if [ "$SERVER_PORT" = "3001" ]; then
      echo 3002
    else
      echo 3001
    fi
    return 0
  fi
  echo "$next"
}

yarus_resolve_port() {
  local port="" extra="" manual="${YARUS_API_PORT:-3001}"
  extra=$(yarus_additional_port 2>/dev/null || true)
  if yarus_port_ok "$extra" && [ "$extra" != "${SERVER_PORT:-}" ]; then
    port=$extra
    echo "Yarus: API port ${port} taken from the additional allocation"
  elif yarus_port_ok "$manual" && [ "$manual" != "3001" ] && [ "$manual" != "${SERVER_PORT:-}" ]; then
    port=$manual
    echo "Yarus: API port ${port} from YARUS_API_PORT"
  else
    port=$(yarus_next_port 2>/dev/null || true)
    if yarus_port_ok "$port" && [ "$port" != "${SERVER_PORT:-}" ]; then
      echo "Yarus: API port ${port} is the next port after ${SERVER_PORT}. Leave YARUS_API_PORT at 3001."
    else
      port=3001
      if [ "$port" = "${SERVER_PORT:-}" ]; then
        port=3002
      fi
      echo "Yarus: API port ${port}"
    fi
  fi
  YARUS_API_PORT="$port"
  export YARUS_API_PORT
  export PORT="$port"
}

yarus_resolve_port

yarus_seed_tree() {
  local bundle=""
  if [ -f /opt/nestcp/skel/yarus/backend/package.json ]; then
    bundle=/opt/nestcp/skel/yarus
  elif [ -f /home/container/skel/yarus/backend/package.json ]; then
    bundle=/home/container/skel/yarus
  fi
  mkdir -p /home/container/yarus/data /home/container/www/yarus/public_html /home/container/logs
  if [ -n "$bundle" ] && [ -f "$bundle/backend/package.json" ]; then
    local dst=/home/container/yarus/backend
    if [ ! -f "$dst/package.json" ]; then
      echo "Yarus: copying backend from ${bundle}"
      cp -a "$bundle/backend" "$dst"
    else
      if ! cmp -s "$bundle/backend/package.json" "$dst/package.json"; then
        rm -f "$dst/node_modules/.bin/prisma"
      fi
      rm -rf "$dst/src"
      cp -a "$bundle/backend/src" "$dst/src"
      mkdir -p "$dst/prisma"
      cp -a "$bundle/backend/prisma/schema.prisma" "$dst/prisma/schema.prisma"
      cp -a "$bundle/backend/package.json" "$dst/package.json"
      if [ -f "$bundle/backend/package-lock.json" ]; then
        cp -a "$bundle/backend/package-lock.json" "$dst/package-lock.json"
      fi
      echo "Yarus: backend source updated from the image"
    fi
  fi
  if [ -n "$bundle" ] && [ -d "$bundle/web" ]; then
    echo "Yarus: updating frontend"
    rm -f /home/container/www/yarus/public_html/assets/index-*.js /home/container/www/yarus/public_html/assets/index-*.css
    cp -a "$bundle/web/." /home/container/www/yarus/public_html/
  fi
  rm -f /home/container/www/yarus/public_html/index.php
}

yarus_pg_bin() {
  local candidate="" d
  for d in /usr/lib/postgresql/*/bin; do
    if [ -x "$d/postgres" ] && [ -x "$d/initdb" ]; then
      candidate="$d"
    fi
  done
  [ -n "$candidate" ] || return 1
  printf '%s\n' "$candidate"
}

yarus_pg_port() {
  local port=5432
  if [ "$port" = "${SERVER_PORT:-}" ] || [ "$port" = "${YARUS_API_PORT:-}" ]; then
    port=5433
  fi
  printf '%s\n' "$port"
}

# Postgres refuses to run as root. Wings sometimes starts the container as root.
yarus_pg_run() {
  if [ "$(id -u)" -ne 0 ]; then
    LANG="${LANG:-C.UTF-8}" LC_ALL="${LC_ALL:-C.UTF-8}" "$@"
    return $?
  fi
  if ! id container >/dev/null 2>&1; then
    echo "Yarus: the container user is missing, PostgreSQL cannot run as root"
    return 1
  fi
  local runner=/usr/sbin/runuser
  [ -x "$runner" ] || runner=runuser
  "$runner" -u container -- env LANG=C.UTF-8 LC_ALL=C.UTF-8 HOME=/home/container "$@"
}

yarus_pg_own() {
  [ "$(id -u)" -eq 0 ] || return 0
  chown container:container "$@" 2>/dev/null || true
}

yarus_start_postgres() {
  YARUS_PG_BIN="$(yarus_pg_bin)" || {
    echo "Yarus: PostgreSQL is not in this image. Rebuild ghcr.io/kotl-ev/nestcp-webhost and restart the server."
    return 1
  }
  YARUS_PGDATA=/home/container/yarus/pgdata
  YARUS_PGPORT="$(yarus_pg_port)"
  local logfile=/home/container/logs/postgres.log
  local sockdir=/home/container/yarus/pg-run
  mkdir -p /home/container/yarus /home/container/logs "$sockdir"
  touch "$logfile"
  yarus_pg_own /home/container/yarus "$logfile" "$sockdir"
  if [ ! -s "$YARUS_PGDATA/PG_VERSION" ]; then
    echo "Yarus: creating PostgreSQL cluster in yarus/pgdata"
    rm -rf "$YARUS_PGDATA"
    mkdir -p "$YARUS_PGDATA"
    chmod 700 "$YARUS_PGDATA"
    yarus_pg_own "$YARUS_PGDATA"
    if ! yarus_pg_run "$YARUS_PG_BIN/initdb" -D "$YARUS_PGDATA" --username=postgres --auth-local=trust --auth-host=trust --locale=C.UTF-8 --encoding=UTF8 >>"$logfile" 2>&1; then
      echo "Yarus: initdb with C.UTF-8 failed, retrying with locale C"
      rm -rf "$YARUS_PGDATA"
      mkdir -p "$YARUS_PGDATA"
      chmod 700 "$YARUS_PGDATA"
      yarus_pg_own "$YARUS_PGDATA"
      if ! yarus_pg_run "$YARUS_PG_BIN/initdb" -D "$YARUS_PGDATA" --username=postgres --auth-local=trust --auth-host=trust --locale=C --encoding=UTF8 >>"$logfile" 2>&1; then
        echo "Yarus: initdb failed. Tail of logs/postgres.log:"
        tail -n 40 "$logfile" 2>/dev/null || true
        return 1
      fi
    fi
  fi
  yarus_pg_own -R "$YARUS_PGDATA"
  cat > "$YARUS_PGDATA/yarus.conf" <<EOF
listen_addresses = '127.0.0.1'
port = ${YARUS_PGPORT}
unix_socket_directories = '${sockdir}'
shared_buffers = 16MB
max_connections = 30
shared_memory_type = mmap
dynamic_shared_memory_type = mmap
huge_pages = off
EOF
  cat > "$YARUS_PGDATA/pg_hba.conf" <<'EOF'
local all all trust
host all all 127.0.0.1/32 trust
host all all ::1/128 trust
EOF
  if ! grep -q "^include = 'yarus.conf'" "$YARUS_PGDATA/postgresql.conf"; then
    echo "include = 'yarus.conf'" >> "$YARUS_PGDATA/postgresql.conf"
  fi
  chmod 600 "$YARUS_PGDATA/yarus.conf" "$YARUS_PGDATA/pg_hba.conf" || true
  yarus_pg_own "$YARUS_PGDATA/yarus.conf" "$YARUS_PGDATA/pg_hba.conf" "$YARUS_PGDATA/postgresql.conf"
  if ! "$YARUS_PG_BIN/pg_isready" -h 127.0.0.1 -p "$YARUS_PGPORT" -q; then
    echo "Yarus: starting PostgreSQL on 127.0.0.1:${YARUS_PGPORT}"
    if ! yarus_pg_run "$YARUS_PG_BIN/pg_ctl" -D "$YARUS_PGDATA" -w -t 40 -l "$logfile" start; then
      echo "Yarus: PostgreSQL failed to start. Tail of logs/postgres.log:"
      tail -n 40 "$logfile" 2>/dev/null || true
      return 1
    fi
  fi
  local psql="$YARUS_PG_BIN/psql"
  if ! "$psql" -h 127.0.0.1 -p "$YARUS_PGPORT" -U postgres -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='yarus'" | grep -q 1; then
    if ! "$psql" -h 127.0.0.1 -p "$YARUS_PGPORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE yarus OWNER postgres" >>"$logfile" 2>&1; then
      echo "Yarus: could not create database yarus. Tail of logs/postgres.log:"
      tail -n 40 "$logfile" 2>/dev/null || true
      return 1
    fi
  fi
  YARUS_DATABASE_URL="postgresql://postgres@127.0.0.1:${YARUS_PGPORT}/yarus?schema=public&sslmode=disable"
  export YARUS_DATABASE_URL
}

yarus_stop_postgres() {
  if [ -z "${YARUS_PG_BIN:-}" ] || [ -z "${YARUS_PGDATA:-}" ] || [ ! -s "${YARUS_PGDATA}/PG_VERSION" ]; then
    return 0
  fi
  yarus_pg_run "$YARUS_PG_BIN/pg_ctl" -D "$YARUS_PGDATA" -m fast -w -t 20 stop >/dev/null 2>&1 || true
}

yarus_env() {
  local envf=/home/container/yarus/backend/.env
  local dburl="${YARUS_DATABASE_URL:-}"
  [ -f /home/container/yarus/backend/package.json ] || return 0
  if [ -z "$dburl" ]; then
    echo "Yarus: PostgreSQL URL is empty"
    return 1
  fi
  if [ ! -f "$envf" ]; then
    cat > "$envf" <<EOF
PORT=${YARUS_API_PORT}
WEB_ORIGIN=${YARUS_WEB_ORIGIN:-http://127.0.0.1:${SERVER_PORT}}
JWT_SECRET=${JWT_SECRET:-yarus-dev-jwt-secret-change}
ENCRYPTION_KEY=${ENCRYPTION_KEY:-yarus-dev-key-change-me}
EOF
  fi
  if grep -q '^PORT=' "$envf"; then
    sed -i "s#^PORT=.*#PORT=${YARUS_API_PORT}#" "$envf"
  else
    echo "PORT=${YARUS_API_PORT}" >> "$envf"
  fi
  YARUS_DATABASE_URL="$dburl" YARUS_ENV_FILE="$envf" python3 - <<'PY'
import os
from pathlib import Path
p = Path(os.environ["YARUS_ENV_FILE"])
text = p.read_text(encoding="utf-8") if p.exists() else ""
kept = [ln for ln in text.splitlines() if not ln.startswith("DATABASE_URL=")]
kept.append("DATABASE_URL=" + os.environ["YARUS_DATABASE_URL"])
p.write_text("\n".join(kept) + "\n", encoding="utf-8")
os.chmod(p, 0o600)
PY
  export DATABASE_URL="$dburl"
}

yarus_postgres_schema() {
  local schema=/home/container/yarus/backend/prisma/schema.prisma
  [ -f "$schema" ] || return 0
  if grep -q 'provider *= *"sqlite"' "$schema"; then
    sed -i 's/provider *= *"sqlite"/provider = "postgresql"/' "$schema"
    echo "Yarus: Prisma provider set to postgresql"
  fi
}

prepare_yarus() {
  if ! command -v node >/dev/null 2>&1; then
    echo "Yarus: node is not in this image"
    return 0
  fi
  yarus_seed_tree
  if [ ! -f /home/container/yarus/backend/package.json ]; then
    echo "Yarus: backend is missing, nginx will start without the API"
    return 0
  fi
  if ! yarus_start_postgres; then
    cd /home/container || true
    return 0
  fi
  if ! yarus_env; then
    cd /home/container || true
    return 0
  fi
  yarus_postgres_schema
  cd /home/container/yarus/backend || return 0
  export PORT="${YARUS_API_PORT}"
  export HOME=/home/container
  export npm_config_cache=/home/container/.npm
  if [ ! -d node_modules/tsx ] || [ ! -x node_modules/.bin/prisma ]; then
    echo "Yarus: npm install (the first start takes a few minutes)..."
    if ! npm install --include=dev --no-audit --no-fund; then
      echo "Yarus: npm install failed"
      cd /home/container || true
      return 0
    fi
  fi
  echo "Yarus: prisma generate and db push"
  if ! npx prisma generate || ! npx prisma db push --accept-data-loss; then
    echo "Yarus: database preparation failed. See the lines above."
    cd /home/container || true
    return 0
  fi
  if [ ! -f /home/container/yarus/data/.pg-ready ]; then
    mkdir -p /home/container/yarus/data
    touch /home/container/yarus/data/.pg-ready
    echo "Yarus: empty PostgreSQL database. Create the company on the login page."
    if [ -f /home/container/yarus/data/yarus.db ]; then
      echo "Yarus: SQLite file yarus/data/yarus.db is ignored."
    fi
  fi
  cd /home/container || true
  YARUS_READY=1
}

start_yarus_api() {
  if [ "${YARUS_READY:-0}" != "1" ]; then
    echo "Yarus: API is not running, so /api returns 502. See the lines above and logs/postgres.log."
    return 0
  fi
  echo "Yarus: API on 0.0.0.0:${YARUS_API_PORT}, site on port ${SERVER_PORT}"
  (cd /home/container/yarus/backend && exec npx tsx src/main.ts) >> /home/container/logs/yarus.log 2>&1 &
  YARUS_PID=$!
  PIDS+=("$YARUS_PID")
}

yarus_watch() {
  if [ -n "${YARUS_PG_BIN:-}" ] && [ -n "${YARUS_PGDATA:-}" ]; then
    if ! "$YARUS_PG_BIN/pg_isready" -h 127.0.0.1 -p "${YARUS_PGPORT:-5432}" -q; then
      local now
      now=$(date +%s)
      if [ -z "${YARUS_PG_RESTART_AT:-}" ] || [ $((now - YARUS_PG_RESTART_AT)) -ge 15 ]; then
        YARUS_PG_RESTART_AT=$now
        echo "Yarus: PostgreSQL is down, starting it again"
        yarus_start_postgres || true
      fi
    fi
  fi
  [ -n "${YARUS_PID:-}" ] || return 0
  if kill -0 "$YARUS_PID" >/dev/null 2>&1; then
    return 0
  fi
  local now
  now=$(date +%s)
  if [ -n "${YARUS_RESTART_AT:-}" ] && [ $((now - YARUS_RESTART_AT)) -lt 15 ]; then
    return 0
  fi
  YARUS_RESTART_AT=$now
  echo "Yarus API exited, restarting. Tail of logs/yarus.log:"
  tail -n 20 /home/container/logs/yarus.log 2>/dev/null || true
  start_yarus_api
}
