#!/usr/bin/env bash
set -u

# Run this on the Mac mini. It prepares the machine for Codex remote/handoff use
# without changing repository contents or touching Syncthing temporary files.

PROJECT_NAME="four-way-shuttle-sim-2.0"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." 2>/dev/null && pwd -P)"

if [[ ! -d "$PROJECT_ROOT/.git" || "$(basename "$PROJECT_ROOT")" != "$PROJECT_NAME" ]]; then
  CANDIDATE="$HOME/codex projects/$PROJECT_NAME"
  if [[ -d "$CANDIDATE" ]]; then
    PROJECT_ROOT="$CANDIDATE"
  fi
fi

OUT_DIR="$PROJECT_ROOT/output/remote-setup"
mkdir -p "$OUT_DIR"
REPORT="$OUT_DIR/mac-mini-remote-readiness-$(date +%Y%m%d-%H%M%S).txt"

exec > >(tee "$REPORT") 2>&1

section() {
  printf '\n=== %s ===\n' "$1"
}

status_line() {
  printf '%-28s %s\n' "$1" "$2"
}

run_optional() {
  local label="$1"
  shift
  section "$label"
  "$@" || true
}

section "Codex Mac mini remote setup"
status_line "Started" "$(date)"
status_line "Project root" "$PROJECT_ROOT"
status_line "Report" "$REPORT"

section "Keep Mac mini awake"
if [[ "${CODEX_REMOTE_NO_CAFFEINATE:-0}" == "1" ]]; then
  status_line "caffeinate" "skipped by CODEX_REMOTE_NO_CAFFEINATE=1"
elif command -v caffeinate >/dev/null 2>&1; then
  AWAKE_SECONDS="${CODEX_REMOTE_AWAKE_SECONDS:-86400}"
  caffeinate -dimsu -t "$AWAKE_SECONDS" >/tmp/codex-mac-mini-caffeinate.log 2>&1 &
  CAFFEINATE_PID="$!"
  echo "$CAFFEINATE_PID" > "$OUT_DIR/caffeinate.pid"
  status_line "caffeinate" "started pid=$CAFFEINATE_PID for ${AWAKE_SECONDS}s"
else
  status_line "caffeinate" "not found"
fi

section "Machine identity"
USER_NAME="$(whoami)"
LOCAL_HOST_NAME="$(scutil --get LocalHostName 2>/dev/null || hostname -s)"
COMPUTER_NAME="$(scutil --get ComputerName 2>/dev/null || hostname)"
HOST_NAME="$(hostname)"
status_line "User" "$USER_NAME"
status_line "LocalHostName" "$LOCAL_HOST_NAME"
status_line "ComputerName" "$COMPUTER_NAME"
status_line "hostname" "$HOST_NAME"

section "Network addresses"
IP_LINES=""
for IFACE in en0 en1 en2 bridge100; do
  IP="$(ipconfig getifaddr "$IFACE" 2>/dev/null || true)"
  if [[ -n "$IP" ]]; then
    status_line "$IFACE" "$IP"
    IP_LINES="${IP_LINES}${IFACE} ${IP}"$'\n'
  fi
done
if [[ -z "$IP_LINES" ]]; then
  echo "No active IPv4 address found via ipconfig."
fi

section "Remote Login / SSH"
REMOTE_LOGIN_STATUS="$(systemsetup -getremotelogin 2>/dev/null || true)"
status_line "Remote Login" "${REMOTE_LOGIN_STATUS:-unknown}"
if echo "$REMOTE_LOGIN_STATUS" | grep -qi 'administrator access'; then
  if [[ -t 0 ]]; then
    echo "Checking Remote Login requires an administrator password on this Mac."
    printf 'Check Remote Login with sudo now? [y/N] '
    read -r CHECK_SSH
    case "$CHECK_SSH" in
      y|Y|yes|YES)
        REMOTE_LOGIN_STATUS="$(sudo systemsetup -getremotelogin 2>/dev/null || true)"
        status_line "Remote Login sudo" "${REMOTE_LOGIN_STATUS:-unknown}"
        ;;
      *)
        echo "Skipped sudo Remote Login check."
        ;;
    esac
  else
    echo "No interactive terminal. Open System Settings > General > Sharing > Remote Login."
  fi
fi
if echo "$REMOTE_LOGIN_STATUS" | grep -qi 'Off'; then
  echo "Remote Login is OFF."
  if [[ -t 0 ]]; then
    printf 'Enable Remote Login now? This will run: sudo systemsetup -setremotelogin on [y/N] '
    read -r ENABLE_SSH
    case "$ENABLE_SSH" in
      y|Y|yes|YES)
        sudo systemsetup -setremotelogin on || true
        REMOTE_LOGIN_STATUS="$(systemsetup -getremotelogin 2>/dev/null || true)"
        status_line "Remote Login after" "${REMOTE_LOGIN_STATUS:-unknown}"
        ;;
      *)
        echo "Skipped enabling Remote Login."
        ;;
    esac
  else
    echo "No interactive terminal. Open System Settings > General > Sharing > Remote Login."
  fi
