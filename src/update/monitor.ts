import { errorMessage } from "../shared/errors.js";
import type { Logger } from "../shared/logger.js";
import type { ReleaseUpdater } from "./release.js";

export type UpdateMode = "off" | "notify" | "auto";

interface UpdateMonitorOptions {
  readonly updater: ReleaseUpdater;
  readonly mode: UpdateMode;
  readonly intervalMs: number;
  readonly canInstall: boolean;
  readonly logger: Logger;
  readonly signal: AbortSignal;
}

/** Resolves with the installed version when applied, or undefined after cancellation. */
export async function monitorUpdates(options: UpdateMonitorOptions): Promise<string | undefined> {
  if (options.mode === "auto" && !options.canInstall) {
    options.logger.warn(
      "Automatic updates require an installer-managed release; this source checkout will only notify",
    );
  }

  while (!options.signal.aborted) {
    try {
      const status = await options.updater.check("latest", options.signal);
      if (status.updateAvailable) {
        options.logger.info("A newer Telex release is available", {
          currentVersion: status.currentVersion,
          latestVersion: status.release.version,
          release: status.release.pageUrl,
        });
        if (options.mode === "auto" && options.canInstall) {
          const installed = await options.updater.install(status.release, options.signal);
          return installed.version;
        }
      } else {
        options.logger.debug("Telex is current", { version: status.currentVersion });
      }
    } catch (error) {
      if (options.signal.aborted) break;
      options.logger.warn("Could not check for a Telex update", { error: errorMessage(error) });
    }
    await abortableDelay(options.intervalMs, options.signal);
  }
  return undefined;
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    timer.unref();
    signal.addEventListener("abort", finish, { once: true });
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}
