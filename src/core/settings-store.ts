import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { atomicWriteJson, ensureDirectory } from "../shared/fs.js";
import type { Logger } from "../shared/logger.js";

const settingsSchema = z.strictObject({
  remoteClientContext: z.boolean(),
});

const storedSettingsSchema = settingsSchema.extend({
  version: z.literal(1),
});

export type TelexSettings = z.infer<typeof settingsSchema>;

const defaultSettings: TelexSettings = {
  remoteClientContext: true,
};

export class TelexSettingsStore {
  readonly #path: string;
  readonly #logger: Logger;
  #settings: TelexSettings = defaultSettings;
  #writeTail: Promise<void> = Promise.resolve();

  public constructor(path: string, logger: Logger) {
    this.#path = path;
    this.#logger = logger;
  }

  public async load(): Promise<void> {
    await ensureDirectory(dirname(this.#path));
    try {
      const { remoteClientContext } = storedSettingsSchema.parse(
        JSON.parse(await readFile(this.#path, "utf8")),
      );
      this.#settings = { remoteClientContext };
    } catch (error) {
      this.#settings = defaultSettings;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.#logger.warn("Ignoring invalid Telex settings", { path: this.#path });
      }
    }
  }

  public read(): TelexSettings {
    return this.#settings;
  }

  public async update(input: unknown): Promise<TelexSettings> {
    const settings = settingsSchema.parse(input);
    const stored = { version: 1 as const, ...settings };
    this.#writeTail = this.#writeTail
      .catch(() => undefined)
      .then(async () => await atomicWriteJson(this.#path, stored));
    await this.#writeTail;
    this.#settings = settings;
    return settings;
  }
}
