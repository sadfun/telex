import { z } from "zod";
import { JsonStore } from "../shared/json-store.js";
import type { Logger } from "../shared/logger.js";

const settingsSchema = z.strictObject({
  remoteClientContext: z.boolean(),
});

const storedSettingsSchema = settingsSchema.extend({
  version: z.literal(1),
});

export type TelexSettings = z.infer<typeof settingsSchema>;

export class TelexSettingsStore extends JsonStore<z.infer<typeof storedSettingsSchema>> {
  public constructor(path: string, logger: Logger) {
    super(
      path,
      storedSettingsSchema,
      { version: 1, remoteClientContext: true },
      logger,
      "Ignoring invalid Telex settings",
    );
  }

  public read(): TelexSettings {
    return { remoteClientContext: this.state.remoteClientContext };
  }

  public async update(input: unknown): Promise<TelexSettings> {
    const settings = settingsSchema.parse(input);
    await this.persist({ version: 1, ...settings });
    return settings;
  }
}
