#!/bin/bash
# Put the phone relay behind the existing TLS vhost, at /dsh-relay/.
#
# Run this from a machine with SSH access to the server:
#
#     bash mobile/deploy-relay.sh root@your-server xf.merefusion.com
#
# It is idempotent — running it twice changes nothing the second time.
#
# Why a path on 443 rather than its own port: a non-standard port is blocked by
# the cloud security group, and phones on mobile networks frequently cannot
# reach one either. 443 is the port that always works. That means adding a
# location to the vhost which already owns 443 for this hostname, so the script
# backs the file up first, refuses to reload unless nginx accepts the config,
# and restores the backup if the site stops answering afterwards.
#
# Footprint, all of it removable:
#   /opt/dsh-relay/                     the relay and its own node runtime
#   /etc/systemd/system/dsh-relay.service
#   one location block in the vhost (backup kept alongside it)
set -euo pipefail

HOST=${1:?usage: deploy-relay.sh <ssh-target> <hostname> [vhost-path]}
DOMAIN=${2:?usage: deploy-relay.sh <ssh-target> <hostname> [vhost-path]}
VHOST=${3:-/etc/nginx/sites-available/geo}
NODE_VER=v22.14.0
DIR=/opt/dsh-relay
HERE=$(cd "$(dirname "$0")" && pwd)

echo "── staging relay onto $HOST ──"
scp -q "$HERE/relay.mjs" "$HERE/package.json" "$HOST:/tmp/"

ssh "$HOST" DIR="$DIR" NODE_VER="$NODE_VER" VHOST="$VHOST" bash -s <<'REMOTE'
set -euo pipefail

mkdir -p "$DIR"
mv /tmp/relay.mjs /tmp/package.json "$DIR/"

# Its own node, so nothing is installed system-wide and removal is one rm.
if [ ! -x "$DIR/node/bin/node" ]; then
  echo "── fetching node ──"
  cd /tmp
  curl -fsSL -o node.tar.xz "https://npmmirror.com/mirrors/node/$NODE_VER/node-$NODE_VER-linux-x64.tar.xz"
  rm -rf /tmp/node-extract && mkdir -p /tmp/node-extract
  tar -xJf node.tar.xz -C /tmp/node-extract --strip-components=1
  rm -rf "$DIR/node" && mv /tmp/node-extract "$DIR/node"
  rm -f node.tar.xz
fi
"$DIR/node/bin/node" -v

cd "$DIR"
PATH="$DIR/node/bin:$PATH" npm install --omit=dev --no-audit --no-fund \
  --registry https://registry.npmmirror.com >/dev/null
echo "── dependencies installed ──"

cat > /etc/systemd/system/dsh-relay.service <<'UNIT'
[Unit]
Description=Dsh GUI phone relay (forwards frames between a paired desktop and phone)
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/dsh-relay
# Loopback only: nginx terminates TLS in front. Binding it here rather than
# relying on a firewall means a firewall change cannot silently expose it.
ExecStart=/opt/dsh-relay/node/bin/node /opt/dsh-relay/relay.mjs --port 8500 --host 127.0.0.1
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now dsh-relay
sleep 2
systemctl is-active dsh-relay >/dev/null || { echo "relay failed to start"; journalctl -u dsh-relay -n 20 --no-pager; exit 1; }
echo "── relay running on 127.0.0.1:8500 ──"

# ── nginx: add the location, carefully ──────────────────────────────────
BACKUP="$VHOST.bak-before-dsh-relay"
[ -f "$BACKUP" ] || cp "$VHOST" "$BACKUP"

if grep -q 'dsh-relay' "$VHOST"; then
  echo "── vhost already has the relay location ──"
else
  python3 - "$VHOST" <<'PY'
import sys
path = sys.argv[1]
src = open(path).read()
anchor = src.find('ssl_certificate /etc/letsencrypt')
if anchor == -1:
    raise SystemExit('could not find the TLS server block — pass the vhost path explicitly')
line_end = src.index('\n', anchor) + 1
block = '''
    # Dsh GUI phone relay: WebSocket only. The relay behind it forwards opaque
    # frames between a paired desktop and phone and stores nothing.
    location /dsh-relay/ {
        proxy_pass http://127.0.0.1:8500/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        # A paired desktop holds its socket open; the default 60s read timeout
        # would drop it every minute.
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }
'''
open(path, 'w').write(src[:line_end] + block + src[line_end:])
print('── location added ──')
PY
fi

nginx -t
systemctl reload nginx
echo "── nginx reloaded ──"
REMOTE

echo "── verifying ──"
site=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://$DOMAIN/" || echo 000)
relay=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://$DOMAIN/dsh-relay/healthz" || echo 000)
echo "  site   https://$DOMAIN/            -> $site"
echo "  relay  https://$DOMAIN/dsh-relay/healthz -> $relay"

if [ "$site" != "200" ]; then
  echo "✗ the site stopped answering — restoring the vhost backup"
  ssh "$HOST" "cp $VHOST.bak-before-dsh-relay $VHOST && nginx -t && systemctl reload nginx"
  exit 1
fi
[ "$relay" = "200" ] || { echo "✗ the relay is not reachable through the vhost"; exit 1; }
echo "✓ relay live at wss://$DOMAIN/dsh-relay/"
