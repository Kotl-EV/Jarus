#!/bin/bash
echo "NestCP start.sh: starting"
set +e
cd /home/container || exit 1

export SERVER_PORT="${SERVER_PORT:-8080}"
export PHP_VERSION="${PHP_VERSION:-8.3}"
export COMPOSER_HOME="/home/container/.composer"
export npm_config_cache="/home/container/.npm"
export HOME="/home/container"
export PATH="/usr/local/bin:/usr/bin:${PATH}"

php_bin() {
    if command -v php >/dev/null 2>&1; then
        command -v php
        return
    fi
    for v in 8.3 8.4 8.2 8.1; do
        if command -v "php${v}" >/dev/null 2>&1; then
            command -v "php${v}"
            return
        fi
    done
    echo ""
}

PHP_BIN="$(php_bin)"
if [ -z "$PHP_BIN" ]; then
    echo "ERROR: no php CLI found (php / php8.x). Rebuild nestcp/webhost:latest on the Wings node."
    exit 1
fi

mkdir -p www/default/public_html nginx/conf.d php-fpm logs run tmp/jobs tmp/client_body tmp/proxy tmp/fastcgi tmp/uwsgi tmp/scgi bin ssl .composer .npm

if [ ! -f www/default/public_html/index.php ]; then
  cat > www/default/public_html/index.php <<'PHP'
<?php
echo '<h1>NestCP</h1><p>PHP ' . PHP_VERSION . ' · add a domain in NestCP</p>';
PHP
fi

if [ ! -f sites.json ]; then
  cat > sites.json <<JSON
{
  "php_default": "${PHP_VERSION}",
  "port": ${SERVER_PORT},
  "sites": []
}
JSON
fi

if [ ! -f /home/container/bin/render-nginx.php ]; then
    echo "ERROR: missing bin/render-nginx.php — volume was not seeded. Rebuild the NestCP image and reimport the egg."
    exit 1
fi

if [ -f /home/container/bin/yarus.sh ]; then
  # shellcheck disable=SC1091
  source /home/container/bin/yarus.sh
  prepare_yarus
else
  echo "Yarus: bin/yarus.sh is missing, API will not start"
fi

echo "Rendering nginx vhosts with ${PHP_BIN}..."
"$PHP_BIN" /home/container/bin/render-nginx.php || {
    echo "ERROR: render-nginx.php failed"
    exit 1
}

write_fpm_conf() {
  local ver="$1"
  local sock="/home/container/run/php${ver}.sock"
  cat > "/home/container/php-fpm/php-fpm-${ver}.conf" <<CONF
[global]
pid = /home/container/run/php-fpm-${ver}.pid
error_log = /home/container/logs/php-fpm-${ver}.log
daemonize = no

[www]
listen = ${sock}
listen.mode = 0666
pm = ondemand
pm.max_children = 24
pm.process_idle_timeout = 15s
pm.max_requests = 500
chdir = /
catch_workers_output = yes
clear_env = no
php_admin_value[upload_max_filesize] = 100M
php_admin_value[post_max_size] = 100M
php_admin_value[memory_limit] = 256M
php_admin_value[date.timezone] = ${TZ:-UTC}
CONF
}

PIDS=()
for ver in 8.1 8.2 8.3 8.4; do
  bin="php-fpm${ver}"
  if command -v "$bin" >/dev/null 2>&1; then
    write_fpm_conf "$ver"
    rm -f "/home/container/run/php${ver}.sock" "/home/container/run/php-fpm-${ver}.pid"
    "$bin" --fpm-config "/home/container/php-fpm/php-fpm-${ver}.conf" &
    PIDS+=($!)
    echo "Started ${bin}"
  fi
done

echo "Testing nginx config..."
if ! nginx -p /home/container -c /home/container/nginx/nginx.conf -t; then
    echo "ERROR: nginx config test failed"
    cat /home/container/logs/nginx-error.log 2>/dev/null || true
    exit 1
fi

