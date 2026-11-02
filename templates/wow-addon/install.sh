#!/usr/bin/env bash
# Copy the {{pascal}} addon into the game's AddOns folder.
#
# Usage: ./install.sh [path/to/Interface/AddOns]
#        or set WOW_ADDONS_DIR.
set -euo pipefail

DEFAULT_DIR="$HOME/Faugus/battlenet/drive_c/Program Files (x86)/World of Warcraft/_forever_/Interface/AddOns"
ADDONS="${1:-${WOW_ADDONS_DIR:-$DEFAULT_DIR}}"

cd "$(dirname "$0")"

if [[ ! -d "$ADDONS" ]]; then
    echo "error: $ADDONS does not exist." >&2
    exit 1
fi

new=0
[[ -d "$ADDONS/{{pascal}}" ]] || new=1

# The folder is entirely ours, so mirror it exactly.
rsync -a --delete {{pascal}}/ "$ADDONS/{{pascal}}/"

echo "Installed {{pascal}} ($(git describe --always --dirty 2>/dev/null || echo untracked)) into:"
echo "  $ADDONS/{{pascal}}"
if (( new )); then
    echo "New addon folder: fully restart WoW (a /reload won't find it)."
else
    echo "Run /reload in game."
fi
