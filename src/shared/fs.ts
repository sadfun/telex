import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function atomicWriteFile(
  path: string,
  contents: string,
  mode: number = 0o600,
): Promise<void> {
  await ensureDirectory(dirname(path));
  const temporaryPath = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx", mode);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readUtf8(path: string): Promise<string> {
  return await readFile(path, "utf8");
}

export function projectRootFrom(moduleUrl: string): string {
  return resolve(dirname(fileURLToPath(moduleUrl)), "../..");
}
