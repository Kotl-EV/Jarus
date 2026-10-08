#!/bin/bash
echo "NestCP entrypoint: boot"
cd /home/container || {
    echo "ERROR: cannot cd /home/container"
    exit 1
}

export TZ="${TZ:-UTC}"
export HOME="/home/container"
export SERVER_PORT="${SERVER_PORT:-8080}"
export PHP_VERSION="${PHP_VERSION:-8.3}"
export PATH="/usr/local/bin:/usr/bin:${PATH}"

mkdir -p www/default/public_html nginx/conf.d php-fpm logs run \
    tmp/jobs tmp/client_body tmp/proxy tmp/fastcgi tmp/uwsgi tmp/scgi \
    bin ssl .composer .npm

if [ ! -f /home/container/start.sh ]; then
    echo "NestCP: start.sh missing, seeding from image..."
    if [ -d /opt/nestcp/skel ]; then
        cp -a /opt/nestcp/skel/. /home/container/ || true
    fi
fi

# Keep the launcher current. Do not touch an existing database or an uploaded backend.
if [ -f /opt/nestcp/skel/start.sh ]; then
    cp -a /opt/nestcp/skel/start.sh /home/container/start.sh
fi
if [ -f /opt/nestcp/skel/bin/yarus.sh ]; then
    mkdir -p /home/container/bin
    cp -a /opt/nestcp/skel/bin/yarus.sh /home/container/bin/yarus.sh
    cp -a /opt/nestcp/skel/bin/render-nginx.php /home/container/bin/render-nginx.php
fi
if [ -d /opt/nestcp/skel/yarus/backend ] && [ ! -f /home/container/yarus/backend/package.json ]; then
    mkdir -p /home/container/yarus
    cp -a /opt/nestcp/skel/yarus/backend /home/container/yarus/backend
fi
if [ -d /opt/nestcp/skel/yarus/web ]; then
    mkdir -p /home/container/www/yarus/public_html/assets
    rm -f /home/container/www/yarus/public_html/assets/index-*.js /home/container/www/yarus/public_html/assets/index-*.css
    cp -a /opt/nestcp/skel/yarus/web/. /home/container/www/yarus/public_html/
fi

if [ ! -f /home/container/start.sh ] && [ -n "${GIT_REPO:-}" ] && [ -f /opt/nestcp/fetch.sh ]; then
    echo "NestCP: fetching files from GitHub ${GIT_REPO}..."
    bash /opt/nestcp/fetch.sh /home/container || echo "NestCP: GitHub fetch failed"
fi

if [ ! -f /home/container/start.sh ]; then
    echo "ERROR: start.sh still missing. Use image ghcr.io/kotl-ev/nestcp-webhost:latest"
    ls -la /home/container /opt/nestcp/skel 2>/dev/null || true
    exit 1
fi

sed -i 's/\r$//' /home/container/start.sh 2>/dev/null || true
chmod +x /home/container/start.sh 2>/dev/null || true

echo "NestCP: exec start.sh (cwd=$(pwd))"
# Pterodactyl working directory is /home/container, so `bash start.sh` is enough.
exec /bin/bash ./start.sh
