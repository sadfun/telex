# Telex container image. The container is the isolation boundary: the process
# runs as the unprivileged `telex` user and all state lives under /data.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-slim
ARG TELEX_UID=1001
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git ripgrep \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --uid "${TELEX_UID}" --user-group telex
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json /app/codex.version ./
COPY docker/entrypoint.sh /usr/local/bin/telex-entrypoint
RUN chmod 0755 /usr/local/bin/telex-entrypoint
ENV TELEX_DATA_DIR=/data/telex \
    CODEX_WORKSPACE=/data/workspace
VOLUME /data
# The entrypoint starts as root only to take ownership of freshly created
# volumes, then drops to the unprivileged telex user before running Telex.
ENTRYPOINT ["telex-entrypoint"]
CMD ["node", "dist/index.js"]
