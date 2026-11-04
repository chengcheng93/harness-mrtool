#!/usr/bin/env bash
set -euo pipefail

readonly REPOSITORY="chengcheng93/harness-mrtool"
readonly RELEASE_HOST="github.com"
readonly MAX_ARCHIVE_BYTES=$((256 * 1024 * 1024))
readonly MAX_ENTRY_BYTES=$((256 * 1024 * 1024))
readonly MAX_EXPANDED_BYTES=$((512 * 1024 * 1024))
readonly MARKER_NAME=".harness-mrtool-install.json"

die() { printf '%s\n' "harness-mrtool install failed: $1" >&2; exit 1; }
usage() { printf 'usage: %s --tag cli-vX.Y.Z --sha256 HEX [--destination DIR] | %s --update [--destination DIR] | %s --repair [--destination DIR]\n' "$0" "$0" "$0" >&2; exit 2; }

platform_name=$(uname -s 2>/dev/null || true)
platform_arch=$(uname -m 2>/dev/null || true)
case "$platform_name:$platform_arch" in
  Darwin:arm64|Darwin:aarch64)
    target_platform="darwin-arm64"
    asset_name="harness-mrtool-darwin-arm64.zip"
    executable_name="harness-mrtool"
    default_destination="${XDG_DATA_HOME:-$HOME/Library/Application Support}/harness-mrtool"
    ;;
  MINGW*:x86_64|MINGW*:amd64|MSYS*:x86_64|MSYS*:amd64|CYGWIN*:x86_64|CYGWIN*:amd64)
    target_platform="windows-x64"
    asset_name="harness-mrtool-windows-x64.zip"
    executable_name="harness-mrtool.exe"
    default_destination="${XDG_DATA_HOME:-$HOME/.local/share}/harness-mrtool"
    ;;
  *) die "unsupported platform; use the Windows installer on Windows or Darwin ARM64" ;;
esac

