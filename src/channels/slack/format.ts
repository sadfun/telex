const boldOpen = "\u0000B\u0000";
const boldClose = "\u0000/B\u0000";

/**
 * Convert standard Markdown produced by Codex into Slack's mrkdwn dialect.
 *
 * The conversion is heuristic: Slack has no headings or tables, single
 * asterisks mean bold instead of italic, and links use `<url|label>`. Code
 * fences and inline code spans pass through untouched apart from the entity
 * escaping Slack requires everywhere.
 */
export function markdownToMrkdwn(markdown: string): string {
  const segments = splitByCodeFence(markdown.replaceAll("\u0000", ""));
  return segments
    .map((segment) =>
      segment.kind === "fence" ? escapeSlackEntities(segment.text) : convertProse(segment.text),
    )
    .join("");
}

interface Segment {
  readonly kind: "prose" | "fence";
  readonly text: string;
}

function splitByCodeFence(text: string): readonly Segment[] {
  const segments: Segment[] = [];
  const fence = /^(?:```|~~~)[^\n]*$/mu;
  let remaining = text;
  let insideFence = false;
  while (remaining.length > 0) {
    const match = fence.exec(remaining);
    if (match === null || match.index === undefined) {
      segments.push({ kind: insideFence ? "fence" : "prose", text: remaining });
      break;
    }
    const lineEnd = match.index + match[0].length;
    segments.push({
      kind: insideFence ? "fence" : "prose",
      text: remaining.slice(0, lineEnd),
    });
    remaining = remaining.slice(lineEnd);
    insideFence = !insideFence;
  }
  return segments;
}

function convertProse(text: string): string {
  const spans = splitByInlineCode(text);
  return spans
    .map((span) =>
      span.kind === "code" ? escapeSlackEntities(span.text) : convertPlainProse(span.text),
    )
    .join("");
}

function splitByInlineCode(
  text: string,
): readonly Readonly<{ kind: "plain" | "code"; text: string }>[] {
  const spans: { kind: "plain" | "code"; text: string }[] = [];
  const pattern = /`[^`\n]+`/gu;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > cursor) spans.push({ kind: "plain", text: text.slice(cursor, match.index) });
    spans.push({ kind: "code", text: match[0] });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) spans.push({ kind: "plain", text: text.slice(cursor) });
  return spans;
}

function convertPlainProse(text: string): string {
  let result = escapeSlackEntities(text);
  // Markdown images and links become Slack links. The label drops `|`, which
  // Slack reserves as its own separator.
  result = result.replaceAll(
    /!?\[([^\]\n]*)\]\((\S+?)\)/gu,
    (_match, label: string, url: string) => {
      const safeLabel = label.replaceAll("|", "/").trim();
      return safeLabel.length === 0 ? `<${url}>` : `<${url}|${safeLabel}>`;
    },
  );
  // Headings become bold lines.
  result = result.replaceAll(/^#{1,6}[ \t]+(.+?)[ \t]*#*$/gmu, (_match, heading: string) => {
    const plain = heading.replaceAll(/\*\*|__/gu, "");
    return `${boldOpen}${plain}${boldClose}`;
  });
  // Bold before italic, through placeholders, so `**x**` never reads as
  // two nested single-asterisk spans.
  result = result.replaceAll(/\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*/gu, `${boldOpen}$1${boldClose}`);
  result = result.replaceAll(/__(?=\S)([\s\S]+?)(?<=\S)__/gu, `${boldOpen}$1${boldClose}`);
  result = result.replaceAll(/(?<![\w*])\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*(?![\w*])/gu, "_$1_");
  result = result.replaceAll(/~~(?=\S)([^~\n]+?)(?<=\S)~~/gu, "~$1~");
  // List bullets: `*` and `+` markers would collide with bold; `•` reads well.
  result = result.replaceAll(/^([ \t]*)[*+-][ \t]+/gmu, "$1• ");
  // Escaping turned Markdown blockquotes into `&gt;`; Slack needs a literal `>`.
  result = result.replaceAll(/^&gt;[ \t]?/gmu, "> ");
  result = result.replaceAll(boldOpen, "*").replaceAll(boldClose, "*");
  return result;
}

export function escapeSlackEntities(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * Decode the mrkdwn markup of an incoming Slack message into plain text for
 * Codex: entity escapes are reversed and `<...>` references become readable.
 */
export function mrkdwnToPlainText(text: string): string {
  let result = text;
  result = result.replaceAll(
    /<(https?:\/\/[^|>]+)\|([^>]*)>/gu,
    (_match, url: string, label: string) => (label.length === 0 ? url : `${label} (${url})`),
  );
  result = result.replaceAll(/<(https?:\/\/[^|>]+)>/gu, "$1");
  result = result.replaceAll(/<#[A-Z0-9]+\|([^>]*)>/gu, "#$1");
  result = result.replaceAll(/<@([A-Z0-9]+)>/gu, "@$1");
  result = result.replaceAll(
    /<!([a-z]+)(?:\|([^>]*))?>/gu,
    (_match, name: string, label?: string) =>
      label !== undefined && label.length > 0 ? label : `@${name}`,
  );
  result = result.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
  return result;
}
