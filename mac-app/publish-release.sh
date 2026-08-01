#!/usr/bin/env bash
#
# Publish a Folia Bridge mac-app release end to end:
#   1. build the universal DMG at the current mac-app/package.json version
#   2. create (or update) a GitHub release with the DMG as a public asset
#   3. point the Supabase app_settings 'mac_release' row at that asset
#
# The in-app update checker (updater.js) reads that row via
#   GET {FOLIA_API_URL}/api/bridge?action=mac-version
# so this is all it takes for installed apps on an older version to see
# the update and download it.
#
# Usage:
#   cd mac-app
#   # 1. bump "version" in package.json (and commit it), then:
#   ./publish-release.sh "What changed in this build"
#
# Prereqs:
#   - gh, authenticated (gh auth login)
#   - node, python3
#   - repo-root .env.local with SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
#
# Host note: the DMG goes to GitHub Releases on the (public) repo because
# Supabase Storage on this project caps uploads at 50 MB and the DMG is
# ~170 MB. To move hosting elsewhere, change only the URL written to the
# row — the version check stays on the Folia API.

set -euo pipefail

NOTES="${1:-New Folia Bridge build.}"

# ── locate ────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"                                   # mac-app/
REPO_ROOT="$(git rev-parse --show-toplevel)"
ENV_FILE="$REPO_ROOT/.env.local"

VERSION="$(node -p "require('./package.json').version")"
TAG="folia-bridge-v$VERSION"
BUILT_DMG="dist/Folia Bridge-$VERSION-universal.dmg"
CLEAN_NAME="folia-bridge-$VERSION-universal.dmg"   # space-free → clean URL

echo "▸ Publishing Folia Bridge $VERSION  (tag $TAG)"

# ── prereqs ───────────────────────────────────────────────────────────
command -v gh      >/dev/null || { echo "✗ gh not installed"; exit 1; }
command -v node    >/dev/null || { echo "✗ node not installed"; exit 1; }
command -v python3 >/dev/null || { echo "✗ python3 not installed"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "✗ gh not authenticated — run: gh auth login"; exit 1; }
[ -f "$ENV_FILE" ] || { echo "✗ $ENV_FILE not found"; exit 1; }

SB_URL="$(grep '^SUPABASE_URL=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"')"
SB_KEY="$(grep '^SUPABASE_SERVICE_ROLE_KEY=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"')"
[ -n "$SB_URL" ] && [ -n "$SB_KEY" ] || { echo "✗ SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing from $ENV_FILE"; exit 1; }
REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
API_BASE="${FOLIA_API_URL:-https://folia-inventory.vercel.app}"

# ── 0.5 bake the built-in bridge config into the bundle ───────────────
# bridge/builtin.env ships inside the app (extraResources), so a fresh Mac
# runs with zero manual setup — no FOLIA_API_URL / BRIDGE_TOKEN entry. The
# machine's own config (userData/bridge.env) still overrides it.
# NOTE: the DMG is a public GitHub release asset, so the token inside is
# extractable by anyone who finds it. To revoke: rotate the token
# (POST /api/bridge?action=generate-token) and republish.
echo "▸ Baking bridge/builtin.env (API URL + bridge token)"
BUILTIN_TOKEN="$(curl -sS -m 20 \
  "$SB_URL/rest/v1/users?select=username,bridgeToken&bridgeToken=not.is.null&order=username.asc" \
  -H "Authorization: Bearer $SB_KEY" -H "apikey: $SB_KEY" | python3 -c '
import json, sys
rows = [r for r in json.load(sys.stdin) if r.get("bridgeToken")]
if not rows:
    sys.exit("no user has a bridgeToken set — mint one first (generate-token)")
if len(rows) > 1:
    names = ", ".join(r["username"] for r in rows)
    sys.stderr.write("  warning: multiple users hold bridge tokens (" + names + ") — baking " + rows[0]["username"] + "\n")
