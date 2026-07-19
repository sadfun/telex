import { errorMessage } from "./errors.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const priorities: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export type LogFields = Readonly<Record<string, unknown>>;

export class Logger {
  readonly #minimumLevel: LogLevel;
  readonly #context: LogFields;

  public constructor(minimumLevel: LogLevel, context: LogFields = {}) {
    this.#minimumLevel = minimumLevel;
    this.#context = context;
  }

  public child(context: LogFields): Logger {
    return new Logger(this.#minimumLevel, { ...this.#context, ...context });
  }

  public debug(message: string, fields?: LogFields): void {
    this.write("debug", message, fields);
  }

  public info(message: string, fields?: LogFields): void {
    this.write("info", message, fields);
  }

  public warn(message: string, fields?: LogFields): void {
    this.write("warn", message, fields);
  }

  public error(message: string, error?: unknown, fields?: LogFields): void {
    this.write("error", message, {
      ...fields,
      ...(error === undefined ? {} : { error: errorMessage(error) }),
    });
  }

  private write(level: LogLevel, message: string, fields: LogFields = {}): void {
    if (priorities[level] < priorities[this.#minimumLevel]) return;
    const line = JSON.stringify({
      ...this.#context,
      ...fields,
      timestamp: new Date().toISOString(),
      level,
      message,
    });
    if (level === "error" || level === "warn") console.error(line);
    else console.log(line);
  }
}