tag= sha256_expected= destination="$default_destination" mode=install
while (($#)); do
  case "$1" in
    --tag) (($# >= 2)) || usage; tag=$2; shift 2 ;;
    --sha256) (($# >= 2)) || usage; sha256_expected=$2; shift 2 ;;
    --destination) (($# >= 2)) || usage; destination=$2; shift 2 ;;
    --update) [[ "$mode" == install ]] || usage; mode=update; shift ;;
    --repair) [[ "$mode" == install ]] || usage; mode=repair; shift ;;
    *) usage ;;
  esac
done
[[ "$destination" != / && "$destination" != "" ]] || die "invalid destination"
if command -v sha256sum >/dev/null 2>&1; then
  hash_file() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
  hash_file() { shasum -a 256 "$1" | awk '{print $1}'; }
else
  die "sha256sum or shasum is required"
fi

parent=$(dirname -- "$destination")
mkdir -p "$parent"
destination=$(cd "$parent" && pwd -P)/$(basename -- "$destination")

if [[ "$mode" != install ]]; then
  [[ -z "$tag" && -z "$sha256_expected" ]] || usage
  [[ -d "$destination" && ! -L "$destination" ]] || die "managed destination is unavailable"
  executable_path="$destination/$executable_name"
  marker_path="$destination/$MARKER_NAME"
  [[ -f "$marker_path" && ! -L "$marker_path" ]] || die "managed installation marker is missing"
  [[ -f "$executable_path" && ! -L "$executable_path" && -x "$executable_path" ]] || die "managed executable is unavailable"
  marker_repository=$(sed -n 's/.*"repository":"\([^"\\]*\)".*/\1/p' "$marker_path")
  marker_schema=$(sed -n 's/.*"schemaVersion":\([0-9][0-9]*\).*/\1/p' "$marker_path")
  marker_executable_sha=$(sed -n 's/.*"executableSha256":"\([A-Fa-f0-9]\{64\}\)".*/\1/p' "$marker_path")
  [[ "$marker_repository" == "$REPOSITORY" && "$marker_schema" == 1 ]] || die "installation marker is not manager-owned"
  [[ "$(hash_file "$executable_path")" == "$(printf '%s' "$marker_executable_sha" | tr '[:upper:]' '[:lower:]')" ]] || die "managed executable does not match its marker"
  if [[ "$mode" == repair ]]; then
    exec "$executable_path" self-update repair --output json
  fi
  exec "$executable_path" self-update apply --output json
fi

[[ "$tag" =~ ^cli-v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]] || die "invalid release tag"
[[ "$sha256_expected" =~ ^[A-Fa-f0-9]{64}$ ]] || die "invalid release hash"
command -v curl >/dev/null 2>&1 || die "curl is required"
command -v unzip >/dev/null 2>&1 || die "unzip is required"
command -v head >/dev/null 2>&1 || die "head is required"
command -v mktemp >/dev/null 2>&1 || die "mktemp is required"

parent=$(dirname "$destination")
[[ -e "$destination" ]] && die "destination exists; use the managed updater or repair command"
tmpdir=$(mktemp -d "${parent%/}/.harness-mrtool-install.XXXXXX")
cleanup() { rm -rf -- "$tmpdir"; }
trap cleanup EXIT INT TERM
archive="$tmpdir/release.zip"
url="https://${RELEASE_HOST}/${REPOSITORY}/releases/download/${tag}/${asset_name}"
effective_url_file="$tmpdir/effective-url"
curl --fail --location --max-redirs 4 --proto '=https' --proto-redir '=https' --tlsv1.2 --max-time 120 --max-filesize "$MAX_ARCHIVE_BYTES" --silent --show-error --output "$archive" --write-out '%{url_effective}' "$url" > "$effective_url_file" || die "release download failed"
effective_url=$(cat "$effective_url_file")
case "$effective_url" in
  https://github.com/*|https://objects.githubusercontent.com/*|https://release-assets.githubusercontent.com/*) ;;
  *) die "release download redirected to an untrusted host" ;;
esac
[[ -s "$archive" ]] || die "release archive is empty"
archive_bytes=$(wc -c < "$archive")
(( archive_bytes <= MAX_ARCHIVE_BYTES )) || die "release archive is too large"
actual=$(hash_file "$archive")
actual_lower=$(printf '%s' "$actual" | tr '[:upper:]' '[:lower:]')
expected_lower=$(printf '%s' "$sha256_expected" | tr '[:upper:]' '[:lower:]')
[[ "$actual_lower" == "$expected_lower" ]] || die "release hash mismatch"

list=$(unzip -Z1 "$archive") || die "release archive cannot be inspected"
expected=$(printf '%s\n' THIRD_PARTY_NOTICES.md bundle-receipt.envelope.json "$executable_name" licenses/Node.txt SHA256SUMS)
[[ "$(printf '%s\n' "$list" | LC_ALL=C sort)" == "$(printf '%s\n' "$expected" | LC_ALL=C sort)" ]] || die "release archive tree is not exact"
while IFS= read -r name; do
  [[ "$name" != /* && "$name" != *'..'* && "$name" != *'\\'* && "$name" != *:* ]] || die "unsafe archive path"
  case "$name" in *CON|*PRN|*AUX|*NUL|*COM[1-9]|*LPT[1-9]) die "reserved archive name";; esac
done <<< "$list"
expanded_bytes=0
entry_count=0
while IFS= read -r entry; do
  if [[ "$entry" =~ ^[[:space:]]*([0-9]+)[[:space:]]+((19|20)[0-9]{2}-[0-9]{2}-[0-9]{2}|[0-9]{2}-[0-9]{2}-[0-9]{4})[[:space:]] ]]; then
    entry_bytes=${BASH_REMATCH[1]}
    if (( entry_bytes > MAX_ENTRY_BYTES )); then
      die "release entry exceeds the expansion limit"
    fi
    if (( expanded_bytes > MAX_EXPANDED_BYTES - entry_bytes )); then
      die "release expansion exceeds the total limit"
    fi
    expanded_bytes=$((expanded_bytes + entry_bytes))
    entry_count=$((entry_count + 1))
  fi
done < <(unzip -l "$archive")
(( entry_count == 5 )) || die "release entry sizes could not be determined"
mkdir -p "$tmpdir/tree/licenses"
extracted_total_bytes=0
for required in THIRD_PARTY_NOTICES.md bundle-receipt.envelope.json "$executable_name" licenses/Node.txt SHA256SUMS; do
  unzip -p "$archive" "$required" | head -c "$((MAX_ENTRY_BYTES + 1))" > "$tmpdir/tree/$required" || die "release extraction failed"
  actual_entry_bytes=$(wc -c < "$tmpdir/tree/$required")
  if (( actual_entry_bytes < 1 || actual_entry_bytes > MAX_ENTRY_BYTES )); then
    die "release entry emitted an invalid byte count"
  fi
  if (( extracted_total_bytes > MAX_EXPANDED_BYTES - actual_entry_bytes )); then
    die "release extraction exceeds the total limit"
  fi
  extracted_total_bytes=$((extracted_total_bytes + actual_entry_bytes))
done
for required in THIRD_PARTY_NOTICES.md bundle-receipt.envelope.json "$executable_name" licenses/Node.txt SHA256SUMS; do
  [[ -f "$tmpdir/tree/$required" && ! -L "$tmpdir/tree/$required" ]] || die "release entry is not a regular file"
done
seen_checksums=$'\n'
checksum_count=0
while IFS= read -r checksum_line; do
  [[ "$checksum_line" =~ ^([a-f0-9]{64})[[:space:]][[:space:]]([^[:space:]]+)$ ]] || die "invalid SHA256SUMS"
  digest=${BASH_REMATCH[1]}; path=${BASH_REMATCH[2]}
  [[ "$path" != SHA256SUMS ]] || die "self checksum is forbidden"
  case "$path" in
    THIRD_PARTY_NOTICES.md|bundle-receipt.envelope.json|$executable_name|licenses/Node.txt) ;;
    *) die "invalid SHA256SUMS entry" ;;
  esac
  case "$seen_checksums" in *$'\n'"$path"$'\n'*) die "duplicate SHA256SUMS entry" ;; esac
  [[ -f "$tmpdir/tree/$path" ]] || die "checksum entry is missing"
  [[ "$(hash_file "$tmpdir/tree/$path")" == "$digest" ]] || die "release entry hash mismatch"
  seen_checksums+="$path"$'\n'
  checksum_count=$((checksum_count + 1))
done < "$tmpdir/tree/SHA256SUMS"
(( checksum_count == 4 )) || die "SHA256SUMS is incomplete"

chmod 700 "$tmpdir/tree"
chmod 755 "$tmpdir/tree/$executable_name"
"$tmpdir/tree/$executable_name" self-test --output json >/dev/null || die "self-test failed"
executable_sha256=$(hash_file "$tmpdir/tree/$executable_name")
printf '{"archiveSha256":"%s","executableSha256":"%s","repository":"%s","schemaVersion":1,"tag":"%s"}\n' \
  "$actual" "$executable_sha256" "$REPOSITORY" "$tag" > "$tmpdir/tree/$MARKER_NAME"
chmod 600 "$tmpdir/tree/$MARKER_NAME"
mv -n "$tmpdir/tree" "$destination" || die "destination publication failed"
[[ ! -e "$tmpdir/tree" ]] || die "destination publication raced"
