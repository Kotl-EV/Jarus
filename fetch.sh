#!/bin/bash
# Download NestCP runtime files (start.sh, nginx, bin) from GitHub into $1.
# Never overwrites www/ or an existing sites.json.
set -euo pipefail

DEST="${1:-.}"
REPO="${GIT_REPO:-${NESTCP_GIT_REPO:-}}"
BRANCH="${GIT_BRANCH:-${NESTCP_GIT_BRANCH:-main}}"
TOKEN="${GIT_TOKEN:-${NESTCP_GIT_TOKEN:-}}"

mkdir -p "$DEST"

if [ -z "$REPO" ]; then
    echo "GIT_REPO is empty — skip GitHub fetch"
    exit 0
fi

REPO="${REPO%.git}"
REPO="${REPO%/}"
case "$REPO" in
    git@github.com:*)
        REPO="https://github.com/${REPO#git@github.com:}"
        ;;
esac

if [ -n "$TOKEN" ]; then
    ARCHIVE_URL="$(echo "$REPO" | sed "s#https://github.com/#https://x-access-token:${TOKEN}@github.com/#")/archive/refs/heads/${BRANCH}.tar.gz"
else
    ARCHIVE_URL="${REPO}/archive/refs/heads/${BRANCH}.tar.gz"
fi

echo "Fetching NestCP files from ${REPO}@${BRANCH}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if ! curl -fsSL -o "$TMP/src.tgz" "$ARCHIVE_URL"; then
    echo "ERROR: could not download archive."
    echo "Check GIT_REPO / GIT_BRANCH. Private repo needs GIT_TOKEN."
    exit 1
fi

tar -xzf "$TMP/src.tgz" -C "$TMP"
SKEL="$(find "$TMP" -type d -name skel | head -n 1 || true)"
if [ -z "$SKEL" ]; then
    HIT="$(find "$TMP" -maxdepth 3 -name start.sh | head -n 1 || true)"
    [ -n "$HIT" ] && SKEL="$(dirname "$HIT")"
fi
if [ -z "$SKEL" ] || [ ! -d "$SKEL" ]; then
    echo "ERROR: archive has no skel/ and no start.sh. Upload the egg/ folder as the GitHub repo root."
    find "$TMP" -maxdepth 3 -print
    exit 1
fi

mkdir -p "$DEST/bin" "$DEST/nginx/conf.d" "$DEST/php-fpm" "$DEST/logs" "$DEST/run" \
    "$DEST/tmp/jobs" "$DEST/tmp/client_body" "$DEST/tmp/proxy" "$DEST/tmp/fastcgi" \
    "$DEST/ssl" "$DEST/www/default/public_html"

cp -a "$SKEL/start.sh" "$DEST/start.sh"
if [ -d "$SKEL/bin" ]; then
    cp -a "$SKEL/bin/." "$DEST/bin/"
fi
if [ -f "$SKEL/nginx/nginx.conf" ]; then
    cp -a "$SKEL/nginx/nginx.conf" "$DEST/nginx/nginx.conf"
fi
if [ ! -f "$DEST/sites.json" ] && [ -f "$SKEL/sites.json" ]; then
    cp -a "$SKEL/sites.json" "$DEST/sites.json"
fi
if [ ! -f "$DEST/www/default/public_html/index.php" ] && [ -f "$SKEL/www/default/public_html/index.php" ]; then
    cp -a "$SKEL/www/default/public_html/index.php" "$DEST/www/default/public_html/index.php"
fi
if [ -d "$SKEL/yarus/backend" ] && [ ! -f "$DEST/yarus/backend/package.json" ]; then
    mkdir -p "$DEST/yarus"
    cp -a "$SKEL/yarus/backend" "$DEST/yarus/backend"
fi
if [ -d "$SKEL/yarus/web" ] && [ ! -f "$DEST/www/yarus/public_html/index.html" ]; then
    mkdir -p "$DEST/www/yarus/public_html"
    cp -a "$SKEL/yarus/web/." "$DEST/www/yarus/public_html/"
fi
chmod +x "$DEST/start.sh" 2>/dev/null || true
echo "NestCP files installed from ${REPO}@${BRANCH}"
