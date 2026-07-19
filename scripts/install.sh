#!/bin/sh

set -eu

REPOSITORY=${TELEX_UPDATE_REPOSITORY:-sadfun/telex}
INSTALL_DIR=${TELEX_INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/telex}
CONFIG_HOME=${XDG_CONFIG_HOME:-$HOME/.config}
CONFIG_DIR=${TELEX_CONFIG_DIR:-$CONFIG_HOME/telex}
BIN_DIR=${TELEX_BIN_DIR:-$HOME/.local/bin}
REQUESTED_VERSION=latest
INSTALL_SERVICE=true
TEMPORARY_DIRECTORY=
STAGE_DIRECTORY=

usage() {
  cat <<'EOF'
Usage: install.sh [options]

Options:
  --version VERSION       Install an exact release instead of latest
  --install-dir PATH      Release/data directory (default: ~/.local/share/telex)
  --config-dir PATH       Configuration directory (default: ~/.config/telex)
  --bin-dir PATH          Command directory (default: ~/.local/bin)
  --repository OWNER/REPO Install releases from a fork
  --no-service            Do not create a systemd or launchd service definition
  -h, --help              Show this help
EOF
}

fail() {
  printf 'telex installer: %s\n' "$1" >&2
  exit 1
}

cleanup() {
  if [ -n "$STAGE_DIRECTORY" ]; then rm -rf "$STAGE_DIRECTORY"; fi
  if [ -n "$TEMPORARY_DIRECTORY" ]; then rm -rf "$TEMPORARY_DIRECTORY"; fi
}

trap cleanup EXIT HUP INT TERM

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version|--install-dir|--config-dir|--bin-dir|--repository)
      [ "$#" -ge 2 ] || fail "$1 requires a value"
      case "$1" in
        --version) REQUESTED_VERSION=$2 ;;
        --install-dir) INSTALL_DIR=$2 ;;
        --config-dir) CONFIG_DIR=$2 ;;
        --bin-dir) BIN_DIR=$2 ;;
        --repository) REPOSITORY=$2 ;;
      esac
      shift 2
      ;;
    --no-service)
      INSTALL_SERVICE=false
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *) fail "unknown option: $1" ;;
  esac
done

for command in curl tar node awk sed; do
  command -v "$command" >/dev/null 2>&1 || fail "$command is required"
done