nginx -p /home/container -c /home/container/nginx/nginx.conf &
NGINX_PID=$!
PIDS+=($NGINX_PID)
sleep 0.4
if ! kill -0 "$NGINX_PID" >/dev/null 2>&1; then
    echo "ERROR: nginx exited immediately"
    cat /home/container/logs/nginx-error.log 2>/dev/null || true
    exit 1
fi

start_cloudflared() {
  local token="${CLOUDFLARE_TUNNEL_TOKEN:-}"
  if [ -z "$token" ] && [ -f /home/container/.cloudflared-token ]; then
    token="$(tr -d '\r\n' < /home/container/.cloudflared-token)"
  fi
  if [ -z "$token" ]; then
    return 0
  fi
  local bin="/home/container/bin/cloudflared"
  if [ ! -x "$bin" ]; then
    echo "Downloading cloudflared into the container..."
    curl -fsSL -o "$bin" "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64" || {
      echo "ERROR: could not download cloudflared"
      return 0
    }
    chmod +x "$bin"
  fi
  echo "Starting Cloudflare Tunnel (HTTPS for your domains, nothing on the host)..."
  "$bin" tunnel --no-autoupdate run --token "$token" &
  PIDS+=($!)
}

start_cloudflared

if declare -F start_yarus_api >/dev/null 2>&1; then
  start_yarus_api
fi

echo "NestCP web stack is ready on port ${SERVER_PORT}"

reload_stack() {
  echo "Reloading nginx / php-fpm..."
  "$PHP_BIN" /home/container/bin/render-nginx.php || true
  nginx -p /home/container -c /home/container/nginx/nginx.conf -s reload || true
}

cleanup() {
  echo "Stopping NestCP stack..."
  nginx -p /home/container -c /home/container/nginx/nginx.conf -s quit >/dev/null 2>&1 || true
  for pid in "${PIDS[@]}"; do
    kill "$pid" >/dev/null 2>&1 || true
  done
  exit 0
}
trap cleanup INT TERM

run_jobs() {
  local jobdir="/home/container/tmp/jobs"
  mkdir -p "$jobdir"
  shopt -s nullglob
  for f in "$jobdir"/*.json; do
    case "$f" in
      *.done.json) continue ;;
    esac
    local id
    id="$(basename "$f" .json)"
    if [ -f "$jobdir/${id}.done.json" ]; then
      continue
    fi
    echo "NestCP job ${id} starting"
    python3 - "$f" "$jobdir/${id}.log" "$jobdir/${id}.done.json" <<'PY' || true
import json, os, subprocess, sys, time
job_file, log_file, done_file = sys.argv[1], sys.argv[2], sys.argv[3]
with open(job_file, encoding="utf-8") as fh:
    job = json.load(fh)
cwd = job.get("cwd") or "/home/container"
cmd = job.get("command") or "true"
timeout = int(job.get("timeout") or 600)
os.makedirs(cwd, exist_ok=True)
env = os.environ.copy()
env["HOME"] = "/home/container"
env["COMPOSER_HOME"] = "/home/container/.composer"
started = time.time()
try:
    proc = subprocess.run(
        ["bash", "-lc", cmd],
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    out = (proc.stdout or "") + (proc.stderr or "")
    code = proc.returncode
except subprocess.TimeoutExpired as exc:
    out = (exc.stdout or "") + (exc.stderr or "") + "\n[timeout]"
    code = 124
except Exception as exc:
    out = str(exc)
    code = 1
with open(log_file, "w", encoding="utf-8") as fh:
    fh.write(out)
with open(done_file, "w", encoding="utf-8") as fh:
    json.dump({"id": job.get("id"), "exit_code": code, "output": out, "seconds": round(time.time()-started, 2)}, fh)
print(f"NestCP job finished exit={code}")
PY
  done
}

while true; do
  if [ -f /home/container/tmp/nestcp-reload ]; then
    rm -f /home/container/tmp/nestcp-reload
    reload_stack
  fi
  run_jobs
  if declare -F yarus_watch >/dev/null 2>&1; then
    yarus_watch
  fi
  if ! kill -0 "$NGINX_PID" >/dev/null 2>&1; then
    echo "nginx exited"
    cat /home/container/logs/nginx-error.log 2>/dev/null || true
    cleanup
  fi
  sleep 2
done
