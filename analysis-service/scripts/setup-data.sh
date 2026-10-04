#!/usr/bin/env bash
set -euo pipefail

missing_only=false
case "${1:-}" in
  '') ;;
  --missing) missing_only=true ;;
  *) echo 'Usage: setup-data.sh [--missing]' >&2; exit 1 ;;
esac

service_dir="$(cd "$(dirname "$0")/.." && pwd)"
data_dir="${YUGEN_ANALYSIS_DATA:-$service_dir/.data}"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

mkdir -p "$data_dir"

sudachi_version="20260116"
sudachi_expected_sha="e80e68c8e7b17e2082341284cffefbc11fb7838b2c318ae280c1690fc1ee1e2f"
sudachi_url="https://sudachi.s3.ap-northeast-1.amazonaws.com/sudachidict/sudachi-dictionary-$sudachi_version-core.zip"
sudachi_archive="$work_dir/sudachi-core.zip"
if [[ "$missing_only" != true || ! -s "$data_dir/sudachi-dictionary-$sudachi_version/system_core.dic" || -n "${SUDACHI_SOURCE_FILE:-}" ]]; then
  if [[ -n "${SUDACHI_SOURCE_FILE:-}" ]]; then
    cp "$SUDACHI_SOURCE_FILE" "$sudachi_archive"
  else
    curl --fail --location --retry 2 "$sudachi_url" --output "$sudachi_archive"
  fi
  sudachi_sha="$(shasum -a 256 "$sudachi_archive" | awk '{print $1}')"
  if [[ "$sudachi_sha" != "$sudachi_expected_sha" ]]; then
    echo "SudachiDict checksum mismatch: expected $sudachi_expected_sha, got $sudachi_sha" >&2
    exit 1
  fi
  unzip -oq "$sudachi_archive" -d "$data_dir"
fi

jmdict_archive="$data_dir/JMdict_e_NG.gz"
jmdict_updated="$(sed -n 's/^JMdict retrieved UTC: //p' "$data_dir/manifest.txt" 2>/dev/null || true)"
if [[ "$missing_only" != true || ! -s "$jmdict_archive" || -n "${JMDICT_SOURCE_FILE:-}" ]] || ! gzip -t "$jmdict_archive" 2>/dev/null; then
  if [[ -n "${JMDICT_SOURCE_FILE:-}" ]]; then
    cp "$JMDICT_SOURCE_FILE" "$jmdict_archive"
  else
    curl --fail --location --retry 2 "https://ftp.edrdg.org/pub/Nihongo/JMdict_e_NG.gz" --output "$jmdict_archive"
  fi
  jmdict_updated="$(date -u +%Y-%m-%d)"
fi

gzip -t "$jmdict_archive"
jmdict_sha="$(shasum -a 256 "$jmdict_archive" | awk '{print $1}')"

kanjidic_archive="$data_dir/kanjidic2.xml.gz"
kanjidic_updated="$(sed -n 's/^KANJIDIC2 retrieved UTC: //p' "$data_dir/manifest.txt" 2>/dev/null || true)"
if [[ "$missing_only" != true || ! -s "$kanjidic_archive" || -n "${KANJIDIC_SOURCE_FILE:-}" ]] || ! gzip -t "$kanjidic_archive" 2>/dev/null; then
  if [[ -n "${KANJIDIC_SOURCE_FILE:-}" ]]; then
    cp "$KANJIDIC_SOURCE_FILE" "$kanjidic_archive"
  else
    curl --fail --location --retry 2 "https://www.edrdg.org/kanjidic/kanjidic2.xml.gz" --output "$kanjidic_archive"
  fi
  kanjidic_updated="$(date -u +%Y-%m-%d)"
fi
gzip -t "$kanjidic_archive"
kanjidic_sha="$(shasum -a 256 "$kanjidic_archive" | awk '{print $1}')"
cat > "$data_dir/manifest.txt" <<EOF
SudachiDict core: $sudachi_version
SudachiDict archive SHA-256: $sudachi_expected_sha
JMdict file: JMdict_e_NG.gz
JMdict retrieved UTC: $jmdict_updated
JMdict archive SHA-256: $jmdict_sha
KANJIDIC2 file: kanjidic2.xml.gz
KANJIDIC2 retrieved UTC: ${kanjidic_updated:-unknown (existing local file)}
KANJIDIC2 archive SHA-256: $kanjidic_sha
EOF

echo "Analysis data installed in $data_dir"
echo "Local data manifest: $data_dir/manifest.txt"
