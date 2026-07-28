#!/usr/bin/env bash
set -euo pipefail

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
docker_host=${DOCKER_HOST:-unix:///run/user/999/docker.sock}
image=${ANDROID_TV_BUILD_IMAGE:-eclipse-temurin:17-jdk-jammy}
output_path=

if [[ ${1:-} == "--output" ]]; then
  output_path=${2:?--output requires a file path}
elif [[ $# -ne 0 ]]; then
  echo "usage: $0 [--output /path/to/telex-tv-debug.apk]" >&2
  exit 2
fi

suffix="$(date +%s)-$$"
work_volume="telex-tv-work-$suffix"
tools_volume="telex-tv-tools-$suffix"
gradle_volume="telex-tv-gradle-$suffix"

docker_cmd=(docker --host "$docker_host")

cleanup() {
  "${docker_cmd[@]}" volume rm -f "$work_volume" "$tools_volume" "$gradle_volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

"${docker_cmd[@]}" pull "$image"
"${docker_cmd[@]}" volume create "$work_volume" >/dev/null
"${docker_cmd[@]}" volume create "$tools_volume" >/dev/null
"${docker_cmd[@]}" volume create "$gradle_volume" >/dev/null

tar \
  --exclude='.gradle' \
  --exclude='.idea' \
  --exclude='build' \
  --exclude='local.properties' \
  -C "$project_root" \
  -cf - \
  android-tv |
  "${docker_cmd[@]}" run --rm -i \
    --network none \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    -v "$work_volume:/work" \
    "$image" \
    tar --no-same-owner -C /work -xf -

common_args=(
  --rm
  --cpus 2
  --memory 4g
  --pids-limit 512
  --cap-drop ALL
  --security-opt no-new-privileges
  --tmpfs /tmp:rw,nosuid,size=1g
  -e ANDROID_SDK_ROOT=/opt/tools/android-sdk
  -e GRADLE_USER_HOME=/gradle-home
  -v "$work_volume:/work"
  -v "$tools_volume:/opt/tools"
  -v "$gradle_volume:/gradle-home"
)

echo "Installing the pinned Android toolchain and warming dependency caches..."
"${docker_cmd[@]}" run "${common_args[@]}" \
  --cap-add CHOWN \
  --cap-add DAC_OVERRIDE \
  --cap-add FOWNER \
  --cap-add SETGID \
  --cap-add SETUID \
  "$image" bash -euo pipefail -c '
  apt-get update
  apt-get install -y --no-install-recommends ca-certificates curl unzip
  rm -rf /var/lib/apt/lists/*

  commandline_url=https://dl.google.com/android/repository/commandlinetools-linux-15859902_latest.zip
  commandline_sha=4e4c464f145a7512b57d088ac6c278c03c9eea610886b35a5e0804e74eedf583
  gradle_url=https://services.gradle.org/distributions/gradle-8.13-bin.zip
  gradle_sha=20f1b1176237254a6fc204d8434196fa11a4cfb387567519c61556e8710aed78

  if [[ ! -x /opt/tools/android-sdk/cmdline-tools/latest/bin/sdkmanager ]]; then
    curl -fsSL "$commandline_url" -o /tmp/android-commandline.zip
    echo "$commandline_sha  /tmp/android-commandline.zip" | sha256sum -c -
    mkdir -p /opt/tools/android-sdk/cmdline-tools/latest
    unzip -q /tmp/android-commandline.zip -d /tmp/android-commandline
    mv /tmp/android-commandline/cmdline-tools/* /opt/tools/android-sdk/cmdline-tools/latest/
  fi

  if [[ ! -x /opt/tools/gradle-8.13/bin/gradle ]]; then
    curl -fsSL "$gradle_url" -o /tmp/gradle.zip
    echo "$gradle_sha  /tmp/gradle.zip" | sha256sum -c -
    unzip -q /tmp/gradle.zip -d /opt/tools
  fi

  yes | /opt/tools/android-sdk/cmdline-tools/latest/bin/sdkmanager --licenses >/dev/null || true
  /opt/tools/android-sdk/cmdline-tools/latest/bin/sdkmanager \
    "platform-tools" \
    "platforms;android-35" \
    "build-tools;35.0.0"

  cd /work/android-tv
  /opt/tools/gradle-8.13/bin/gradle --no-daemon assembleDebug lintDebug testDebugUnitTest
'

echo "Repeating lint, unit tests, and APK assembly with networking disabled..."
"${docker_cmd[@]}" run "${common_args[@]}" --network none "$image" bash -euo pipefail -c '
  cd /work/android-tv
  /opt/tools/gradle-8.13/bin/gradle \
    --offline \
    --no-daemon \
    clean \
    lintDebug \
    testDebugUnitTest \
    assembleDebug
'

if [[ -n "$output_path" ]]; then
  output_directory=$(dirname -- "$output_path")
  output_name=$(basename -- "$output_path")
  mkdir -p "$output_directory"
  temporary_directory=$(mktemp -d)
  "${docker_cmd[@]}" run --rm \
    --network none \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    -v "$work_volume:/work:ro" \
    "$image" \
    tar -C /work/android-tv/app/build/outputs/apk/debug -cf - app-debug.apk |
    tar -C "$temporary_directory" -xf -
  mv "$temporary_directory/app-debug.apk" "$output_path"
  rmdir "$temporary_directory"
  echo "APK: $output_path"
  sha256sum "$output_path"
fi

echo "Android TV container validation passed."
