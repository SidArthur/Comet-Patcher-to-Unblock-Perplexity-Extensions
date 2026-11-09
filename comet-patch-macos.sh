#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Comet Extension Unblocker for macOS (v2 – policy method)
# -----------------------------------------------------------------------------
# Comet (Perplexity's Chromium-based browser) ships a built-in ExtensionSettings
# policy that blocks every extension from running on *.perplexity.ai. That is
# why Complexity, ad blockers, userscript managers etc. do nothing on the
# Perplexity site or the Comet new-tab page.
#
# v1 of this script flipped "Allow-external-extensions-scripting-on-NTP" in
# Local State right before launch. Current Comet builds no longer honour (or
# even write) that key, so the wrapper-app approach is dead.
#
# v2 uses the method found by the Complexity developer (pnd280): install a
# *managed* Chromium policy for Comet's bundle id that explicitly re-allows
# *://*.perplexity.ai for all extensions. Managed policies win over the
# browser's built-in defaults, survive updates, and need no wrapper app.
#
#   File written:  /Library/Managed Preferences/ai.perplexity.comet.plist
#   Policy:        ExtensionSettings -> "*" -> runtime_allowed_hosts
#
# Needs sudo ONCE (that directory is root-owned). Nothing inside Comet.app is
# touched. Verify afterwards at  comet://policy  (ExtensionSettings is listed).
#
# Usage:
#   bash comet-patch-macos.sh              # install (or report already enabled)
#   bash comet-patch-macos.sh --status     # check only
#   bash comet-patch-macos.sh --uninstall  # remove the policy + old v1 wrapper
# -----------------------------------------------------------------------------

set -euo pipefail

BUNDLE_ID="ai.perplexity.comet"
PREFS_DIR="/Library/Managed Preferences"
PLIST_PATH="${PREFS_DIR}/${BUNDLE_ID}.plist"
HOST_PATTERN="*://*.perplexity.ai"

# Leftovers from v1 (wrapper-app method) – cleaned up on install/uninstall.
OLD_APP="${HOME}/Applications/Comet - CPLX.app"
OLD_LOG="${HOME}/Library/Logs/Comet-CPLX.log"
OLD_BACKUP="${HOME}/Library/Application Support/Comet/Local State.cplx.bak"

msg()  { printf "%s\n" "$*" >&2; }
ok()   { printf "✔ %s\n" "$*" >&2; }
warn() { printf "⚠ %s\n" "$*" >&2; }
err()  { printf "✖ %s\n" "$*" >&2; }

[[ "$(uname)" == "Darwin" ]] || { err "This script only works on macOS."; exit 1; }

is_enabled() {
  # `defaults read` on the managed-prefs domain shows what Comet will see.
  defaults read "${PREFS_DIR}/${BUNDLE_ID}" ExtensionSettings 2>/dev/null \
    | grep -Fq "$HOST_PATTERN"
}

comet_running() { pgrep -xq "Comet" 2>/dev/null; }

restart_hint() {
  if comet_running; then
    warn "Comet is running. Quit it fully (Cmd+Q) and reopen for the policy to apply."
  else
    msg "Open Comet normally (the regular Dock icon is fine now)."
  fi
  msg "Check:  comet://policy  should list ExtensionSettings with ${HOST_PATTERN}."
}

remove_v1_leftovers() {
  local removed=0
  if [[ -d "$OLD_APP" ]]; then rm -rf "$OLD_APP"; removed=1; fi
  if [[ -f "$OLD_LOG" ]]; then rm -f "$OLD_LOG"; removed=1; fi
  if [[ -f "$OLD_BACKUP" ]]; then rm -f "$OLD_BACKUP"; removed=1; fi
  [[ $removed -eq 1 ]] && ok "Removed the old v1 'Comet - CPLX' wrapper app / log / backup."
  return 0
}

install_policy() {
  if is_enabled; then
    ok "Policy already installed – extensions are allowed on ${HOST_PATTERN}."
    remove_v1_leftovers
    restart_hint
    return 0
  fi

  msg "Installing managed policy for ${BUNDLE_ID} (sudo password needed once)…"
  sudo mkdir -p "$PREFS_DIR"

  # Write the whole plist atomically instead of several PlistBuddy edits.
  # "*" applies to every extension; runtime_allowed_hosts overrides Comet's
  # built-in runtime_blocked_hosts for perplexity.ai.
  sudo tee "$PLIST_PATH" >/dev/null <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>ExtensionSettings</key>
  <dict>
    <key>*</key>
    <dict>
      <key>runtime_allowed_hosts</key>
      <array>
        <string>${HOST_PATTERN}</string>
      </array>
      <key>runtime_blocked_hosts</key>
      <array/>
    </dict>
  </dict>
</dict>
</plist>
PLIST
  sudo chown root:wheel "$PLIST_PATH"
  sudo chmod 644 "$PLIST_PATH"
  # Make cfprefsd pick up the new managed domain right away.
  sudo killall cfprefsd 2>/dev/null || true

  if is_enabled; then
    ok "Policy installed at: ${PLIST_PATH}"
  else
    err "Wrote the file but could not read the policy back. Check ${PLIST_PATH}."
    exit 1
  fi

  remove_v1_leftovers
  restart_hint
}

uninstall_policy() {
  if [[ -f "$PLIST_PATH" ]]; then
    msg "Removing ${PLIST_PATH} (sudo password needed once)…"
    sudo rm -f "$PLIST_PATH"
    sudo killall cfprefsd 2>/dev/null || true
    ok "Policy removed. Comet will block extensions on perplexity.ai again after a restart."
  else
    msg "No policy file found at ${PLIST_PATH}; nothing to remove."
  fi
  remove_v1_leftovers
}

status() {
  if is_enabled; then
    ok "ENABLED – ${PLIST_PATH} allows extensions on ${HOST_PATTERN}."
  else
    msg "DISABLED – no managed policy for ${BUNDLE_ID}."
  fi
  [[ -d "$OLD_APP" ]] && warn "Old v1 wrapper app still present: ${OLD_APP} (run install or --uninstall to clean it up)."
  return 0
}

case "${1:-}" in
  --status|-s)      status ;;
  --uninstall|-u)   uninstall_policy ;;
  --help|-h)        sed -n '2,30p' "$0" ;;
  "")               install_policy ;;
  *)                err "Unknown option: $1 (use --status, --uninstall, or no option to install)"; exit 2 ;;
esac
