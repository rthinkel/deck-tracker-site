#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$ROOT/dist-site"
TMP="$(mktemp -d)"
UPDATE_BASE_URL="https://decktracker.r0hi.xyz"
CACHE_KEY="${COMMIT_REF:-${DEPLOY_ID:-repo-deploy}}"

cleanup() {
  rm -rf "$TMP"
}
trap cleanup EXIT

rm -rf "$OUT"
mkdir -p "$OUT"

# Copy the static website into an isolated publish directory while leaving
# build-only files and updater payloads out of source control. This also means
# future static files added to the repository are deployed automatically.
(
  cd "$ROOT"
  tar \
    --exclude='./.git' \
    --exclude='./dist-site' \
    --exclude='./build-site.sh' \
    --exclude='./netlify.toml' \
    --exclude='./latest.json' \
    --exclude='./decktracker' \
    --exclude='./RELEASE_NOTES.md' \
    -cf - .
) | tar -C "$OUT" -xf -

# A repository-driven website deployment must never erase the updater payload
# already serving DeckTracker clients. Pull the current production manifest and
# executable into this deploy before Netlify swaps it into production.
curl --fail --location --silent --show-error --retry 6 --retry-delay 2 \
  -H 'Cache-Control: no-cache' \
  "$UPDATE_BASE_URL/latest.json?preserve=$CACHE_KEY" \
  -o "$TMP/latest.json"

curl --fail --location --silent --show-error --retry 6 --retry-delay 2 \
  -H 'Cache-Control: no-cache' \
  "$UPDATE_BASE_URL/decktracker?preserve=$CACHE_KEY" \
  -o "$TMP/decktracker"

# Verify exactly the same invariants enforced by the DeckTracker client before
# allowing this website deployment to continue.
python3 - "$TMP/latest.json" "$TMP/decktracker" <<'PY'
import hashlib
import json
import pathlib
import sys

manifest_path = pathlib.Path(sys.argv[1])
binary_path = pathlib.Path(sys.argv[2])
manifest = json.loads(manifest_path.read_text())
binary = binary_path.read_bytes()

required = {'build', 'sha256', 'size'}
missing = required.difference(manifest)
if missing:
    raise SystemExit(f"updater manifest missing fields: {', '.join(sorted(missing))}")

if manifest['size'] != len(binary):
    raise SystemExit(f"updater size mismatch: {len(binary)} != {manifest['size']}")

actual_hash = hashlib.sha256(binary).hexdigest()
if actual_hash != str(manifest['sha256']).lower():
    raise SystemExit('updater SHA256 verification failed')

header = binary[:20]
if not (
    len(header) >= 20
    and header[:4] == b'\x7fELF'
    and header[4] == 2
    and header[5] == 1
    and int.from_bytes(header[18:20], 'little') == 0x3E
):
    raise SystemExit('updater payload is not an x86_64 ELF executable')

if not str(manifest['build']).strip():
    raise SystemExit('updater manifest has an empty build id')
PY

cp "$TMP/latest.json" "$OUT/latest.json"
install -m 755 "$TMP/decktracker" "$OUT/decktracker"

# RELEASE_NOTES.md is not required by the client, but keep it available when it
# exists on the current production updater host.
if curl --fail --location --silent --show-error \
  -H 'Cache-Control: no-cache' \
  "$UPDATE_BASE_URL/RELEASE_NOTES.md?preserve=$CACHE_KEY" \
  -o "$TMP/RELEASE_NOTES.md"; then
  cp "$TMP/RELEASE_NOTES.md" "$OUT/RELEASE_NOTES.md"
fi

echo "Prepared website deploy with verified DeckTracker updater payload."
