#!/bin/bash
# Runs inside ghcr.io/pterodactyl/installers:debian during egg install / reinstall.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null
apt-get install -y -qq curl ca-certificates tar >/dev/null

cd /mnt/server
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/fetch.sh" ]; then
    bash "$SCRIPT_DIR/fetch.sh" /mnt/server
else
    # Embedded fallback: egg JSON inlines this file without fetch.sh beside it.
    bash -s /mnt/server <<'ENDFETCH'
set -euo pipefail
DEST="${1:-.}"
REPO="${GIT_REPO:-}"
BRANCH="${GIT_BRANCH:-main}"
TOKEN="${GIT_TOKEN:-}"
mkdir -p "$DEST"
if [ -z "$REPO" ]; then
  echo "GIT_REPO is not set. Fill the egg variable with https://github.com/USER/REPO"
  exit 1
fi
REPO="${REPO%.git}"
REPO="${REPO%/}"
ARCHIVE_URL="${REPO}/archive/refs/heads/${BRANCH}.tar.gz"
if [ -n "$TOKEN" ]; then
  ARCHIVE_URL="${REPO/https:\/\//https://${TOKEN}@}/archive/refs/heads/${BRANCH}.tar.gz"
fi
echo "Fetching ${ARCHIVE_URL}"
TMP="$(mktemp -d)"
curl -fsSL -o "$TMP/src.tgz" "$ARCHIVE_URL"
tar -xzf "$TMP/src.tgz" -C "$TMP"
SKEL="$(find "$TMP" -type d -name skel | head -n 1)"
if [ -z "$SKEL" ]; then
  echo "ERROR: no skel/ in repo. Upload the egg/ directory as the GitHub repo root."
  exit 1
fi
mkdir -p "$DEST/bin" "$DEST/nginx/conf.d" "$DEST/php-fpm" "$DEST/logs" "$DEST/run" "$DEST/tmp/jobs" "$DEST/tmp/client_body" "$DEST/tmp/proxy" "$DEST/tmp/fastcgi" "$DEST/ssl" "$DEST/www/default/public_html"
cp -a "$SKEL/start.sh" "$DEST/start.sh"
cp -a "$SKEL/bin/." "$DEST/bin/" 2>/dev/null || true
cp -a "$SKEL/nginx/nginx.conf" "$DEST/nginx/nginx.conf" 2>/dev/null || true
[ -f "$DEST/sites.json" ] || cp -a "$SKEL/sites.json" "$DEST/sites.json" 2>/dev/null || true
[ -f "$DEST/www/default/public_html/index.php" ] || cp -a "$SKEL/www/default/public_html/index.php" "$DEST/www/default/public_html/index.php" 2>/dev/null || true
if [ -d "$SKEL/yarus/backend" ] && [ ! -f "$DEST/yarus/backend/package.json" ]; then mkdir -p "$DEST/yarus"; cp -a "$SKEL/yarus/backend" "$DEST/yarus/backend"; fi
if [ -d "$SKEL/yarus/web" ]; then mkdir -p "$DEST/www/yarus/public_html/assets"; rm -f "$DEST/www/yarus/public_html/assets"/index-*.js "$DEST/www/yarus/public_html/assets"/index-*.css; cp -a "$SKEL/yarus/web/." "$DEST/www/yarus/public_html/"; fi
chmod +x "$DEST/start.sh"
echo "NestCP files installed from ${REPO}@${BRANCH}"
rm -rf "$TMP"
ENDFETCH
fi

echo "NestCP install finished"
