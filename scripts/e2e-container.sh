#!/usr/bin/env bash
set -euo pipefail

now_ms() {
  date +%s%3N
}

outer_started=$(now_ms)
phase_started=$outer_started
finish_outer_phase() {
  local label=$1 current
  current=$(now_ms)
  printf 'E2E OUTER %-28s %d ms\n' "$label" "$((current - phase_started))"
  phase_started=$current
}

usage() {
  cat <<'EOF'
Usage:
  scripts/e2e-container.sh core --codex-token-file PATH --voice-file PATH --voice-text TEXT
  scripts/e2e-container.sh telegram --codex-token-file PATH --telex-bot-token-file PATH \
    --peer-bot-token-file PATH --voice-file PATH --voice-text TEXT [--chat-id ID --thread-ids ID,ID]
EOF
}

[[ $# -gt 0 ]] || { usage >&2; exit 2; }
mode=$1
shift
case $mode in core|telegram) ;; *) usage >&2; exit 2 ;; esac

codex_token_file=
telex_bot_token_file=
peer_bot_token_file=
voice_file=
voice_text=
chat_id=
thread_ids=
while [[ $# -gt 0 ]]; do
  [[ $# -ge 2 ]] || { usage >&2; exit 2; }
  case $1 in
    --codex-token-file) codex_token_file=$2 ;;
    --telex-bot-token-file) telex_bot_token_file=$2 ;;
    --peer-bot-token-file) peer_bot_token_file=$2 ;;
    --voice-file) voice_file=$2 ;;
    --voice-text) voice_text=$2 ;;
    --chat-id) chat_id=$2 ;;
    --thread-ids) thread_ids=$2 ;;
    *) usage >&2; exit 2 ;;
  esac
  shift 2
done

require_file() {
  local path=$1
  [[ -f $path && -s $path ]] || { printf 'Missing non-empty file: %s\n' "$path" >&2; exit 2; }
}
require_secret() {
  require_file "$1"
  [[ $(stat -c '%a' "$1") == 600 ]] || {
    printf 'Secret file must have mode 0600: %s\n' "$1" >&2
    exit 2
  }
}

require_secret "$codex_token_file"
require_file "$voice_file"
[[ -n $voice_text ]] || { printf '%s\n' 'Missing --voice-text' >&2; exit 2; }
if [[ $mode == telegram ]]; then
  require_secret "$telex_bot_token_file"
  require_secret "$peer_bot_token_file"
fi

repository=$(cd "$(dirname "$0")/.." && pwd)
docker_socket=/run/user/999/docker.sock
export DOCKER_HOST="unix://$docker_socket"
[[ -S $docker_socket ]] || { printf '%s\n' 'Rootless Docker socket is unavailable' >&2; exit 1; }
[[ $(stat -c '%u' "$docker_socket") == "$(id -u)" ]] || {
  printf '%s\n' 'Rootless Docker socket is owned by another user' >&2
  exit 1
}
[[ $(docker info --format '{{json .SecurityOptions}}') == *'name=rootless'* ]] || {
  printf '%s\n' 'Docker daemon is not rootless' >&2
  exit 1
}
[[ ! -S /run/docker.sock ]] || {
  printf '%s\n' 'Refusing a host with rootful Docker enabled' >&2
  exit 1
}
finish_outer_phase "input and Docker checks"

run_key="$(id -u)-$$"
source_volume="telex-e2e-source-$run_key"
secret_volume="telex-e2e-secret-$run_key"
seed_container="telex-e2e-seed-$run_key"
dependency_container="telex-e2e-deps-$run_key"
run_container="telex-e2e-run-$run_key"
stage=$(mktemp -d /tmp/telex-e2e-stage.XXXXXXXX)

cleanup() {
  local status=$?
  local cleanup_started
  cleanup_started=$(now_ms)
  trap - EXIT INT TERM
  set +e
  docker rm --force "$seed_container" "$dependency_container" "$run_container" >/dev/null 2>&1
  docker volume rm --force "$source_volume" "$secret_volume" >/dev/null 2>&1
  case $stage in /tmp/telex-e2e-stage.*) rm -rf -- "$stage" ;; esac
  printf 'E2E OUTER %-28s %d ms\n' "cleanup" "$(( $(now_ms) - cleanup_started ))"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

