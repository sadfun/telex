import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { z } from "zod";
import { atomicWriteJson, ensureDirectory } from "./fs.js";
import type { Logger } from "./logger.js";

/**
 * Base for the small schema-validated JSON stores. Subclasses read through
 * `state` and replace it with `persist`, which serializes writes through a
 * tail promise so concurrent updates land in order.
 */
export class JsonStore<T> {
  readonly #path: string;
  readonly #schema: z.ZodType<T>;
  readonly #logger: Logger;
  readonly #invalidMessage: string;
  readonly #onInvalid: "warn" | "throw";
  #state: T;
  #writeTail: Promise<void> = Promise.resolve();

  public constructor(
    path: string,
    schema: z.ZodType<T>,
    initialState: T,
    logger: Logger,
    invalidMessage: string,
    onInvalid: "warn" | "throw" = "warn",
  ) {
    this.#path = path;
    this.#schema = schema;
    this.#state = initialState;
    this.#logger = logger;
    this.#invalidMessage = invalidMessage;
    this.#onInvalid = onInvalid;
  }

  public async load(): Promise<void> {
    await ensureDirectory(dirname(this.#path));
    try {
      this.#state = this.#schema.parse(JSON.parse(await readFile(this.#path, "utf8")));
    } catch (error) {
      // A missing file is a fresh store; anything else keeps the initial state or fails closed.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      if (this.#onInvalid === "throw") {
        this.#logger.error(this.#invalidMessage, error, { path: this.#path });
        throw new Error(`${this.#invalidMessage} at ${this.#path}`, { cause: error });
      }
      this.#logger.warn(this.#invalidMessage, { path: this.#path });
    }
  }

  protected get state(): T {
    return this.#state;
  }

  protected async persist(state: T): Promise<void> {
    this.#state = state;
    this.#writeTail = this.#writeTail
      .catch(() => undefined)
      .then(async () => await atomicWriteJson(this.#path, state));
    await this.#writeTail;
  }
}
