import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { ProviderReference } from "../../core/channel.js";
import { atomicWriteJson, ensureDirectory } from "../../shared/fs.js";
import type { Logger } from "../../shared/logger.js";

const deviceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  owner: z.object({
    provider: z.string().min(1),
    resource: z.literal("user"),
    id: z.string().min(1),
  }),
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/u),
  createdAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
});

const storedStateSchema = z.object({
  version: z.literal(1),
  devices: z.array(deviceSchema).max(100),
});

export type AndroidTvDevice = Readonly<z.infer<typeof deviceSchema>>;

export interface RegisteredAndroidTvDevice {
  readonly device: AndroidTvDevice;
  readonly token: string;
}

export class AndroidTvDeviceStore {
  readonly #path: string;
  readonly #logger: Logger;
  readonly #devices = new Map<string, AndroidTvDevice>();
  #writeTail: Promise<void> = Promise.resolve();

  public constructor(path: string, logger: Logger) {
    this.#path = path;
    this.#logger = logger;
  }

  public async load(): Promise<void> {
    await ensureDirectory(dirname(this.#path));
    try {
      const parsed = storedStateSchema.parse(JSON.parse(await readFile(this.#path, "utf8")));
      this.#devices.clear();
      for (const device of parsed.devices) this.#devices.set(device.id, device);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.#logger.warn("Ignoring invalid Android TV device state", { path: this.#path });
      }
    }
  }

  public async register(
    name: string,
    owner: ProviderReference & { readonly resource: "user" },
  ): Promise<RegisteredAndroidTvDevice> {
    if (this.#devices.size >= 100) {
      throw new Error("The Android TV device limit has been reached");
    }
    const token = randomBytes(32).toString("base64url");
    const now = new Date().toISOString();
    const device: AndroidTvDevice = {
      id: randomBytes(16).toString("base64url"),
      name,
      owner,
      tokenHash: tokenHash(token),
      createdAt: now,
      lastSeenAt: now,
    };
    this.#devices.set(device.id, device);
    await this.persist();
    return { device, token };
  }

  public authenticate(token: string): AndroidTvDevice | undefined {
    const candidate = Buffer.from(tokenHash(token), "hex");
    for (const device of this.#devices.values()) {
      const expected = Buffer.from(device.tokenHash, "hex");
      if (expected.byteLength === candidate.byteLength && timingSafeEqual(expected, candidate)) {
        return device;
      }
    }
    return undefined;
  }

  public hasDevice(id: string): boolean {
    return this.#devices.has(id);
  }

  public async remove(id: string): Promise<boolean> {
    const removed = this.#devices.delete(id);
    if (removed) await this.persist();
    return removed;
  }

  public async touch(id: string): Promise<void> {
    const device = this.#devices.get(id);
    if (device === undefined) return;
    const lastSeenAt = new Date().toISOString();
    if (Date.parse(lastSeenAt) - Date.parse(device.lastSeenAt) < 60_000) return;
    this.#devices.set(id, { ...device, lastSeenAt });
    await this.persist();
  }

  private async persist(): Promise<void> {
    const state = { version: 1 as const, devices: [...this.#devices.values()] };
    this.#writeTail = this.#writeTail.then(async () => {
      await atomicWriteJson(this.#path, state);
    });
    await this.#writeTail;
  }
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