fi

section "Codex"
if command -v codex >/dev/null 2>&1; then
  status_line "codex path" "$(command -v codex)"
  codex --version || true
else
  echo "codex was not found on PATH."
  echo "Open the Codex app on this Mac mini and install/enable CLI access, then rerun this script."
fi
if [[ -d "/Applications/Codex.app" ]]; then
  status_line "Codex.app" "/Applications/Codex.app"
  if [[ "${CODEX_REMOTE_NO_OPEN_CODEX:-0}" == "1" ]]; then
    status_line "open Codex" "skipped by CODEX_REMOTE_NO_OPEN_CODEX=1"
  else
    open -a Codex >/dev/null 2>&1 || true
  fi
else
  status_line "Codex.app" "not found in /Applications"
fi

section "Project"
if [[ -d "$PROJECT_ROOT/.git" ]]; then
  cd "$PROJECT_ROOT" || exit 1
  status_line "git branch" "$(git branch --show-current 2>/dev/null || echo unknown)"
  status_line "git root" "$(git rev-parse --show-toplevel 2>/dev/null || echo unknown)"
  git status --short --branch || true
  if [[ -f "docs/mac-mini-remote-continuation-2026-06-20.md" ]]; then
    status_line "handoff doc" "present"
  else
    status_line "handoff doc" "missing"
  fi
else
  echo "Project Git checkout was not found."
  echo "Expected one of:"
  echo "  $SCRIPT_DIR/.."
  echo "  $HOME/codex projects/$PROJECT_NAME"
fi

section "Node / package tooling"
status_line "node" "$(command -v node 2>/dev/null || echo missing)"
node --version 2>/dev/null || true
status_line "pnpm" "$(command -v pnpm 2>/dev/null || echo missing)"
pnpm --version 2>/dev/null || true

section "Syncthing"
if command -v syncthing >/dev/null 2>&1; then
  status_line "syncthing" "$(command -v syncthing)"
  syncthing --version 2>/dev/null || true
  if syncthing cli show system >/dev/null 2>&1; then
    syncthing cli show system | sed -n '1,80p' || true
    syncthing cli show folder codex-projects 2>/dev/null | sed -n '1,120p' || true
  else
    echo "Syncthing CLI is installed, but local GUI/API is not reachable."
  fi
else
  echo "syncthing CLI was not found."
fi

section "Files for current Mac"
SSH_SNIPPET="$OUT_DIR/mac-mini-ssh-config-snippet.txt"
{
  echo "Host mac-mini-codex"
  echo "  HostName ${LOCAL_HOST_NAME}.local"
  echo "  User ${USER_NAME}"
  echo "  AddKeysToAgent yes"
  echo "  UseKeychain yes"
} > "$SSH_SNIPPET"
status_line "SSH config snippet" "$SSH_SNIPPET"

PROMPT_FILE="$OUT_DIR/mac-mini-codex-continuation-prompt.md"
{
  echo "# Continue four-way-shuttle-sim on Mac mini"
  echo
  echo "Project path:"
  echo
  echo '```text'
  echo "$PROJECT_ROOT"
  echo '```'
  echo
  echo "Please read these first:"
  echo
  echo "1. docs/mac-mini-remote-continuation-2026-06-20.md"
  echo "2. README.md"
  echo "3. mac-mini-transfer-handoff.md"
  echo
  echo "Then continue the current validation cautiously:"
  echo
  echo '```bash'
  echo './node_modules/.bin/tsc -p packages/shuttle-sim-core/tsconfig.json --noEmit'
  echo './node_modules/.bin/tsx scripts/run-physical-24h-amr-audit.ts \'
  echo '  --hours 2 \'
  echo '  --audit-every-sec 30 \'
  echo '  --out output/review/physical-2h-after-bottom-a-spine-yield-audit.json \'
  echo '  --checkpoint-dir output/review/physical-2h-after-bottom-a-spine-yield-checkpoints \'
  echo '  --stop-on-critical'
  echo '```'
  echo
  echo "Do not jump to 24h until the 2h stop-on-critical run passes."
} > "$PROMPT_FILE"
status_line "Continuation prompt" "$PROMPT_FILE"

section "How to connect from current Mac"
echo "1. On the current Mac, test one of these:"
echo "   ssh ${USER_NAME}@${LOCAL_HOST_NAME}.local"
if [[ -n "$IP_LINES" ]]; then
  while read -r IFACE IP; do
    [[ -z "${IP:-}" ]] && continue
    echo "   ssh ${USER_NAME}@${IP}"
  done <<< "$IP_LINES"
fi
echo "2. If SSH works, add the snippet file above to ~/.ssh/config on the current Mac."
echo "3. In Codex App: Settings > Connections > add/enable the host and choose:"
echo "   $PROJECT_ROOT"
echo "4. Then hand off the thread from the thread footer to the Mac mini host."

section "Done"
echo "Report saved to:"
echo "$REPORT"
echo
echo "You can close this Terminal window after copying the SSH address, but leave Codex open on the Mac mini."
