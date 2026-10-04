#!/bin/sh
set -eu

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
mode=${1:-device}
case "$mode" in
  device|--server-only) ;;
  *) echo 'Usage: pnpm start:dev-client [--server-only]' >&2; exit 1 ;;
esac
for dependency in node pnpm java curl; do
  command -v "$dependency" >/dev/null || { echo "Install $dependency before starting Yugen." >&2; exit 1; }
done
LAN_IP=${YUGEN_ANALYSIS_LAN_IP:-}
if [ -z "$LAN_IP" ]; then
  interface=$(route -n get default 2>/dev/null | awk '/interface:/{print $2}' || true)
  LAN_IP=$(ipconfig getifaddr "${interface:-en0}" 2>/dev/null || true)
fi
[ -n "$LAN_IP" ] || { echo 'Connect your Mac and iPhone to the same Wi-Fi before starting Yugen.' >&2; exit 1; }
export EXPO_PUBLIC_ANALYSIS_BASE_URL="http://$LAN_IP:8080"
export YUGEN_ANALYSIS_DATA=${YUGEN_ANALYSIS_DATA:-$REPO_ROOT/analysis-service/.data}
# Device testing uses local dictionaries even if the shell contains a provider key.
export YUGEN_AI_ENABLED=false
unset OPENAI_API_KEY

