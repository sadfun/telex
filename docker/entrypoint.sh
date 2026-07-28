#!/bin/sh
# Seed the Codex configuration on a fresh volume. Codex's own Linux sandbox
# needs user namespaces, which Docker's default seccomp/AppArmor confinement
# blocks; the container itself is the isolation boundary instead.
set -e

data_dir="${TELEX_DATA_DIR:-/data/telex}"
workspace="${CODEX_WORKSPACE:-/data/workspace}"
mkdir -p "${data_dir}/codex-home" "${workspace}"

config="${data_dir}/codex-home/config.toml"
if [ ! -f "${config}" ]; then
  cat > "${config}" <<'EOF'
# Managed by Telex. You can edit this file.
# The container provides isolation; Codex's Linux sandbox is unavailable here.
approval_policy = "on-request"
sandbox_mode = "danger-full-access"
web_search = "live"
cli_auth_credentials_store = "file"
project_root_markers = []
EOF
fi

exec "$@"