NODE_MAJOR=$(node -p 'Number(process.versions.node.split(".")[0])')
[ "$NODE_MAJOR" -ge 24 ] || fail "Node.js 24 or newer is required (found $(node --version))"
NODE_BINARY=$(command -v node)
case "$NODE_BINARY" in
  /*) ;;
  *) NODE_BINARY=$(CDPATH= cd -- "$(dirname -- "$NODE_BINARY")" && pwd)/$(basename "$NODE_BINARY") ;;
esac

case "$REPOSITORY" in
  */*/*|/*|*/|*' '*|*'\n'*) fail "repository must be in owner/repository form" ;;
  */*) ;;
  *) fail "repository must be in owner/repository form" ;;
esac

TEMPORARY_DIRECTORY=$(mktemp -d "${TMPDIR:-/tmp}/telex-install.XXXXXX")
RELEASE_JSON=$TEMPORARY_DIRECTORY/release.json
if [ "$REQUESTED_VERSION" = latest ]; then
  RELEASE_API="https://api.github.com/repos/$REPOSITORY/releases/latest"
else
  REQUESTED_VERSION=${REQUESTED_VERSION#v}
  RELEASE_API="https://api.github.com/repos/$REPOSITORY/releases/tags/v$REQUESTED_VERSION"
fi

printf 'Fetching Telex release metadata from %s...\n' "$REPOSITORY"
curl -fsSL \
  -H 'Accept: application/vnd.github+json' \
  -H 'X-GitHub-Api-Version: 2022-11-28' \
  "$RELEASE_API" -o "$RELEASE_JSON"

VERSION=$(node -e '
const fs = require("node:fs");
const release = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (release.draft || (process.argv[2] === "latest" && release.prerelease)) process.exit(2);
const match = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(release.tag_name || "");
if (!match) process.exit(3);
process.stdout.write(match[1]);
' "$RELEASE_JSON" "$REQUESTED_VERSION") || fail "GitHub returned an invalid release"
if [ "$REQUESTED_VERSION" != latest ] && [ "$VERSION" != "$REQUESTED_VERSION" ]; then
  fail "GitHub release tag does not match requested version $REQUESTED_VERSION"
fi

ARCHIVE_NAME=telex-$VERSION.tar.gz
CHECKSUM_NAME=$ARCHIVE_NAME.sha256
ARCHIVE_URL=$(node -e '
const fs = require("node:fs");
const release = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const asset = (release.assets || []).find(({name}) => name === process.argv[2]);
if (!asset) process.exit(2);
process.stdout.write(asset.browser_download_url);
' "$RELEASE_JSON" "$ARCHIVE_NAME") || fail "release is missing $ARCHIVE_NAME"
CHECKSUM_URL=$(node -e '
const fs = require("node:fs");
const release = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const asset = (release.assets || []).find(({name}) => name === process.argv[2]);
if (!asset) process.exit(2);
process.stdout.write(asset.browser_download_url);
' "$RELEASE_JSON" "$CHECKSUM_NAME") || fail "release is missing $CHECKSUM_NAME"

ARCHIVE_PATH=$TEMPORARY_DIRECTORY/$ARCHIVE_NAME
CHECKSUM_PATH=$TEMPORARY_DIRECTORY/$CHECKSUM_NAME
curl -fsSL "$ARCHIVE_URL" -o "$ARCHIVE_PATH"
curl -fsSL "$CHECKSUM_URL" -o "$CHECKSUM_PATH"

EXPECTED_CHECKSUM=$(awk -v name="$ARCHIVE_NAME" '$2 == name || $2 == "*" name { print tolower($1) }' "$CHECKSUM_PATH")
[ -n "$EXPECTED_CHECKSUM" ] || fail "checksum file does not name $ARCHIVE_NAME"
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL_CHECKSUM=$(sha256sum "$ARCHIVE_PATH" | awk '{ print $1 }')
elif command -v shasum >/dev/null 2>&1; then
  ACTUAL_CHECKSUM=$(shasum -a 256 "$ARCHIVE_PATH" | awk '{ print $1 }')
else
  fail "sha256sum or shasum is required"
fi
[ "$ACTUAL_CHECKSUM" = "$EXPECTED_CHECKSUM" ] || fail "release checksum verification failed"

mkdir -p "$INSTALL_DIR/releases" "$INSTALL_DIR/bin" "$INSTALL_DIR/data" "$CONFIG_DIR" "$BIN_DIR"
RELEASE_DIRECTORY=$INSTALL_DIR/releases/$VERSION
validate_release() {
  node -e '
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[1];
const version = process.argv[2];
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
if (pkg.name !== "telex" || pkg.version !== version) process.exit(2);
for (const file of ["dist/cli/main.js", "dist/index.js", "codex.version", "node_modules"]) {
  if (!fs.existsSync(path.join(root, file))) process.exit(3);
}
' "$1" "$VERSION" || fail "release bundle is incomplete or has the wrong version"
}

if [ ! -d "$RELEASE_DIRECTORY" ]; then
  STAGE_DIRECTORY=$(mktemp -d "$INSTALL_DIR/releases/.$VERSION.XXXXXX")
  tar -xzf "$ARCHIVE_PATH" -C "$STAGE_DIRECTORY"
  validate_release "$STAGE_DIRECTORY"
  mv "$STAGE_DIRECTORY" "$RELEASE_DIRECTORY"
  STAGE_DIRECTORY=
else
  validate_release "$RELEASE_DIRECTORY"
fi

if [ -e "$INSTALL_DIR/current" ] && [ ! -L "$INSTALL_DIR/current" ]; then
  fail "$INSTALL_DIR/current exists and is not an installer-managed symlink"
fi
CURRENT_LINK=$INSTALL_DIR/.current.$$
ln -s "releases/$VERSION" "$CURRENT_LINK"
mv -f "$CURRENT_LINK" "$INSTALL_DIR/current"

CONFIG_FILE=$CONFIG_DIR/telex.env
CONFIG_ESCAPED=$(printf '%s' "$CONFIG_FILE" | sed "s/'/'\\\\''/g")
NODE_ESCAPED=$(printf '%s' "$NODE_BINARY" | sed "s/'/'\\\\''/g")
WRAPPER=$INSTALL_DIR/bin/telex
{
  printf '%s\n' '#!/bin/sh' 'set -eu' 'SELF=$0'
  printf '%s\n' 'while [ -L "$SELF" ]; do' '  LINK=$(readlink "$SELF")' '  case "$LINK" in' '    /*) SELF=$LINK ;;' '    *) SELF=$(dirname "$SELF")/$LINK ;;' '  esac' 'done'
  printf '%s\n' 'INSTALL_DIR=$(CDPATH= cd -- "$(dirname -- "$SELF")/.." && pwd)'
  printf "CONFIG_FILE=\${TELEX_CONFIG_FILE:-'%s'}\n" "$CONFIG_ESCAPED"
  printf "NODE_BINARY='%s'\n" "$NODE_ESCAPED"
  printf '%s\n' 'PATH=$(dirname "$NODE_BINARY"):${PATH:-/usr/local/bin:/usr/bin:/bin}' 'export PATH TELEX_INSTALL_DIR=$INSTALL_DIR' 'exec "$NODE_BINARY" --env-file-if-exists="$CONFIG_FILE" "$INSTALL_DIR/current/dist/cli/main.js" "$@"'
} > "$WRAPPER"
chmod 755 "$WRAPPER"

COMMAND_LINK=$BIN_DIR/telex
if [ -e "$COMMAND_LINK" ] && [ ! -L "$COMMAND_LINK" ]; then
  fail "$COMMAND_LINK already exists and is not a symlink"
fi
ln -sfn "$WRAPPER" "$COMMAND_LINK"

if [ ! -e "$CONFIG_FILE" ]; then
  {
    printf '%s\n' '# Required: create the bot with @BotFather.' 'TELEGRAM_BOT_TOKEN=123456:replace-me' ''
    printf '%s\n' '# Required: comma-separated numeric Telegram user IDs.' 'TELEGRAM_ALLOWED_USER_IDS=123456789' ''
    printf '%s\n' '# Optional HTTPS origin for the settings Mini App. When unset, Telex opens' '# a TryCloudflare quick tunnel with an automatically installed cloudflared' '# (TELEX_TUNNEL=off disables the fallback).' '# PUBLIC_URL=https://codex.example.com' 'TELEX_TUNNEL=auto' ''
    printf 'TELEX_DATA_DIR=%s\n' "$INSTALL_DIR/data"
    printf 'CODEX_WORKSPACE=%s\n' "$INSTALL_DIR/data/workspace"
    printf '%s\n' 'HOST=127.0.0.1' 'PORT=8787' 'CODEX_CHECK_UPDATES=true' 'TELEX_UPDATE_MODE=auto' 'TELEX_UPDATE_INTERVAL_HOURS=6' "TELEX_UPDATE_REPOSITORY=$REPOSITORY" 'LOG_LEVEL=info'
  } > "$CONFIG_FILE"
  chmod 600 "$CONFIG_FILE"
fi

SERVICE_MESSAGE=
if [ "$INSTALL_SERVICE" = true ]; then
  case "$(uname -s)" in
    Linux)
      SERVICE_DIRECTORY=$CONFIG_HOME/systemd/user
      SERVICE_FILE=$SERVICE_DIRECTORY/telex.service
      mkdir -p "$SERVICE_DIRECTORY"
      {
        printf '%s\n' '[Unit]' 'Description=Telex Telegram bridge for OpenAI Codex' 'After=network-online.target' 'Wants=network-online.target' '' '[Service]'
        printf 'ExecStart="%s" start\n' "$WRAPPER"
        printf '%s\n' 'Restart=always' 'RestartSec=5' '' '[Install]' 'WantedBy=default.target'
      } > "$SERVICE_FILE"
      SERVICE_MESSAGE="Run: systemctl --user daemon-reload && systemctl --user enable --now telex"
      ;;
    Darwin)
      SERVICE_DIRECTORY=$HOME/Library/LaunchAgents
      SERVICE_FILE=$SERVICE_DIRECTORY/com.sadfun.telex.plist
      LOG_DIRECTORY=$INSTALL_DIR/logs
      mkdir -p "$SERVICE_DIRECTORY" "$LOG_DIRECTORY"
      WRAPPER_XML=$(printf '%s' "$WRAPPER" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g')
      LOG_XML=$(printf '%s' "$LOG_DIRECTORY" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g')
      {
        printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">' '<plist version="1.0"><dict>' '<key>Label</key><string>com.sadfun.telex</string>' '<key>ProgramArguments</key><array>' "<string>$WRAPPER_XML</string>" '<string>start</string></array>' '<key>RunAtLoad</key><true/>' '<key>KeepAlive</key><true/>' '<key>ThrottleInterval</key><integer>5</integer>' "<key>StandardOutPath</key><string>$LOG_XML/telex.log</string>" "<key>StandardErrorPath</key><string>$LOG_XML/telex.error.log</string>" '</dict></plist>'
      } > "$SERVICE_FILE"
      SERVICE_MESSAGE="Run: launchctl bootstrap gui/$(id -u) $SERVICE_FILE"
      ;;
    *) SERVICE_MESSAGE='No service definition was created for this operating system.' ;;
  esac
fi

printf '\nTelex %s is installed.\n' "$VERSION"
printf '1. Edit %s\n' "$CONFIG_FILE"
printf '2. %s\n' "${SERVICE_MESSAGE:-Run: $COMMAND_LINK start}"
printf '3. In Telegram, send /login to authenticate Codex.\n'
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) printf 'Add %s to PATH to use the telex command directly.\n' "$BIN_DIR" ;;
esac