print(rows[0]["bridgeToken"])
')"
[ -n "$BUILTIN_TOKEN" ] || { echo "✗ could not fetch a bridge token from Supabase"; exit 1; }
# The baked file holds a live secret — keep it out of the working tree once
# the build is done (it is gitignored as well, belt and braces).
trap 'rm -f "$SCRIPT_DIR/bridge/builtin.env"' EXIT
printf 'FOLIA_API_URL=%s\nBRIDGE_TOKEN=%s\n' "$API_BASE" "$BUILTIN_TOKEN" > "$SCRIPT_DIR/bridge/builtin.env"
echo "  baked: FOLIA_API_URL=$API_BASE, BRIDGE_TOKEN=${BUILTIN_TOKEN:0:6}…"

# ── 1. build ──────────────────────────────────────────────────────────
echo "▸ Building DMG (npm run dist)… this takes a few minutes"
BUILD_LOG="$(mktemp)"
if ! npm run dist >"$BUILD_LOG" 2>&1; then
  echo "✗ build failed:"; tail -25 "$BUILD_LOG"; rm -f "$BUILD_LOG"; exit 1
fi
rm -f "$BUILD_LOG"
[ -f "$BUILT_DMG" ] || { echo "✗ expected '$BUILT_DMG' not found after build"; exit 1; }
echo "  built: $BUILT_DMG ($(du -h "$BUILT_DMG" | cut -f1))"

# ── 2. GitHub release (clean, space-free asset name) ──────────────────
STAGE_DIR="$(mktemp -d)"
cp "$BUILT_DMG" "$STAGE_DIR/$CLEAN_NAME"
if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  echo "▸ Release $TAG exists — replacing asset + notes"
  gh release upload "$TAG" "$STAGE_DIR/$CLEAN_NAME" --repo "$REPO" --clobber
  gh release edit   "$TAG" --repo "$REPO" --title "Folia Bridge $VERSION" --notes "$NOTES" >/dev/null
else
  echo "▸ Creating release $TAG"
  gh release create "$TAG" "$STAGE_DIR/$CLEAN_NAME" --repo "$REPO" \
    --title "Folia Bridge $VERSION" --notes "$NOTES"
fi
rm -rf "$STAGE_DIR"

DMG_URL="$(gh release view "$TAG" --repo "$REPO" --json assets \
  -q ".assets[] | select(.name==\"$CLEAN_NAME\") | .url")"
[ -n "$DMG_URL" ] || { echo "✗ could not resolve asset URL from release $TAG"; exit 1; }
echo "  asset: $DMG_URL"

# ── 3. point the release row at it ────────────────────────────────────
echo "▸ Updating app_settings.mac_release → $VERSION"
BODY="$(VERSION="$VERSION" DMG_URL="$DMG_URL" NOTES="$NOTES" python3 - <<'PY'
import json, os
print(json.dumps({
    "id": "mac_release",
    "data": {
        "version": os.environ["VERSION"],
        "url": os.environ["DMG_URL"],
        "notes": os.environ["NOTES"],
    },
    "updatedBy": "publish-release.sh",
}))
PY
)"
HTTP_CODE="$(curl -sS -m 25 -o /dev/null -w '%{http_code}' -X POST "$SB_URL/rest/v1/app_settings" \
  -H "Authorization: Bearer $SB_KEY" -H "apikey: $SB_KEY" \
  -H "Content-Type: application/json" \
  -H "Prefer: resolution=merge-duplicates" \
  --data "$BODY")"
[ "$HTTP_CODE" = "201" ] || [ "$HTTP_CODE" = "200" ] || { echo "✗ row update failed (HTTP $HTTP_CODE)"; exit 1; }
echo "  row updated (HTTP $HTTP_CODE)"

# ── verify end to end ─────────────────────────────────────────────────
echo "▸ Verifying…"
SERVED="$(curl -sS -m 15 "$API_BASE/api/bridge?action=mac-version")"
echo "  API serves:     $SERVED"
case "$SERVED" in
  *"\"version\":\"$VERSION\""*) echo "  version match:  ✓" ;;
  *) echo "  version match:  ⚠ API did not report $VERSION (CDN lag? wrong FOLIA_API_URL?)" ;;
esac
DL_CODE="$(curl -s -o /dev/null -w '%{http_code}' -IL -m 30 "$DMG_URL")"
echo "  asset download: HTTP $DL_CODE"

echo
echo "✓ Published Folia Bridge $VERSION"
echo "  Installed apps on a version older than $VERSION will show the update"
echo "  on their next check (launch, the 6h timer, or 'Check for updates')."
