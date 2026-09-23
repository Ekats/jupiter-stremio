#!/usr/bin/env bash
# Clean build and run the ERR Jupiter Stremio addon.
#
#   ./install.sh              clean build, run in the foreground
#   ./install.sh --service    clean build, install+start a systemd user service
#   ./install.sh --index      also build the catalogue index (~40 min)
#   ./install.sh --service --index

set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-7000}"
SERVICE=0
INDEX=0
for arg in "$@"; do
  case "$arg" in
    --service) SERVICE=1 ;;
    --index)   INDEX=1 ;;
    -h|--help) sed -n '2,7p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 1 ;;
  esac
done

say() { printf '\n\033[1m==>\033[0m %s\n' "$1"; }
die() { printf '\033[31merror:\033[0m %s\n' "$1" >&2; exit 1; }

say "Checking Node"
command -v node >/dev/null || die "node not found — install Node 22 or newer"
major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 22 ] || die "Node $major found, need 22+ (uses the built-in node:sqlite)"
echo "  node $(node -v)"

say "Freeing port $PORT"
if systemctl --user is-active --quiet jupiter-stremio.service 2>/dev/null; then
  systemctl --user stop jupiter-stremio.service
  echo "  stopped existing jupiter-stremio service"
fi
# Anything else still holding the port (a stray `npm start`) is fatal: better to
# say so than to fail later with EADDRINUSE.
if command -v ss >/dev/null && ss -ltn "sport = :$PORT" 2>/dev/null | grep -q LISTEN; then
  die "port $PORT is still in use by another process — stop it and re-run"
fi
echo "  port $PORT free"

say "Clean install"
rm -rf node_modules
npm ci --no-audit --no-fund
echo "  dependencies installed"

if [ "$INDEX" = 1 ]; then
  say "Building index (resumable — safe to interrupt and re-run)"
  npm run index
  npm run index:stats
fi

if [ "$SERVICE" = 1 ]; then
  say "Installing systemd user service"
  mkdir -p "$HOME/.config/systemd/user"
  cat > "$HOME/.config/systemd/user/jupiter-stremio.service" <<UNIT
[Unit]
Description=ERR Jupiter Stremio addon
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$PWD
ExecStart=$(command -v node) src/server.js
Environment=PORT=$PORT
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload
  systemctl --user enable --now jupiter-stremio.service
  sleep 3
  systemctl --user is-active --quiet jupiter-stremio.service \
    || die "service failed to start — see: journalctl --user -u jupiter-stremio -n 30"
  echo "  service running and enabled at login"
  printf '\n\033[1mAdd this in Stremio → Addons:\033[0m\n  http://127.0.0.1:%s/manifest.json\n\n' "$PORT"
  echo "  logs:    journalctl --user -u jupiter-stremio -f"
  echo "  restart: systemctl --user restart jupiter-stremio"
else
  printf '\n\033[1mAdd this in Stremio → Addons:\033[0m\n  http://127.0.0.1:%s/manifest.json\n\n' "$PORT"
  say "Starting (Ctrl-C to stop)"
  exec npm start
fi
