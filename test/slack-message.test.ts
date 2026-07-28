import { describe, expect, it } from "vitest";
import {
  describeSlackFile,
  normalizeSlackMessage,
  routeSlackMessage,
  type SlackMessageEvent,
  slackAttachmentKind,
} from "../src/channels/slack/message.js";

const botUserId = "U0BOT";

function event(overrides: Partial<SlackMessageEvent>): SlackMessageEvent {
  return {
    type: "message",
    channel: "C123",
    channel_type: "channel",
    user: "U1",
    text: "hello",
    ts: "1700000000.000100",
    ...overrides,
  };
}

const noActiveThreads = (): boolean => false;

describe("routeSlackMessage", () => {
  it("always handles direct messages without threading", () => {
    const route = routeSlackMessage(
      event({ channel_type: "im", channel: "D1" }),
      botUserId,
      noActiveThreads,
    );
    expect(route).toEqual({ conversationSuffix: "main", replyThreadTs: undefined });
  });

  it("requires a mention in channels", () => {
    expect(routeSlackMessage(event({}), botUserId, noActiveThreads)).toBeUndefined();
    const route = routeSlackMessage(
      event({ text: `<@${botUserId}> hi` }),
      botUserId,
      noActiveThreads,
    );
    expect(route).toEqual({
      conversationSuffix: "1700000000.000100",
      replyThreadTs: "1700000000.000100",
    });
  });

  it("keys threaded mentions by the thread root", () => {
    const route = routeSlackMessage(
      event({ text: `<@${botUserId}> continue`, thread_ts: "1699.5", ts: "1700.9" }),
      botUserId,
      noActiveThreads,
    );
    expect(route).toEqual({ conversationSuffix: "1699.5", replyThreadTs: "1699.5" });
  });

  it("continues active threads without a mention", () => {
    const route = routeSlackMessage(
      event({ thread_ts: "1699.5", ts: "1700.9" }),
      botUserId,
      (threadRoot) => threadRoot === "1699.5",
    );
    expect(route).toEqual({ conversationSuffix: "1699.5", replyThreadTs: "1699.5" });
  });

  it("ignores bot echoes and unsupported subtypes", () => {
    expect(
      routeSlackMessage(event({ channel_type: "im", bot_id: "B1" }), botUserId, noActiveThreads),
    ).toBeUndefined();
    expect(
      routeSlackMessage(event({ channel_type: "im", user: botUserId }), botUserId, noActiveThreads),
    ).toBeUndefined();
    expect(
      routeSlackMessage(
        event({ channel_type: "im", subtype: "message_changed" }),
        botUserId,
        noActiveThreads,
      ),
    ).toBeUndefined();
    const { user: _ignored, ...anonymous } = event({ channel_type: "im" });
    expect(routeSlackMessage(anonymous, botUserId, noActiveThreads)).toBeUndefined();
  });

  it("handles file_share and thread_broadcast subtypes", () => {
    expect(
      routeSlackMessage(
        event({ channel_type: "im", subtype: "file_share" }),
        botUserId,
        noActiveThreads,
      ),
    ).toBeDefined();
    expect(
      routeSlackMessage(
        event({ text: `<@${botUserId}> x`, subtype: "thread_broadcast" }),
        botUserId,
        noActiveThreads,
      ),
    ).toBeDefined();
  });
});

describe("normalizeSlackMessage", () => {
  it("strips the bot mention and decodes mrkdwn", () => {
    const normalized = normalizeSlackMessage(
      event({ text: `<@${botUserId}> check <https://example.com|this> &amp; more` }),
      botUserId,
    );
    expect(normalized.text).toBe("check this (https://example.com) & more");
  });

  it("keeps other user mentions readable", () => {
    const normalized = normalizeSlackMessage(event({ text: "ask <@U999>" }), botUserId);
    expect(normalized.text).toBe("ask @U999");
  });
});

describe("slack file helpers", () => {
  it("classifies attachment kinds", () => {
    expect(slackAttachmentKind({ id: "F1", mimetype: "image/png" })).toBe("image");
    expect(slackAttachmentKind({ id: "F2", subtype: "slack_audio", mimetype: "audio/mp4" })).toBe(
      "voice",
    );
    expect(slackAttachmentKind({ id: "F3", mimetype: "audio/mpeg" })).toBe("voice");
    expect(slackAttachmentKind({ id: "F4", mimetype: "application/pdf" })).toBe("file");
    expect(slackAttachmentKind({ id: "F5" })).toBe("file");
  });

  it("describes files with metadata", () => {
    expect(
      describeSlackFile({ id: "F1", name: "report.pdf", mimetype: "application/pdf", size: 2_048 }),
    ).toBe("report.pdf (application/pdf, 2 KB)");
    expect(describeSlackFile({ id: "F2" })).toBe("attachment");
  });
});
