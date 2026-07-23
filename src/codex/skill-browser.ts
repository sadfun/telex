import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";

const MAX_SKILL_FILE_BYTES = 2 * 1_024 * 1_024;
const MAX_DIRECTORY_ENTRIES = 1_000;

export interface SkillDirectoryEntry {
  readonly name: string;
  readonly path: string;
  readonly type: "directory" | "file";
  readonly size: number | null;
}

export interface SkillDirectory {
  readonly type: "directory";
  readonly path: string;
  readonly entries: readonly SkillDirectoryEntry[];
}

export interface SkillFile {
  readonly type: "file";
  readonly path: string;
  readonly size: number;
  readonly mediaType: string;
  readonly encoding: "base64" | "utf8";
  readonly content: string;
}

export type SkillResource = SkillDirectory | SkillFile;

export class SkillBrowserError extends Error {
  public readonly code: "forbidden" | "not_found" | "too_large";

  public constructor(
    message: string,
    code: "forbidden" | "not_found" | "too_large",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SkillBrowserError";
    this.code = code;
  }
}

export async function readSkillResource(
  skillFilePath: string,
  requestedPath: string,
): Promise<SkillResource> {
  validateRequestedPath(requestedPath);
  const root = await realpath(resolve(skillFilePath, "..")).catch((error: unknown) => {
    throw new SkillBrowserError("The skill directory is unavailable.", "not_found", {
      cause: error,
    });
  });
  const candidate = resolve(root, requestedPath || ".");
  const resolved = await realpath(candidate).catch((error: unknown) => {
    throw new SkillBrowserError("The requested skill file was not found.", "not_found", {
      cause: error,
    });
  });
  assertContained(root, resolved);

  const details = await stat(resolved);
  if (details.isDirectory()) return await readDirectory(root, resolved, requestedPath);
  if (!details.isFile()) {
    throw new SkillBrowserError("The requested skill resource is unavailable.", "not_found");
  }
  if (details.size > MAX_SKILL_FILE_BYTES) {
    throw new SkillBrowserError(
      `This file is larger than the ${MAX_SKILL_FILE_BYTES / 1_024 / 1_024} MB preview limit.`,
      "too_large",
    );
  }

  const contents = await readFile(resolved);
  const mediaType = mediaTypeFor(resolved);
  const encoding = isTextFile(resolved, contents) ? "utf8" : "base64";
  return {
    type: "file",
    path: normalizeRelativePath(requestedPath),
    size: details.size,
    mediaType,
    encoding,
    content: contents.toString(encoding),
  };
}

async function readDirectory(
  root: string,
  directory: string,
  requestedPath: string,
): Promise<SkillDirectory> {
  const children = await readdir(directory, { withFileTypes: true });
  if (children.length > MAX_DIRECTORY_ENTRIES) {
    throw new SkillBrowserError(
      `This directory has more than ${MAX_DIRECTORY_ENTRIES} entries and cannot be previewed.`,
      "too_large",
    );
  }
  const entries = (
    await Promise.all(
      children.map(async (child): Promise<SkillDirectoryEntry | undefined> => {
        const childPath = resolve(directory, child.name);
        const resolved = await realpath(childPath).catch(() => undefined);
        if (resolved === undefined || !isContained(root, resolved)) return undefined;
        const details = await stat(resolved).catch(() => undefined);
        if (details === undefined || (!details.isDirectory() && !details.isFile()))
          return undefined;
        const path = normalizeRelativePath(relative(root, resolved));
        return {
          name: child.name,
          path,
          type: details.isDirectory() ? "directory" : "file",
          size: details.isFile() ? details.size : null,
        };
      }),
    )
  )
    .filter(isDefined)
    .sort(
      (left, right) =>
        Number(left.type === "file") - Number(right.type === "file") ||
        left.name.localeCompare(right.name),
    );
  return {
    type: "directory",
    path: normalizeRelativePath(requestedPath),
    entries,
  };
}

function validateRequestedPath(requestedPath: string): void {
  if (
    requestedPath.includes("\0") ||
    isAbsolute(requestedPath) ||
    requestedPath.split(/[\\/]/u).includes("..")
  ) {
    throw new SkillBrowserError("The requested path is outside this skill.", "forbidden");
  }
}

function assertContained(root: string, candidate: string): void {
  if (!isContained(root, candidate)) {
    throw new SkillBrowserError("The requested path is outside this skill.", "forbidden");
  }
}

function isContained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function normalizeRelativePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\/+/u, "");
}

function isTextFile(path: string, contents: Buffer): boolean {
  if (contents.includes(0)) return false;
  return textExtensions.has(extname(path).toLowerCase()) || isValidUtf8(contents);
}

function isValidUtf8(contents: Buffer): boolean {
  return Buffer.from(contents.toString("utf8"), "utf8").equals(contents);
}

function mediaTypeFor(path: string): string {
  return mediaTypes.get(extname(path).toLowerCase()) ?? "application/octet-stream";
}

const mediaTypes = new Map<string, string>([
  [".avif", "image/avif"],
  [".css", "text/css"],
  [".gif", "image/gif"],
  [".html", "text/html"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript"],
  [".json", "application/json"],
  [".md", "text/markdown"],
  [".mjs", "text/javascript"],
  [".png", "image/png"],
  [".py", "text/x-python"],
  [".sh", "text/x-shellscript"],
  [".svg", "image/svg+xml"],
  [".toml", "application/toml"],
  [".ts", "text/typescript"],
  [".tsx", "text/typescript"],
  [".txt", "text/plain"],
  [".webp", "image/webp"],
  [".yaml", "application/yaml"],
  [".yml", "application/yaml"],
]);

const textExtensions = new Set([
  ".css",
  ".csv",
  ".html",
  ".ini",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".sql",
  ".svg",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

function isDefined<Value>(value: Value | undefined): value is Value {
  return value !== undefined;
}
