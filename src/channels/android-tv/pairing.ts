import { randomBytes, randomInt } from "node:crypto";
import type { ProviderReference } from "../../core/channel.js";
import type { AndroidTvDevice, AndroidTvDeviceStore } from "./device-store.js";

export interface AndroidTvPairingChallenge {
  readonly id: string;
  readonly code: string;
  readonly deviceName: string;
  readonly expiresAt: string;
}

export type AndroidTvPairingStatus =
  | { readonly status: "pending"; readonly expiresAt: string }
  | {
      readonly status: "approved";
      readonly device: Pick<AndroidTvDevice, "id" | "name">;
      readonly token: string;
    }
  | { readonly status: "expired" }
  | { readonly status: "not_found" };

interface PendingPairing extends AndroidTvPairingChallenge {
  approved?: {
    readonly device: Pick<AndroidTvDevice, "id" | "name">;
    readonly token: string;
  };
}

export class AndroidTvPairingService {
  static readonly ttlMs = 10 * 60 * 1_000;
  readonly #devices: AndroidTvDeviceStore;
  readonly #pending = new Map<string, PendingPairing>();
  readonly #now: () => number;

  public constructor(devices: AndroidTvDeviceStore, now: () => number = Date.now) {
    this.#devices = devices;
    this.#now = now;
  }

  public create(deviceName: string): AndroidTvPairingChallenge {
    this.expire();
    let code = "";
    do {
      code = randomInt(0, 100_000_000).toString().padStart(8, "0");
    } while ([...this.#pending.values()].some((candidate) => candidate.code === code));
    const challenge: PendingPairing = {
      id: randomBytes(24).toString("base64url"),
      code,
      deviceName,
      expiresAt: new Date(this.#now() + AndroidTvPairingService.ttlMs).toISOString(),
    };
    this.#pending.set(challenge.id, challenge);
    return challenge;
  }

  public status(id: string): AndroidTvPairingStatus {
    this.expire();
    const pairing = this.#pending.get(id);
    if (pairing === undefined) return { status: "not_found" };
    if (pairing.approved === undefined) {
      return { status: "pending", expiresAt: pairing.expiresAt };
    }
    return { status: "approved", ...pairing.approved };
  }

  public consumeForDevice(deviceId: string): void {
    for (const [id, pairing] of this.#pending) {
      if (pairing.approved?.device.id === deviceId) this.#pending.delete(id);
    }
  }

  public async approve(
    code: string,
    owner: ProviderReference,
  ): Promise<
    | { readonly status: "approved"; readonly device: AndroidTvDevice }
    | {
        readonly status: "not_found";
      }
  > {
    this.expire();
    if (owner.resource !== "user") return { status: "not_found" };
    const pairing = [...this.#pending.values()].find(
      (candidate) => candidate.code === code && candidate.approved === undefined,
    );
    if (pairing === undefined) return { status: "not_found" };
    const registered = await this.#devices.register(pairing.deviceName, {
      provider: owner.provider,
      resource: "user",
      id: owner.id,
    });
    pairing.approved = {
      device: { id: registered.device.id, name: registered.device.name },
      token: registered.token,
    };
    return { status: "approved", device: registered.device };
  }

  private expire(): void {
    const now = this.#now();
    for (const [id, pairing] of this.#pending) {
      if (Date.parse(pairing.expiresAt) <= now) this.#pending.delete(id);
    }
  }
}
