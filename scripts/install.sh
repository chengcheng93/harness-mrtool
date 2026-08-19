#!/usr/bin/env bash
set -euo pipefail

readonly REPOSITORY="chengcheng93/harness-mrtool"
readonly RELEASE_HOST="github.com"
readonly ASSET_NAME="harness-mrtool-portable.zip"
readonly MAX_ARCHIVE_BYTES=$((512 * 1024 * 1024))
readonly MAX_ENTRY_BYTES=$((256 * 1024 * 1024))
readonly MAX_EXPANDED_BYTES=$((512 * 1024 * 1024))
readonly MARKER_NAME=".harness-mrtool-install.json"

die() { printf '%s\n' "harness-mrtool install failed: $1" >&2; exit 1; }
usage() { printf 'usage: %s --tag vX.Y.Z --sha256 HEX [--destination DIR]\n' "$0" >&2; exit 2; }

tag= sha256_expected= destination="${XDG_DATA_HOME:-$HOME/.local/share}/harness-mrtool"
while (($#)); do
  case "$1" in
    --tag) (($# >= 2)) || usage; tag=$2; shift 2 ;;
    --sha256) (($# >= 2)) || usage; sha256_expected=$2; shift 2 ;;
    --destination) (($# >= 2)) || usage; destination=$2; shift 2 ;;
    *) usage ;;
  esac
done
[[ "$tag" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]] || die "invalid release tag"
[[ "$sha256_expected" =~ ^[A-Fa-f0-9]{64}$ ]] || die "invalid release hash"
[[ "$destination" != / && "$destination" != "" ]] || die "invalid destination"
command -v curl >/dev/null 2>&1 || die "curl is required"
command -v sha256sum >/dev/null 2>&1 || die "sha256sum is required"
command -v unzip >/dev/null 2>&1 || die "unzip is required"
command -v mktemp >/dev/null 2>&1 || die "mktemp is required"

parent=$(dirname -- "$destination")
mkdir -p "$parent"
destination=$(cd "$parent" && pwd -P)/$(basename -- "$destination")
parent=$(dirname "$destination")
[[ -e "$destination" ]] && die "destination exists; replacement requires the verified Windows installer"
tmpdir=$(mktemp -d "${parent%/}/.harness-mrtool-install.XXXXXX")
cleanup() { rm -rf -- "$tmpdir"; }
trap cleanup EXIT INT TERM
archive="$tmpdir/release.zip"
url="https://${RELEASE_HOST}/${REPOSITORY}/releases/download/${tag}/${ASSET_NAME}"
curl --fail --location --proto '=https' --tlsv1.2 --max-time 120 --max-filesize "$MAX_ARCHIVE_BYTES" --silent --show-error --output "$archive" "$url" || die "release download failed"
[[ -s "$archive" ]] || die "release archive is empty"
actual=$(sha256sum "$archive" | awk '{print $1}')
[[ "$actual" == "${sha256_expected,,}" ]] || die "release hash mismatch"

list=$(unzip -Z1 "$archive") || die "release archive cannot be inspected"
expected=$'THIRD_PARTY_NOTICES.md\nbundle-receipt.envelope.json\nharness-mrtool.exe\nlicenses/Node.txt\nSHA256SUMS'
[[ "$(printf '%s\n' "$list" | LC_ALL=C sort)" == "$(printf '%s\n' "$expected" | LC_ALL=C sort)" ]] || die "release archive tree is not exact"
while IFS= read -r name; do
  [[ "$name" != /* && "$name" != *'..'* && "$name" != *'\\'* && "$name" != *:* ]] || die "unsafe archive path"
  case "$name" in *CON|*PRN|*AUX|*NUL|*COM[1-9]|*LPT[1-9]) die "reserved archive name";; esac
done <<< "$list"
expanded_bytes=0
while IFS= read -r entry; do
  if [[ "$entry" =~ ^[[:space:]]*([0-9]+)[[:space:]]+[0-9]{2}-[0-9]{2}-[0-9]{4}[[:space:]] ]]; then
    entry_bytes=${BASH_REMATCH[1]}
    if (( entry_bytes > MAX_ENTRY_BYTES )); then
      die "release entry exceeds the expansion limit"
    fi
    if (( expanded_bytes > MAX_EXPANDED_BYTES - entry_bytes )); then
      die "release expansion exceeds the total limit"
    fi
    expanded_bytes=$((expanded_bytes + entry_bytes))
  fi
done < <(unzip -l "$archive")
unzip -q -o "$archive" -d "$tmpdir/tree" || die "release extraction failed"
for required in THIRD_PARTY_NOTICES.md bundle-receipt.envelope.json harness-mrtool.exe licenses/Node.txt SHA256SUMS; do
  [[ -f "$tmpdir/tree/$required" && ! -L "$tmpdir/tree/$required" ]] || die "release entry is not a regular file"
done
while read -r digest path; do
  [[ "$digest" =~ ^[a-f0-9]{64}$ ]] || die "invalid SHA256SUMS"
  [[ "$path" != SHA256SUMS ]] || die "self checksum is forbidden"
  [[ -f "$tmpdir/tree/$path" ]] || die "checksum entry is missing"
  [[ "$(sha256sum "$tmpdir/tree/$path" | awk '{print $1}')" == "$digest" ]] || die "release entry hash mismatch"
done < "$tmpdir/tree/SHA256SUMS"

chmod 700 "$tmpdir/tree"
chmod 755 "$tmpdir/tree/harness-mrtool.exe"
"$tmpdir/tree/harness-mrtool.exe" self-test --output json >/dev/null || die "self-test failed"
executable_sha256=$(sha256sum "$tmpdir/tree/harness-mrtool.exe" | awk '{print $1}')
printf '{"archiveSha256":"%s","executableSha256":"%s","repository":"%s","schemaVersion":1,"tag":"%s"}\n' \
  "$actual" "$executable_sha256" "$REPOSITORY" "$tag" > "$tmpdir/tree/$MARKER_NAME"
chmod 600 "$tmpdir/tree/$MARKER_NAME"
mv --no-clobber "$tmpdir/tree" "$destination" || die "destination publication failed"
[[ ! -e "$tmpdir/tree" ]] || die "destination publication raced"
