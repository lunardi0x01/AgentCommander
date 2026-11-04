#!/usr/bin/env bash
# Install Agent Commander on an Omarchy machine: tools, server, service,
# Tailscale address and desktop launcher. Safe to run again.
#
#   npm run install-app          (or: bash deploy/install.sh)
#
# DRY_RUN=1 prints what would change without doing it.
# TS_HTTPS_PORT (default 10000) and PORT (default 4317) pick the ports.

set -euo pipefail

APP_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PORT=${PORT:-4317}
TS_HTTPS_PORT=${TS_HTTPS_PORT:-10000}
DATA_DIR=$HOME/.local/share/agent-commander
REGISTRY=https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json
TODO=()

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33m!!  %s\033[0m\n' "$*" >&2; TODO+=("$*"); }
die() { printf '\033[31mxx  %s\033[0m\n' "$*" >&2; exit 1; }
run() {
  if [[ -n ${DRY_RUN:-} ]]; then printf '    (dry run) %s\n' "$*"; else "$@"; fi
}

# 1. Tools: mise provides node, claude and agy, as on the other Omarchy machines.
say "Checking tools"
command -v mise >/dev/null || die "mise isn't installed. Omarchy ships it; install it first (omarchy pkg add mise)."
for cmd in curl jq unzip sha256sum; do
  command -v "$cmd" >/dev/null || die "$cmd is required."
done

node_major() { mise exec -- node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if (( $(node_major) < 24 )); then
  say "Installing Node (24 or newer is needed to run the server's TypeScript)"
  run mise use -g node@latest
fi
for tool in claude agy; do
  if mise which "$tool" >/dev/null 2>&1; then
    echo "    $tool: $(mise which "$tool")"
  else
    say "Installing $tool with mise"
    run mise use -g "$tool@latest"
  fi
done
run mise reshim

# 2. Antigravity's ACP server (Gemini sessions): separate from agy, from the ACP registry.
say "Checking Antigravity's ACP server"
case $(uname -m) in
  x86_64) PLATFORM=linux-x86_64 ;;
  aarch64 | arm64) PLATFORM=linux-aarch64 ;;
  *) die "No Antigravity ACP server for $(uname -m)." ;;
esac
entry=$(curl -fsSL --max-time 30 "$REGISTRY" | jq -c --arg p "$PLATFORM" \
  '.agents[] | select(.id=="antigravity-acp") | {version, url: .distribution.binary[$p].archive, sha: .distribution.binary[$p].sha256}') ||
  die "Couldn't read the ACP registry at $REGISTRY."
version=$(jq -r .version <<<"$entry")
url=$(jq -r .url <<<"$entry")
sha=$(jq -r .sha <<<"$entry")
dest=$DATA_DIR/agy-acp/v$version/bin
if [[ -x $dest/agy_acp_server.par ]]; then
  echo "    v$version already installed"
elif [[ -n ${DRY_RUN:-} ]]; then
  echo "    (dry run) would download v$version from $url"
else
  say "Downloading the ACP server v$version (large, ~800 MB)"
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  curl -fL --progress-bar -o "$tmp/acp.zip" "$url"
  [[ $(sha256sum "$tmp/acp.zip" | cut -d' ' -f1) == "$sha" ]] || die "ACP server checksum mismatch; not installing it."
  mkdir -p "$dest"
  unzip -q -o "$tmp/acp.zip" -d "$dest"
  chmod +x "$dest"/agy_acp_server.par "$dest"/localharness_external 2>/dev/null || true
fi

# 3. The app.
say "Installing dependencies and building the UI"
cd "$APP_DIR"
run mise exec -- npm ci || die "npm ci failed. node-pty compiles native code: check that base-devel and python are installed."
run mise exec -- npm run build

# 4. Systemd user service, started at boot.
say "Installing the service"
UNIT_DIR=$HOME/.config/systemd/user
run mkdir -p "$UNIT_DIR"
if [[ -z ${DRY_RUN:-} ]]; then
  sed "s#@APP_DIR@#$APP_DIR#" "$APP_DIR/deploy/agent-commander.service" >"$UNIT_DIR/agent-commander.service"
fi
run systemctl --user daemon-reload
run systemctl --user enable --now agent-commander
run loginctl enable-linger "$USER" 2>/dev/null || warn "Couldn't enable linger; run 'loginctl enable-linger $USER' so the service starts at boot."

# 5. Wait for it to answer.
if [[ -z ${DRY_RUN:-} ]]; then
  for _ in $(seq 1 30); do
    curl -fsS "http://127.0.0.1:$PORT/api/machine" >/dev/null 2>&1 && break
    sleep 1
  done
  curl -fsS "http://127.0.0.1:$PORT/api/machine" >/dev/null 2>&1 ||
    die "The server isn't answering on port $PORT. See: journalctl --user -u agent-commander -n 50"
  echo "    server is up on 127.0.0.1:$PORT"
fi

# 6. Tailscale address.
say "Setting up the Tailscale address"
URL=http://127.0.0.1:$PORT
if ! command -v tailscale >/dev/null; then
  warn "Tailscale isn't installed (omarchy pkg add tailscale); the launcher will use $URL, which only works on this machine."
else
  state=$(tailscale status --json 2>/dev/null | jq -r '.BackendState // empty' || true)
  dns=$(tailscale status --json 2>/dev/null | jq -r '.Self.DNSName // empty' | sed 's/\.$//' || true)
  if [[ $state != Running || -z $dns ]]; then
    warn "Tailscale isn't connected. Run 'sudo tailscale up', then run this installer again."
  else
    if tailscale serve status 2>/dev/null | grep -A1 ":$TS_HTTPS_PORT " | grep -q "127.0.0.1:$PORT"; then
      echo "    tailscale serve already set"
    elif ! run tailscale serve --bg --https="$TS_HTTPS_PORT" "http://127.0.0.1:$PORT"; then
      warn "tailscale serve failed. Run: sudo tailscale serve --bg --https=$TS_HTTPS_PORT http://127.0.0.1:$PORT"
    fi
    URL=https://$dns:$TS_HTTPS_PORT
  fi
fi

# 7. Desktop launcher.
say "Creating the desktop launcher"
if command -v omarchy >/dev/null; then
  run omarchy webapp install "Agent Commander" "$URL" "$APP_DIR/deploy/icon.png"
else
  warn "The omarchy command wasn't found, so no launcher was made. Open $URL in a browser."
fi

# 8. Logins we can't do for the user.
say "Checking logins"
if claude auth status 2>/dev/null | jq -e '.loggedIn' >/dev/null 2>&1; then
  echo "    claude: signed in"
else
  warn "Claude Code isn't signed in. Run: claude   (then /login)"
fi
warn_agy=1
[[ -d $HOME/.gemini ]] && warn_agy=
[[ -n $warn_agy ]] && warn "Antigravity may not be signed in. Run: agy   (sign in once; Gemini sessions use that login)"

echo
say "Done: $URL"
if ((${#TODO[@]})); then
  echo "Still to do:"
  printf '  - %s\n' "${TODO[@]}"
fi
