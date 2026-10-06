#!/bin/bash
# Sourced by start.sh. Publishes the Yarus web root and runs the API.

yarus_resolve_port() {
  local port="${YARUS_API_PORT:-3001}"
  if ! [[ "$port" =~ ^[0-9]+$ ]] || [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
    echo "Yarus: bad API port '${YARUS_API_PORT}', using 3001"
    port=3001
  fi
  if [ "$port" = "${SERVER_PORT:-}" ]; then
    if [ "$port" = "3001" ]; then
      port=3002
    else
      port=3001
    fi
    echo "Yarus: API port is the same as the public port, using ${port}"
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
  if [ -n "$bundle" ] && [ ! -f /home/container/yarus/backend/package.json ]; then
    echo "Yarus: copying backend from ${bundle}"
    cp -a "$bundle/backend" /home/container/yarus/backend
  fi
  if [ -n "$bundle" ] && [ ! -f /home/container/www/yarus/public_html/index.html ] && [ -d "$bundle/web" ]; then
    echo "Yarus: copying frontend"
    cp -a "$bundle/web/." /home/container/www/yarus/public_html/
  fi
  rm -f /home/container/www/yarus/public_html/index.php
}

yarus_env() {
  local envf=/home/container/yarus/backend/.env
  [ -f /home/container/yarus/backend/package.json ] || return 0
  if [ ! -f "$envf" ]; then
    cat > "$envf" <<EOF
PORT=${YARUS_API_PORT}
WEB_ORIGIN=${YARUS_WEB_ORIGIN:-http://127.0.0.1:${SERVER_PORT}}
JWT_SECRET=${JWT_SECRET:-yarus-dev-jwt-secret-change}
ENCRYPTION_KEY=${ENCRYPTION_KEY:-yarus-dev-key-change-me}
DATABASE_URL=${DATABASE_URL:-file:/home/container/yarus/data/yarus.db}
EOF
  fi
  if grep -q '^PORT=' "$envf"; then
    sed -i "s#^PORT=.*#PORT=${YARUS_API_PORT}#" "$envf"
  else
    echo "PORT=${YARUS_API_PORT}" >> "$envf"
  fi
  if grep -Eq 'DATABASE_URL=.*@(127\.0\.0\.1|localhost):5432' "$envf"; then
    echo "Yarus: localhost Postgres from a PC .env is not reachable here, using the SQLite file"
    sed -i 's#^DATABASE_URL=.*#DATABASE_URL="file:/home/container/yarus/data/yarus.db"#' "$envf"
  fi
}

yarus_sqlite_schema() {
  local schema=/home/container/yarus/backend/prisma/schema.prisma
  local envf=/home/container/yarus/backend/.env
  [ -f "$schema" ] && [ -f "$envf" ] || return 0
  if grep -q 'file:' "$envf" && grep -q 'provider *= *"postgresql"' "$schema"; then
    sed -i 's/provider *= *"postgresql"/provider = "sqlite"/' "$schema"
    echo "Yarus: Prisma provider set to sqlite"
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
  yarus_env
  yarus_sqlite_schema
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
  if ! npx prisma generate || ! npx prisma db push; then
    echo "Yarus: database preparation failed. See the lines above."
    cd /home/container || true
    return 0
  fi
  if [ ! -f /home/container/yarus/data/.seeded ]; then
    echo "Yarus: loading demo data"
    if npx tsx src/seed.ts; then
      touch /home/container/yarus/data/.seeded
    else
      echo "Yarus: seed failed, the API will still start"
    fi
  fi
  cd /home/container || true
  YARUS_READY=1
}

start_yarus_api() {
  [ "${YARUS_READY:-0}" = "1" ] || return 0
  echo "Yarus: API on 127.0.0.1:${YARUS_API_PORT}, site on port ${SERVER_PORT}"
  (cd /home/container/yarus/backend && exec npx tsx src/main.ts) >> /home/container/logs/yarus.log 2>&1 &
  YARUS_PID=$!
  PIDS+=("$YARUS_PID")
}

yarus_watch() {
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
