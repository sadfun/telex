import { spawn } from "node:child_process";
import { BridgeError } from "./errors.js";

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export async function runCommand(
  executable: string,
  args: readonly string[],
  options: Readonly<{
    cwd: string;
    env?: NodeJS.ProcessEnv;
  }>,
): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === 0) resolve(result);
      else {
        reject(
          new BridgeError(
            `${executable} exited with ${code ?? signal ?? "unknown"}: ${result.stderr.trim()}`,
            "COMMAND_FAILED",
          ),
        );
      }
    });
  });
}