device=${YUGEN_IOS_DEVICE:-}
if [ "$mode" = device ]; then
  command -v xcrun >/dev/null || { echo 'Install and select Xcode before testing on an iPhone.' >&2; exit 1; }
  if [ -z "$device" ] && command -v idevice_id >/dev/null; then device=$(idevice_id -l | head -n 1); fi
  if [ -z "$device" ]; then
    device=$(xcrun xctrace list devices 2>/dev/null | awk '
      /^== Devices ==/{connected=1; next} /^==/{connected=0}
      connected && /\([0-9]+\.[0-9]+/ {sub(/^.*\(/, ""); sub(/\).*$/, ""); print; exit}')
  fi
  [ -n "$device" ] || { echo 'Connect and unlock your iPhone, then run this command again.' >&2; exit 1; }
fi

ANALYSIS_PID=
METRO_PID=
log_dir=$(mktemp -d "${TMPDIR:-/tmp}/yugen-device.XXXXXX")
stop_process_tree() {
  for child in $(pgrep -P "$1" || true); do stop_process_tree "$child"; done
  kill "$1" 2>/dev/null || true
}
stop_owned_services() {
  for pid in "$METRO_PID" "$ANALYSIS_PID"; do
    if [ -n "$pid" ]; then stop_process_tree "$pid"; wait "$pid" 2>/dev/null || true; fi
  done
}
trap stop_owned_services EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Reuse compatible services; never kill an unrelated port occupant.
analysis_status=$(curl --silent --max-time 2 --output "$log_dir/analysis.json" --write-out '%{http_code}' \
  -H 'Content-Type: application/json' --data '{"contractVersion":2,"language":"ja","text":"米"}' \
  http://127.0.0.1:8080/v1/analyze || true)
if [ "$analysis_status" != 000 ]; then
  [ "$analysis_status" = 200 ] || { echo 'Port 8080 is not a healthy Yugen dictionary service. Stop it before starting Yugen.' >&2; exit 1; }
  node -e 'const fs=require("fs");const v=JSON.parse(fs.readFileSync(process.argv[1]));if(v.contractVersion!==2||v.language!=="ja"||v.normalizedText!=="米"||!Array.isArray(v.tokens)||!v.tokens.some(t=>Array.isArray(t.kanjiDetails)&&t.kanjiDetails.some(k=>k.character==="米"&&k.meanings.includes("rice"))))process.exit(1)' "$log_dir/analysis.json" \
    || { echo 'Port 8080 belongs to an incompatible or outdated service. Stop it and restart Yugen.' >&2; exit 1; }
  echo 'Reusing the running Japanese dictionary service.'
else
  [ -z "$(lsof -tiTCP:8080 -sTCP:LISTEN || true)" ] || { echo 'Port 8080 is occupied. Stop its service before starting Yugen.' >&2; exit 1; }
  if [ ! -s "$YUGEN_ANALYSIS_DATA/sudachi-dictionary-20260116/system_core.dic" ] || [ ! -s "$YUGEN_ANALYSIS_DATA/JMdict_e_NG.gz" ] || [ ! -s "$YUGEN_ANALYSIS_DATA/kanjidic2.xml.gz" ] || ! gzip -t "$YUGEN_ANALYSIS_DATA/JMdict_e_NG.gz" "$YUGEN_ANALYSIS_DATA/kanjidic2.xml.gz" 2>/dev/null; then
    "$REPO_ROOT/analysis-service/scripts/setup-data.sh" --missing
  fi
  "$REPO_ROOT/analysis-service/gradlew" -p "$REPO_ROOT/analysis-service" installDist
  YUGEN_ANALYSIS_HOST=0.0.0.0 YUGEN_ANALYSIS_PORT=8080 \
    "$REPO_ROOT/analysis-service/build/install/yugen-analysis-service/bin/yugen-analysis-service" &
  ANALYSIS_PID=$!
fi
attempt=0
while [ "$attempt" -lt 90 ]; do
  status=$(curl --silent --max-time 2 --output /dev/null --write-out '%{http_code}' "$EXPO_PUBLIC_ANALYSIS_BASE_URL/v1/analyze" || true)
  [ "$status" = 405 ] && break
  if [ -n "$ANALYSIS_PID" ] && ! kill -0 "$ANALYSIS_PID" 2>/dev/null; then echo 'The local dictionary service failed to start.' >&2; exit 1; fi
  attempt=$((attempt + 1)); sleep 1
done
[ "$attempt" -lt 90 ] || { echo 'The phone cannot reach the Mac dictionary address. Check Wi-Fi and the macOS firewall.' >&2; exit 1; }

cd "$REPO_ROOT/mobile"
pnpm install --frozen-lockfile
metro_pid=$(lsof -tiTCP:8081 -sTCP:LISTEN | head -n 1 || true)
metro_status=$(curl --silent --max-time 2 http://127.0.0.1:8081/status || true)
if [ -n "$metro_pid" ]; then
  metro_cwd=$(lsof -a -p "$metro_pid" -d cwd -Fn | sed -n 's/^n//p')
  [ "$metro_status" = 'packager-status:running' ] && [ "$metro_cwd" = "$REPO_ROOT/mobile" ] \
    && ps eww -p "$metro_pid" | grep -Fq "EXPO_PUBLIC_ANALYSIS_BASE_URL=$EXPO_PUBLIC_ANALYSIS_BASE_URL" \
    || { echo 'Port 8081 has another app or an outdated Yugen address. Stop that Metro process and retry.' >&2; exit 1; }
  echo 'Reusing Yugen Metro.'
else
  pnpm exec expo start --dev-client --lan --port 8081 </dev/null &
  METRO_PID=$!
  attempt=0
  until [ "$(curl --silent --max-time 2 http://127.0.0.1:8081/status || true)" = 'packager-status:running' ]; do
    kill -0 "$METRO_PID" 2>/dev/null || { echo 'Metro failed to start.' >&2; exit 1; }
    attempt=$((attempt + 1)); [ "$attempt" -lt 60 ] || { echo 'Metro did not become ready.' >&2; exit 1; }; sleep 1
  done
fi
if [ "$mode" = device ]; then
  echo 'Building and installing Yugen on your connected iPhone…'
  if ! pnpm exec expo run:ios --device "$device" --no-bundler >"$log_dir/build.log" 2>&1; then
    if grep -q 'Build Succeeded' "$log_dir/build.log" && grep -q 'CoreDeviceError error 1000' "$log_dir/build.log"; then
      app_path=$(sed -n 's/.*Installing \(.*\.app\).*/\1/p' "$log_dir/build.log" | tail -n 1)
      if [ -d "$app_path" ] && command -v ideviceinstaller >/dev/null; then
        ideviceinstaller -u "$device" upgrade "$app_path" || { echo 'Unlock your iPhone and retry installation.' >&2; exit 1; }
      elif ! grep -q 'device process launch' "$log_dir/build.log"; then
        cat "$log_dir/build.log" >&2; exit 1
      fi
      echo 'Build complete. This older iPhone needs the legacy launch path.'
      if command -v idevicedebug >/dev/null; then
        # Expo's native launcher consumes this argument without a separate deep-link tool.
        idevicedebug -u "$device" --detach -- run com.yugen.dev --initialUrl "http://$LAN_IP:8081" || echo 'Unlock the iPhone and open Yugen Dev.'
      else
        echo 'Open Yugen Dev on the iPhone.'
      fi
    else
      cat "$log_dir/build.log" >&2
      echo "Native build failed. Log: $log_dir/build.log" >&2
      exit 1
    fi
  fi
fi
echo "Ready: local furigana, dictionaries and saved cards. AI is disabled. Mac address: $LAN_IP"
echo 'Keep this terminal open. Ctrl-C stops only the services this command started.'
if [ -n "$METRO_PID" ]; then wait "$METRO_PID"; else while :; do sleep 5; done; fi