manifest="$stage/manifest"
: >"$manifest"
while IFS= read -r -d '' path; do
  case "/$path/" in
    */.git/*|*/node_modules/*|*/dist/*|*/.telex/*|*/artifacts/*|*/.telex-test-secrets/*) continue ;;
  esac
  [[ -e $repository/$path || -L $repository/$path ]] || continue
  printf '%s\0' "$path" >>"$manifest"
done < <(git -C "$repository" ls-files --cached --others --exclude-standard -z)
tar -C "$repository" --create --file="$stage/source.tar" --null --verbatim-files-from --files-from="$manifest"
mkdir "$stage/source"
tar --extract --file="$stage/source.tar" --directory="$stage/source"
finish_outer_phase "stage source"

# Codex uses the OS trust store; the slim image intentionally omits it.
image=node:24-bookworm
docker pull "$image" >/dev/null
finish_outer_phase "pull base image"
docker volume create --label com.sadfun.telex.purpose=e2e --label com.sadfun.telex.ephemeral=true \
  "$source_volume" >/dev/null
docker volume create --label com.sadfun.telex.purpose=e2e --label com.sadfun.telex.ephemeral=true \
  "$secret_volume" >/dev/null
docker create --name "$seed_container" --network=none \
  --mount "type=volume,src=$source_volume,dst=/work" \
  --mount "type=volume,src=$secret_volume,dst=/input" \
  "$image" true >/dev/null
docker cp "$stage/source/." "$seed_container:/work"

mkdir -m 0700 "$stage/secrets"
cp "$codex_token_file" "$stage/secrets/codex.json"
cp "$voice_file" "$stage/secrets/voice"
if [[ $mode == telegram ]]; then
  cp "$telex_bot_token_file" "$stage/secrets/telex-bot"
  cp "$peer_bot_token_file" "$stage/secrets/peer-bot"
fi
chmod 0644 "$stage/secrets"/*
docker cp "$stage/secrets/." "$seed_container:/input"
docker rm "$seed_container" >/dev/null
finish_outer_phase "seed ephemeral volumes"

common=(
  --init --cap-drop=ALL --security-opt=no-new-privileges --cpus=2 --memory=2g
  --memory-swap=2g --pids-limit=256 --ulimit nofile=1024:1024
  --workdir /work --env NO_COLOR=1 --env npm_config_cache=/tmp/npm-cache
  --tmpfs /tmp:rw,exec,nosuid,nodev,size=1073741824,mode=1777
)
docker run --name "$dependency_container" --network=bridge "${common[@]}" \
  --mount "type=volume,src=$source_volume,dst=/work" "$image" \
  sh -ceu 'npm ci --no-audit --no-fund'
docker rm "$dependency_container" >/dev/null
finish_outer_phase "npm ci"

test_script=test:e2e
[[ $mode == telegram ]] && test_script=test:telegram
run_args=(
  --name "$run_container" --network=bridge --read-only --user node
  # The non-root, cap-dropped process needs these syscalls only to start Codex's nested bwrap.
  --security-opt=seccomp=unconfined
  "${common[@]}"
  --mount "type=volume,src=$source_volume,dst=/work,readonly"
  --mount "type=volume,src=$secret_volume,dst=/input,readonly"
  --env TELEX_E2E_CODEX_TOKEN_FILE=/tmp/e2e-secrets/codex.json
  --env TELEX_E2E_VOICE_FILE=/tmp/e2e-secrets/voice
  --env "TELEX_E2E_VOICE_TEXT=$voice_text"
  --env "TELEX_E2E_LOG_LEVEL=${TELEX_E2E_LOG_LEVEL:-info}"
  --env "TELEX_E2E_SCRIPT=$test_script"
)
if [[ $mode == telegram ]]; then
  run_args+=(
    --env TELEX_E2E_MODE=telegram
    --env TELEX_E2E_TELEX_BOT_TOKEN_FILE=/tmp/e2e-secrets/telex-bot
    --env TELEX_E2E_PEER_BOT_TOKEN_FILE=/tmp/e2e-secrets/peer-bot
  )
  [[ -z $chat_id ]] || run_args+=(--env "TELEX_E2E_CHAT_ID=$chat_id")
  [[ -z $thread_ids ]] || run_args+=(--env "TELEX_E2E_THREAD_IDS=$thread_ids")
fi
docker create "${run_args[@]}" "$image" sh -ceu \
  'mkdir -m 0700 /tmp/e2e-secrets; cp /input/* /tmp/e2e-secrets/; chmod 0600 /tmp/e2e-secrets/*; exec npm run "$TELEX_E2E_SCRIPT"' >/dev/null
finish_outer_phase "create application container"
docker start --attach "$run_container"
finish_outer_phase "live E2E process"
printf 'E2E OUTER %-28s %d ms\n' "total before cleanup" "$(( $(now_ms) - outer_started ))"
