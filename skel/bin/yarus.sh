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

# Prints the cluster password. Creates yarus/pg.secret on the first call.
yarus_pg_secret() {
  local secret=/home/container/yarus/pg.secret
  mkdir -p /home/container/yarus
  if [ ! -s "$secret" ]; then
    python3 -c 'import secrets,pathlib; pathlib.Path("/home/container/yarus/pg.secret").write_text(secrets.token_hex(24))'
    chmod 600 "$secret" || return 1
  fi
  tr -d '\r\n' < "$secret"
}

yarus_start_postgres() {
  if [ "$(id -u)" -eq 0 ]; then
    echo "Yarus: PostgreSQL cannot run as root. Wings starts the server as the container user."
    return 1
  fi
  YARUS_PG_BIN="$(yarus_pg_bin)" || {
    echo "Yarus: PostgreSQL is not in this image. Rebuild ghcr.io/pazitiv4ik/nestcp-webhost and restart the server."
    return 1
  }
  YARUS_PGDATA=/home/container/yarus/pgdata
  YARUS_PGPORT="$(yarus_pg_port)"
  local secret=/home/container/yarus/pg.secret
  local logfile=/home/container/logs/postgres.log
  local pass created_secret=0
  mkdir -p /home/container/yarus /home/container/logs /home/container/run
  chmod 755 /home/container/run || true
  if [ ! -s "$secret" ]; then
    created_secret=1
  fi
  pass="$(yarus_pg_secret)" || return 1
  if [ ! -s "$YARUS_PGDATA/PG_VERSION" ]; then
    echo "Yarus: creating PostgreSQL cluster in yarus/pgdata"
    rm -rf "$YARUS_PGDATA"
    mkdir -p "$YARUS_PGDATA"
    chmod 700 "$YARUS_PGDATA"
    if ! "$YARUS_PG_BIN/initdb" -D "$YARUS_PGDATA" --username=postgres --pwfile="$secret" --auth-local=trust --auth-host=scram-sha-256 --locale=C.UTF-8 --encoding=UTF8 >>"$logfile" 2>&1; then
      echo "Yarus: initdb failed. Tail of logs/postgres.log:"
      tail -n 40 "$logfile" 2>/dev/null || true
      return 1
    fi
    created_secret=0
  fi
  if ! "$YARUS_PG_BIN/pg_isready" -h 127.0.0.1 -p "$YARUS_PGPORT" -q; then
    echo "Yarus: starting PostgreSQL on 127.0.0.1:${YARUS_PGPORT}"
    if ! "$YARUS_PG_BIN/pg_ctl" -D "$YARUS_PGDATA" -w -t 40 -l "$logfile" \
      -o "-c listen_addresses=127.0.0.1 -c port=${YARUS_PGPORT} -c unix_socket_directories=/home/container/run -c shared_buffers=16MB -c max_connections=30 -c shared_memory_type=mmap -c dynamic_shared_memory_type=mmap -c huge_pages=off" \
      start; then
      echo "Yarus: PostgreSQL failed to start. Tail of logs/postgres.log:"
      tail -n 40 "$logfile" 2>/dev/null || true
      return 1
    fi
  fi
  local psql="$YARUS_PG_BIN/psql"
  local socket_args=(-h /home/container/run -p "$YARUS_PGPORT" -U postgres)
  if [ "$created_secret" -eq 1 ]; then
    if ! "$psql" "${socket_args[@]}" -d postgres -v ON_ERROR_STOP=1 -c "ALTER USER postgres PASSWORD '${pass}'" >>"$logfile" 2>&1; then
      echo "Yarus: could not set the PostgreSQL password. Tail of logs/postgres.log:"
      tail -n 40 "$logfile" 2>/dev/null || true
      return 1
    fi
  fi
  if ! "$psql" "${socket_args[@]}" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='yarus'" | grep -q 1; then
    if ! "$psql" "${socket_args[@]}" -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE yarus OWNER postgres" >>"$logfile" 2>&1; then
      echo "Yarus: could not create database yarus. Tail of logs/postgres.log:"
      tail -n 40 "$logfile" 2>/dev/null || true
      return 1
    fi
  fi
  YARUS_DATABASE_URL="postgresql://postgres:${pass}@127.0.0.1:${YARUS_PGPORT}/yarus?schema=public"
  export YARUS_DATABASE_URL
}

yarus_stop_postgres() {
  if [ -z "${YARUS_PG_BIN:-}" ] || [ -z "${YARUS_PGDATA:-}" ] || [ ! -s "${YARUS_PGDATA}/PG_VERSION" ]; then
    return 0
  fi
  "$YARUS_PG_BIN/pg_ctl" -D "$YARUS_PGDATA" -m fast -w -t 20 stop >/dev/null 2>&1 || true
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
DATABASE_URL=${dburl}
EOF
  fi
  chmod 600 "$envf" || true
  if grep -q '^PORT=' "$envf"; then
    sed -i "s#^PORT=.*#PORT=${YARUS_API_PORT}#" "$envf"
  else
    echo "PORT=${YARUS_API_PORT}" >> "$envf"
  fi
  if grep -q '^DATABASE_URL=' "$envf"; then
    sed -i "s#^DATABASE_URL=.*#DATABASE_URL=${dburl}#" "$envf"
  else
    echo "DATABASE_URL=${dburl}" >> "$envf"
  fi
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
  if ! npx prisma generate || ! npx prisma db push; then
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
  [ "${YARUS_READY:-0}" = "1" ] || return 0
  echo "Yarus: API on 127.0.0.1:${YARUS_API_PORT}, site on port ${SERVER_PORT}"
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
