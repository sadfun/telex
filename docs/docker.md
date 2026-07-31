# Running Telex in Docker

The image runs Telex as the unprivileged `telex` user (uid 1001) with all
state — Codex home (auth, config, threads), the pinned Codex toolchain, the
workspace, and conversation/automation stores — under the `/data` volume.
No ports need to be published: both the Telegram and Slack connectors dial
out (long polling / Socket Mode).

```bash
cp docker/docker-compose.example.yml docker-compose.yml
cp .env.example .env   # fill in SLACK_* and/or TELEGRAM_* variables
docker compose up -d --build
docker compose logs -f
```

To keep state on the host under a dedicated user instead of a named volume:

```bash
useradd --system --uid 1001 --user-group --shell /usr/sbin/nologin telex
mkdir -p /srv/telex/data && chown -R telex:telex /srv/telex/data
# then bind-mount /srv/telex/data:/data in the compose file
```

## Codex sandboxing inside the container

On bare Linux, Codex sandboxes shell commands with a bubblewrap helper that
needs unprivileged user namespaces. Docker's default seccomp and AppArmor
confinement blocks that, so the entrypoint seeds `config.toml` with
`sandbox_mode = "danger-full-access"` on a fresh volume: the container — an
isolated filesystem, an unprivileged user, and no host mounts beyond `/data`
— is the sandbox boundary instead. Keep that in mind before bind-mounting
anything sensitive into the container.

## Notes

- The settings Mini App binds to `HOST:PORT` inside the container; publish
  the port and set `PUBLIC_URL` if you use it with the Telegram connector.
- Telex's release self-update (`/update`, `TELEX_UPDATE_MODE=auto`) does not
  apply to containers — rebuild the image to update instead.
- The first start on a fresh volume downloads the pinned Codex CLI from npm
  into `/data/telex/toolchains`.
