const bridgeOnlyEnvironmentKeys = new Set([
  "PUBLIC_URL",
  "TELEGRAM_ALLOWED_USER_IDS",
  "TELEGRAM_API_BASE",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_POLL_TIMEOUT",
]);

/** Build an environment for Codex/npm subprocesses without bridge credentials. */
export function externalProcessEnvironment(
  overrides: Readonly<NodeJS.ProcessEnv> = {},
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  for (const key of bridgeOnlyEnvironmentKeys) delete environment[key];
  return environment;
}
