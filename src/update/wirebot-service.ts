import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { externalProcessEnvironment } from "../shared/environment.js";
import { atomicWriteFile } from "../shared/fs.js";
import { runCommand } from "../shared/process.js";
import { wirebotImage } from "./docker.js";

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function shellCommand(args: readonly string[]): string {
  return args.map(quote).join(" ");
}

async function hostCommand(args: readonly string[]): Promise<string> {
  const [command, ...rest] = args;
  if (command === undefined) throw new Error("Missing service command");
  const result = await runCommand(command, rest, {
    cwd: "/",
    env: externalProcessEnvironment(),
    timeout: 60_000,
  });
  return result.stdout.trim();
}

/** No resident process: only pull/inspect on the common path; Node handles rare transactions. */
export function updaterScript(
  directory: string,
  name: string,
  dockerCommand: readonly string[],
  maintenanceCommand: readonly string[],
  retireService: string,
): string {
  return `#!/bin/sh
set -eu
umask 077
cd ${quote(directory)}
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
unset DOCKER_HOST DOCKER_CONTEXT DOCKER_TLS_VERIFY
docker() { ${shellCommand(dockerCommand)} "$@"; }
maintain() {
  : > maintenance-needed
  exec ${shellCommand(maintenanceCommand)}
}

# Only the replacement job can stop Telex without killing its own migration midway.
if [ ! -f service-retired ]; then
${retireService}
  : > service-retired
fi

# launchd bootout can return before the old process has released its PID lock.
attempt=0
while [ -f runtime.lock ]; do
  pid=$(cat runtime.lock) || break
  case "$pid" in ''|*[!0-9]*|0) echo "Invalid migration lock" >&2; exit 1 ;; esac
  kill -0 "$pid" 2>/dev/null || break
  attempt=$((attempt + 1))
  [ "$attempt" -lt 60 ] || exit 1
  sleep 1
done

[ -f current-image ] && [ ! -f maintenance-needed ] || maintain
current=$(cat current-image)
case "$current" in sha256:*) ;; *) maintain ;; esac
status=$(docker inspect --format '{{.State.Running}} {{.State.Restarting}} {{.Image}} {{index .Config.Labels "io.github.sadfun.telex-migration"}}' ${quote(name)}) || maintain
[ "$status" = "true false $current ${name}" ] || maintain
docker pull ${quote(wirebotImage)}
latest=$(docker image inspect --format '{{.Id}}' ${quote(wirebotImage)})
[ "$latest" = "$current" ] || maintain
`;
}

export function systemdUnits(script: string, seconds: number): { service: string; timer: string } {
  if (/[\r\n\0]/u.test(script)) throw new Error("Unsupported control character in service path");
  const argument = `"${script
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")
    .replaceAll("$", () => "$$")}"`;
  return {
    service: `[Unit]
Description=Wirebot image update
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/bin/sh ${argument}
TimeoutStartSec=90min
Restart=no
`,
    timer: `[Unit]
Description=Check for Wirebot image updates

[Timer]
OnBootSec=1min
OnUnitInactiveSec=${seconds}s
AccuracySec=1min

[Install]
WantedBy=timers.target
`,
  };
}

export function launchAgent(label: string, script: string, seconds: number): string {
  const xml = (value: string) =>
    value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array><string>/bin/sh</string><string>${xml(script)}</string></array>
<key>RunAtLoad</key><true/>
<key>StartInterval</key><integer>${seconds}</integer>
</dict></plist>
`;
}

export const wirebotService = {
  async prepare(
    directory: string,
    state: { name: string; dockerCommand: readonly string[] },
    intervalMs: number,
  ): Promise<() => Promise<void>> {
    const seconds = Math.max(60, Math.ceil(intervalMs / 1_000));
    const script = join(directory, "update.sh");
    // The installer's launcher keeps the stable Node path; Homebrew may remove this
    // process's versioned Cellar executable during its next upgrade.
    const maintenance = [
      ...(process.env.TELEX_INSTALL_DIR
        ? [join(resolve(process.env.TELEX_INSTALL_DIR), "bin", "telex")]
        : [process.execPath, fileURLToPath(new URL("../cli/main.js", import.meta.url))]),
      "wirebot-update",
      directory,
    ];
    const name = `${state.name}-update`;
    if (process.platform === "linux") {
      let manager = ["systemctl", "--user"];
      // Root installations may use a system unit instead of the installer's user unit.
      if (process.getuid?.() === 0) {
        const pid = await hostCommand([
          "systemctl",
          "show",
          "telex.service",
          "-p",
          "MainPID",
          "--value",
        ]);
        if (pid === String(process.pid)) manager = ["systemctl"];
      }
      try {
        await hostCommand([...manager, "show-environment"]);
      } catch (error) {
        if (process.getuid?.() !== 0) throw error;
        manager = ["systemctl"];
        await hostCommand([...manager, "show-environment"]);
      }
      const unitDirectory = manager.includes("--user")
        ? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "systemd", "user")
        : "/etc/systemd/system";
      const units = systemdUnits(script, seconds);
      await atomicWriteFile(join(unitDirectory, `${name}.service`), units.service);
      await atomicWriteFile(join(unitDirectory, `${name}.timer`), units.timer);
      const ctl = shellCommand(manager);
      await atomicWriteFile(
        script,
        updaterScript(
          directory,
          state.name,
          state.dockerCommand,
          maintenance,
          `  if [ "$(${ctl} show telex.service -p LoadState --value)" = loaded ]; then
    ${ctl} disable --now telex.service
  fi`,
        ),
        0o700,
      );
      await hostCommand([...manager, "daemon-reload"]);
      return async () => {
        await hostCommand([...manager, "enable", "--now", `${name}.timer`]);
        await hostCommand([...manager, "start", "--no-block", `${name}.service`]);
      };
    }
    if (process.platform === "darwin") {
      const domain = `gui/${process.getuid?.()}`;
      await hostCommand(["/bin/launchctl", "print", domain]);
      const label = `com.sadfun.${name}`;
      const plist = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
      await atomicWriteFile(plist, launchAgent(label, script, seconds));
      await atomicWriteFile(
        script,
        updaterScript(
          directory,
          state.name,
          state.dockerCommand,
          maintenance,
          `  if /bin/launchctl print ${quote(`${domain}/com.sadfun.telex`)} >/dev/null 2>&1; then
    /bin/launchctl disable ${quote(`${domain}/com.sadfun.telex`)}
    /bin/launchctl bootout ${quote(`${domain}/com.sadfun.telex`)}
  fi`,
        )
          // Keep only the latest invocation's log, without another daemon for log rotation.
          .replace(
            "umask 077\n",
            `umask 077\nexec >${quote(join(directory, "update.log"))} 2>&1\n`,
          ),
        0o700,
      );
      return async () => {
        // An already-loaded job must not be booted out while it might be replacing the image.
        try {
          await hostCommand(["/bin/launchctl", "print", `${domain}/${label}`]);
        } catch {
          await hostCommand(["/bin/launchctl", "enable", `${domain}/${label}`]);
          await hostCommand(["/bin/launchctl", "bootstrap", domain, plist]);
        }
      };
    }
    throw new Error("Wirebot auto-updates require systemd or launchd");
  },
};
