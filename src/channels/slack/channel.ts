import { join } from "node:path";
import { SocketModeClient } from "@slack/socket-mode";
import { LogLevel, WebClient } from "@slack/web-api";
import type { SlackConfig } from "../../config/env.js";
import type {
  ChoiceOption,
  DeliveryReceipt,
  InboundAttachment,
  InboundMessage,
  MessageHandler,
  MessagingChannel,
  OutboundMessage,
  ProviderReference,
} from "../../core/channel.js";
import { type Deferred, deferred } from "../../shared/async.js";
import { errorMessage } from "../../shared/errors.js";
import type { Logger } from "../../shared/logger.js";
import { isWorkspaceMember } from "./authorization.js";
import { type CodexConfigAccess, SlackConfigUi, slackConfigActionPrefix } from "./config-ui.js";
import { downloadSlackFile, SlackFileDownloadError } from "./file.js";
import { escapeSlackEntities } from "./format.js";
import {
  describeSlackFile,
  normalizeSlackMessage,
  routeSlackMessage,
  type SlackMessageEvent,
  slackAttachmentKind,
} from "./message.js";
import {
  parseSlackDeliveryTarget,
  slackDeliveryTarget,
  slackMessageReference,
} from "./references.js";
import {
  choicePromptText,
  decodeSlackCommandValue,
  publishSlackMessage,
  type SlackBlock,
  type SlackChoiceRequester,
  type SlackMessagingApi,
  SlackResponder,
} from "./reply.js";

export const slackSlashCommandHelp = [
  "`/telex new` — start a fresh Codex task",
  "`/telex back` — return to the previous Codex task",
  "`/telex stop` — stop the running turn",
  "`/telex schedules` — list scheduled runs",
  "`/telex status` — show Codex status",
  "`/telex login` / `/telex logout` — manage the ChatGPT sign-in",
  "`/telex config` — open Codex settings",
  "`/telex reload` / `/telex restart` — refresh or restart Codex",
  "`/telex update` — update Telex",
  "`/telex help` — show commands",
].join("\n");

interface SocketEnvelope {
  readonly ack: (response?: unknown) => Promise<void>;
  readonly envelope_id?: string;
  readonly body?: unknown;
  readonly event?: unknown;
}

interface SlackSlashCommandPayload {
  readonly command?: string;
  readonly text?: string;
  readonly user_id?: string;
  readonly user_name?: string;
  readonly channel_id?: string;
  readonly channel_name?: string;
  readonly response_url?: string;
}

interface SlackBlockAction {
  readonly action_id?: string;
  readonly value?: string;
}

interface SlackInteractivePayload {
  readonly type?: string;
  readonly user?: { readonly id?: string };
  readonly channel?: { readonly id?: string };
  readonly message?: {
    readonly ts?: string;
    readonly thread_ts?: string;
    readonly text?: string;
  };
  readonly actions?: readonly SlackBlockAction[];
}

interface PendingChoice {
  readonly userId: string;
  readonly options: readonly ChoiceOption[];
  readonly result: Deferred<string>;
  readonly timer: NodeJS.Timeout;
  readonly channel: string;
  readonly messageTs: string;
  readonly baseText: string;
}

const recentEventLimit = 500;
const activeThreadLimit = 500;
const displayNameCacheLimit = 500;
const membershipCacheLimit = 1_000;
/** Deactivations and role changes must take effect without a restart. */
const membershipCacheTtlMs = 10 * 60 * 1_000;

/** Commands that act on one conversation and therefore need a thread in channels. */
const conversationScopedCommands = new Set(["new", "back", "stop", "schedules", "continue"]);

/** Commands that change this Telex instance for everyone using it. */
const adminCommands = new Set(["config", "login", "logout", "reload", "restart", "update"]);

/** Mirror of the bridge's plain-text command parser, for gating before dispatch. */
function parseTextCommand(text: string): Readonly<{ name: string; args: string }> | undefined {
  const match = /^\/([a-z][a-z0-9_]*)(?:@[a-z0-9_]+)?(?:[ \t]+([^\r\n]*))?$/i.exec(text.trim());
  const name = match?.[1];
  if (name === undefined) return undefined;
  return { name: name.toLowerCase(), args: match?.[2]?.trimStart() ?? "" };
}

export class SlackChannel implements MessagingChannel {
  public readonly name = "slack";
  readonly #web: WebClient;
  readonly #socket: SocketModeClient;
  readonly #api: SlackMessagingApi;
  readonly #allowedUserIds: ReadonlySet<string>;
  readonly #allowAllWorkspaceMembers: boolean;
  readonly #adminUserIds: ReadonlySet<string> | undefined;
  readonly #configUi: SlackConfigUi | undefined;
  readonly #membership = new Map<string, Readonly<{ allowed: boolean; checkedAt: number }>>();
  #botTeamId: string | undefined;
  readonly #botToken: string;
  readonly #attachmentDirectory: string;
  readonly #logger: Logger;
  readonly #pendingChoices = new Map<string, PendingChoice>();
  readonly #activeThreads = new Set<string>();
  readonly #recentEvents = new Set<string>();
  readonly #displayNames = new Map<string, string>();
  /**
   * Thread root → ts of the latest scheduled-run notification published there.
   * Slack replies in a thread reference only the root, so this restores the
   * notification message for reply-context lookups.
   */
  readonly #threadNotifications = new Map<string, string>();
  #handler: MessageHandler | undefined;
  #botUserId: string | undefined;

  public constructor(
    config: SlackConfig,
    attachmentDirectory: string,
    logger: Logger,
    configAccess?: CodexConfigAccess,
  ) {
    this.#botToken = config.botToken;
    this.#allowedUserIds = config.allowedUserIds;
    this.#allowAllWorkspaceMembers = config.allowAllWorkspaceMembers;
    this.#adminUserIds = config.adminUserIds;
    this.#attachmentDirectory = attachmentDirectory;
    this.#logger = logger;
    this.#web = new WebClient(config.botToken, { logLevel: LogLevel.ERROR });
    this.#socket = new SocketModeClient({ appToken: config.appToken, logLevel: LogLevel.ERROR });
    this.#api = webMessagingApi(this.#web);
    this.#configUi =
      configAccess === undefined
        ? undefined
        : new SlackConfigUi(this.#api, configAccess, logger.child({ component: "slack-config" }));
    this.#socket.on("message", (envelope: SocketEnvelope) => {
      void this.withAck(envelope, async () => {
        await this.handleMessageEvent(envelope.event as SlackMessageEvent);
      });
    });
    this.#socket.on("slash_commands", (envelope: SocketEnvelope) => {
      void this.withAck(envelope, async () => {
        await this.handleSlashCommand(envelope.body as SlackSlashCommandPayload);
      });
    });
    this.#socket.on("interactive", (envelope: SocketEnvelope) => {
      void this.withAck(envelope, async () => {
        await this.handleInteractive(envelope.body as SlackInteractivePayload);
      });
    });
  }

  public async start(handler: MessageHandler): Promise<void> {
    this.#handler = handler;
    const auth = await this.#web.auth.test();
    if (auth.user_id === undefined) {
      throw new Error("Slack auth.test did not identify the bot user");
    }
    this.#botUserId = auth.user_id;
    this.#botTeamId = auth.team_id;
    if (this.#allowAllWorkspaceMembers && this.#botTeamId === undefined) {
      throw new Error("Slack auth.test did not identify the workspace for member authorization");
    }
    this.#logger.info("Slack bot connected through Socket Mode", {
      botUserId: auth.user_id,
      team: auth.team ?? "unknown",
      authorization: this.#allowAllWorkspaceMembers ? "workspace-members" : "allowlist",
    });
    await this.#socket.start();
  }

  public isAuthorized(principal: ProviderReference): boolean | Promise<boolean> {
    if (principal.provider !== this.name || principal.resource !== "user") return false;
    return this.isUserAllowed(principal.id);
  }

  private isUserAllowed(userId: string): boolean | Promise<boolean> {
    if (!this.#allowAllWorkspaceMembers) return this.#allowedUserIds.has(userId);
    const cached = this.#membership.get(userId);
    if (cached !== undefined && Date.now() - cached.checkedAt < membershipCacheTtlMs) {
      return cached.allowed;
    }
    return this.checkWorkspaceMembership(userId);
  }

  private isAdmin(userId: string): boolean {
    return this.#adminUserIds === undefined || this.#adminUserIds.has(userId);
  }

  private async dispatch(
    inbound: InboundMessage,
    channelId: string,
    userId: string,
  ): Promise<void> {
    const handler = this.#handler;
    if (handler === undefined) return;
    // The bridge also parses bare "/command" text (e.g. from "@Telex /config"
    // mentions), so gate on that form as well, not only on slash commands.
    const command =
      inbound.command ??
      (inbound.attachments.length === 0 ? parseTextCommand(inbound.text) : undefined);
    if (command !== undefined && adminCommands.has(command.name) && !this.isAdmin(userId)) {
      await inbound.responder.sendText(
        "This command changes Telex for everyone using it and is limited to its admins.",
      );
      return;
    }
    if (command?.name === "config" && this.#configUi !== undefined) {
      if (!inbound.address.isPrivate) {
        await inbound.responder.sendText("Open Codex settings in a direct message with the bot.");
        return;
      }
      await this.#configUi.open(channelId);
      return;
    }
    await handler(inbound);
  }

  private async checkWorkspaceMembership(userId: string): Promise<boolean> {
    const botTeamId = this.#botTeamId;
    if (botTeamId === undefined) return false;
    let allowed = false;
    try {
      const response = await this.#web.users.info({ user: userId });
      allowed = isWorkspaceMember(response.user, botTeamId);
    } catch (error) {
      // Fail closed: an unknown user (e.g. a Slack Connect outsider the bot
      // token cannot see) is not a workspace member.
      this.#logger.debug("Slack membership lookup failed", {
        userId,
        error: errorMessage(error),
      });
      return false;
    }
    this.#membership.delete(userId);
    this.#membership.set(userId, { allowed, checkedAt: Date.now() });
    while (this.#membership.size > membershipCacheLimit) {
      const oldest = this.#membership.keys().next().value;
      if (oldest === undefined) break;
      this.#membership.delete(oldest);
    }
    return allowed;
  }

  public async stop(): Promise<void> {
    await this.#socket.disconnect().catch((error: unknown) => {
      this.#logger.debug("Slack socket disconnect failed", { error: errorMessage(error) });
    });
    for (const choice of this.#pendingChoices.values()) {
      clearTimeout(choice.timer);
      choice.result.resolve("decline");
    }
    this.#pendingChoices.clear();
  }

  public async publish(
    targetReference: ProviderReference,
    message: OutboundMessage,
  ): Promise<DeliveryReceipt> {
    const target = parseSlackDeliveryTarget(targetReference);
    // Keep threads that receive scheduled results routable without a mention.
    if (target.channelType !== "im" && target.threadTs !== undefined) {
      this.rememberActiveThread(`${target.channel}:${target.threadTs}`);
    }
    const published = await publishSlackMessage(this.#api, target, message, this.#logger);
    const primary = published[0];
    if (target.threadTs !== undefined && primary !== undefined) {
      this.#threadNotifications.set(`${target.channel}:${target.threadTs}`, primary.ts);
      trimInsertionOrderedMap(this.#threadNotifications, activeThreadLimit);
    }
    return {
      publishedMessages: published.map((entry) => slackMessageReference(entry.channel, entry.ts)),
    };
  }

  private async withAck(envelope: SocketEnvelope, work: () => Promise<void>): Promise<void> {
    // Slack retries unacknowledged envelopes after a few seconds, so always
    // acknowledge first and process afterwards.
    try {
      await envelope.ack();
    } catch (error) {
      this.#logger.debug("Slack envelope acknowledgement failed", {
        error: errorMessage(error),
      });
    }
    // A dropped connection can redeliver an envelope whose ack was lost;
    // slash commands and button clicks must not execute twice.
    const envelopeId = envelope.envelope_id;
    if (envelopeId !== undefined && this.wasRecentlyProcessed(`envelope:${envelopeId}`)) return;
    try {
      await work();
    } catch (error) {
      this.#logger.error("Slack event handling failed", error);
    }
  }

  private async handleMessageEvent(event: SlackMessageEvent): Promise<void> {
    const handler = this.#handler;
    const botUserId = this.#botUserId;
    if (handler === undefined || botUserId === undefined) return;
    if (typeof event.channel !== "string" || typeof event.ts !== "string") return;
    if (this.wasRecentlyProcessed(`message:${event.channel}:${event.ts}`)) return;

    const route = routeSlackMessage(event, botUserId, (threadRoot) =>
      this.#activeThreads.has(`${event.channel}:${threadRoot}`),
    );
    const sender = event.user;
    if (route === undefined || sender === undefined) return;
    if (!(await this.isUserAllowed(sender))) {
      this.#logger.warn("Ignored Slack message from unauthorized user", { userId: sender });
      return;
    }

    const normalized = normalizeSlackMessage(event, botUserId);
    const directory = join(this.#attachmentDirectory, crypto.randomUUID());
    const attachments: InboundAttachment[] = [];
    const failures: string[] = [];
    for (const [index, file] of normalized.files.entries()) {
      const description = describeSlackFile(file);
      try {
        const path = await downloadSlackFile(file, {
          botToken: this.#botToken,
          directory,
          index,
        });
        attachments.push({ kind: slackAttachmentKind(file), path, description });
      } catch (error) {
        this.#logger.warn("Could not download Slack attachment", {
          messageTs: event.ts,
          description,
          error: errorMessage(error).replaceAll(this.#botToken, "<redacted>"),
        });
        const reason =
          error instanceof SlackFileDownloadError
            ? error.userMessage
            : "Slack could not provide the file";
        failures.push(`[${description} was not attached: ${reason}.]`);
      }
    }

    const caption = [normalized.text, ...failures].filter((part) => part.length > 0).join("\n\n");
    // A bare file upload has no text; describe the attachments so the message
    // still reaches Codex instead of being dropped after the download.
    const text =
      caption.length > 0
        ? caption
        : attachments.map((attachment) => `[Attached: ${attachment.description}]`).join("\n");
    if (text.length === 0) return;
    if (event.channel_type !== "im") {
      this.rememberActiveThread(`${event.channel}:${route.conversationSuffix}`);
    }
    const responder = new SlackResponder(
      this.#api,
      event.channel,
      route.replyThreadTs,
      sender,
      this.requestChoice,
      this.#logger,
    );
    const inbound: InboundMessage = {
      id: event.ts,
      address: {
        channel: this.name,
        key: `slack:${event.channel}:${route.conversationSuffix}`,
        isPrivate: event.channel_type === "im",
        isGuest: false,
        deliveryTarget: slackDeliveryTarget(event.channel, event.channel_type, route.replyThreadTs),
      },
      reference: slackMessageReference(event.channel, event.ts),
      // Slack threads are flat: a reply references the thread root, not the
      // message being answered. When a scheduled-run notification lives in
      // this thread, point replyTo at it so its stored context resolves.
      ...(event.thread_ts === undefined || event.thread_ts === event.ts
        ? {}
        : {
            replyTo: slackMessageReference(
              event.channel,
              this.#threadNotifications.get(`${event.channel}:${event.thread_ts}`) ??
                event.thread_ts,
            ),
          }),
      sender: {
        id: sender,
        displayName: await this.displayName(sender),
      },
      text,
      attachments,
      responder,
    };
    try {
      await this.dispatch(inbound, event.channel, sender);
    } catch (error) {
      this.#logger.error("Slack message handler failed", error, { messageTs: inbound.id });
      await responder.sendText(`Bridge error: ${errorMessage(error)}`).catch(() => undefined);
    }
  }

  private async handleSlashCommand(payload: SlackSlashCommandPayload): Promise<void> {
    const handler = this.#handler;
    const userId = payload.user_id;
    const channelId = payload.channel_id;
    if (handler === undefined || userId === undefined || channelId === undefined) return;
    const respondEphemerally = async (text: string): Promise<void> => {
      await this.#api.postEphemeral({ channel: channelId, user: userId, text }).catch(async () => {
        await this.respondThroughWebhook(payload.response_url, text);
      });
    };
    if (!(await this.isUserAllowed(userId))) {
      this.#logger.warn("Ignored Slack slash command from unauthorized user", { userId });
      await this.respondThroughWebhook(
        payload.response_url,
        "You are not on this Telex instance's allow list.",
      );
      return;
    }

    const [first, ...restParts] = (payload.text ?? "").trim().split(/\s+/u);
    const name = (first ?? "").toLowerCase();
    if (name.length === 0 || name === "help" || !/^[a-z][a-z0-9_]*$/u.test(name)) {
      // The bridge's generic help lists bare /commands, which Slack reserves
      // for its own slash-command system; answer with Slack-shaped help.
      await respondEphemerally(`Telex commands:\n${slackSlashCommandHelp}`);
      return;
    }
    const isDirect = payload.channel_name === "directmessage";
    if (!isDirect && conversationScopedCommands.has(name)) {
      // In channels every thread is its own conversation, and a slash command
      // carries no thread information, so these commands cannot pick a target.
      await respondEphemerally(
        `In channels each thread is its own Codex conversation, so \`/telex ${name}\` cannot tell which one you mean. Mention the bot inside the thread instead (\`@Telex /${name}\`), or run it in a direct message with the bot.`,
      );
      return;
    }
    const command = { name, args: restParts.join(" ") };
    const responder = new SlackResponder(
      this.#api,
      channelId,
      undefined,
      userId,
      this.requestChoice,
      this.#logger,
      payload.response_url,
    );
    const inbound: InboundMessage = {
      id: `slash:${crypto.randomUUID()}`,
      address: {
        channel: this.name,
        key: `slack:${channelId}:main`,
        isPrivate: isDirect,
        isGuest: false,
      },
      sender: {
        id: userId,
        displayName: payload.user_name ?? (await this.displayName(userId)),
      },
      text: `/${command.name}${command.args.length === 0 ? "" : ` ${command.args}`}`,
      command,
      attachments: [],
      responder,
    };
    try {
      await this.dispatch(inbound, channelId, userId);
    } catch (error) {
      this.#logger.error("Slack slash command failed", error, { command: command.name });
      await respondEphemerally(`Bridge error: ${errorMessage(error)}`).catch(() => undefined);
    }
  }

  private async handleInteractive(payload: SlackInteractivePayload): Promise<void> {
    if (payload.type !== "block_actions") return;
    const action = payload.actions?.[0];
    const userId = payload.user?.id;
    const channelId = payload.channel?.id;
    const actionId = action?.action_id;
    if (action === undefined || actionId === undefined || userId === undefined) return;
    if (actionId === "telex_link") return;
    if (!(await this.isUserAllowed(userId))) {
      this.#logger.warn("Ignored Slack interaction from unauthorized user", { userId });
      return;
    }
    if (actionId.startsWith(slackConfigActionPrefix)) {
      const messageTs = payload.message?.ts;
      if (this.#configUi === undefined || channelId === undefined || messageTs === undefined) {
        return;
      }
      if (!this.isAdmin(userId)) {
        await this.#api
          .postEphemeral({
            channel: channelId,
            user: userId,
            text: "Codex settings are limited to Telex admins.",
          })
          .catch(() => undefined);
        return;
      }
      await this.#configUi.handleAction(action.value ?? "", channelId, messageTs);
      return;
    }
    if (actionId.startsWith("telex_choice")) {
      await this.handleChoiceAction(action, userId, channelId);
      return;
    }
    if (actionId.startsWith("telex_cmd")) {
      await this.handleCommandAction(action, payload, userId, channelId);
    }
  }

  private async handleChoiceAction(
    action: SlackBlockAction,
    userId: string,
    channelId: string | undefined,
  ): Promise<void> {
    const match = /^([0-9a-f]{16}):(\d+)$/u.exec(action.value ?? "");
    const token = match?.[1];
    const index = Number(match?.[2]);
    if (token === undefined) return;
    const pending = this.#pendingChoices.get(token);
    if (pending === undefined || pending.userId !== userId) {
      if (channelId !== undefined) {
        await this.#api
          .postEphemeral({ channel: channelId, user: userId, text: "This choice has expired." })
          .catch(() => undefined);
      }
      return;
    }
    const selected = pending.options[index];
    if (selected === undefined) return;
    clearTimeout(pending.timer);
    this.#pendingChoices.delete(token);
    pending.result.resolve(selected.id);
    await this.#api
      .updateMessage({
        channel: pending.channel,
        ts: pending.messageTs,
        text: `${pending.baseText}\n\n→ ${escapeSlackEntities(selected.label)}`,
        blocks: [],
      })
      .catch(() => undefined);
  }

  private async handleCommandAction(
    action: SlackBlockAction,
    payload: SlackInteractivePayload,
    userId: string,
    channelId: string | undefined,
  ): Promise<void> {
    const handler = this.#handler;
    const command = decodeSlackCommandValue(action.value ?? "");
    const messageTs = payload.message?.ts;
    if (handler === undefined || command === undefined || channelId === undefined) return;
    if (messageTs === undefined) return;
    // Conversation IDs starting with D are direct messages with the app.
    const isDirect = channelId.startsWith("D");
    const threadRoot = payload.message?.thread_ts ?? messageTs;
    const conversationSuffix = isDirect ? "main" : threadRoot;
    const replyThreadTs = isDirect ? undefined : threadRoot;
    if (!isDirect) this.rememberActiveThread(`${channelId}:${conversationSuffix}`);
    const responder = new SlackResponder(
      this.#api,
      channelId,
      replyThreadTs,
      userId,
      this.requestChoice,
      this.#logger,
    );
    const inbound: InboundMessage = {
      id: `action:${crypto.randomUUID()}`,
      address: {
        channel: this.name,
        key: `slack:${channelId}:${conversationSuffix}`,
        isPrivate: isDirect,
        isGuest: false,
        deliveryTarget: slackDeliveryTarget(channelId, isDirect ? "im" : "channel", replyThreadTs),
      },
      reference: slackMessageReference(channelId, messageTs),
      sender: {
        id: userId,
        displayName: await this.displayName(userId),
      },
      text: `/${command.name}${command.args.length === 0 ? "" : ` ${command.args}`}`,
      command,
      attachments: [],
      responder,
    };
    try {
      await this.dispatch(inbound, channelId, userId);
    } catch (error) {
      this.#logger.error("Slack command action failed", error, { command: command.name });
      await responder.sendText(`Bridge error: ${errorMessage(error)}`).catch(() => undefined);
    }
  }

  private readonly requestChoice: SlackChoiceRequester = async (
    channel,
    threadTs,
    userId,
    prompt,
    options,
  ): Promise<string> => {
    if (options.length === 0) return "decline";
    const token = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
    const baseText = choicePromptText(prompt, options);
    const blocks: readonly SlackBlock[] = [
      { type: "section", text: { type: "mrkdwn", text: baseText } },
      {
        type: "actions",
        elements: options.map((option, index) => ({
          type: "button" as const,
          text: { type: "plain_text" as const, text: option.label.slice(0, 75) },
          action_id: `telex_choice_${index}`,
          value: `${token}:${index}`,
        })),
      },
    ];
    const messageTs = await this.#api.postMessage({
      channel,
      text: baseText,
      blocks,
      ...(threadTs === undefined ? {} : { threadTs }),
    });
    const result = deferred<string>();
    const timer = setTimeout(
      () => {
        this.#pendingChoices.delete(token);
        result.resolve("decline");
      },
      5 * 60 * 1_000,
    );
    timer.unref();
    this.#pendingChoices.set(token, {
      userId,
      options,
      result,
      timer,
      channel,
      messageTs,
      baseText,
    });
    return await result.promise;
  };

  private async displayName(userId: string): Promise<string> {
    const cached = this.#displayNames.get(userId);
    if (cached !== undefined) return cached;
    let name = userId;
    try {
      const response = await this.#web.users.info({ user: userId });
      const profile = response.user?.profile;
      name =
        firstNonEmpty(profile?.display_name, profile?.real_name, response.user?.name) ?? userId;
    } catch (error) {
      this.#logger.debug("Slack user lookup failed", { userId, error: errorMessage(error) });
    }
    if (this.#displayNames.size >= displayNameCacheLimit) this.#displayNames.clear();
    this.#displayNames.set(userId, name);
    return name;
  }

  private async respondThroughWebhook(url: string | undefined, text: string): Promise<void> {
    if (url === undefined) return;
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response_type: "ephemeral", text }),
    }).catch((error: unknown) => {
      this.#logger.debug("Slack response webhook failed", { error: errorMessage(error) });
    });
  }

  private wasRecentlyProcessed(key: string): boolean {
    if (this.#recentEvents.has(key)) return true;
    this.#recentEvents.add(key);
    trimInsertionOrdered(this.#recentEvents, recentEventLimit);
    return false;
  }

  private rememberActiveThread(key: string): void {
    this.#activeThreads.delete(key);
    this.#activeThreads.add(key);
    trimInsertionOrdered(this.#activeThreads, activeThreadLimit);
  }
}

function webMessagingApi(web: WebClient): SlackMessagingApi {
  return {
    async postMessage(options) {
      const result = await web.chat.postMessage({
        channel: options.channel,
        text: options.text,
        unfurl_links: false,
        unfurl_media: false,
        ...(options.threadTs === undefined ? {} : { thread_ts: options.threadTs }),
        ...(options.blocks === undefined ? {} : { blocks: [...options.blocks] }),
      });
      if (result.ts === undefined) {
        throw new Error("Slack did not return a timestamp for the posted message");
      }
      return result.ts;
    },
    async updateMessage(options) {
      await web.chat.update({
        channel: options.channel,
        ts: options.ts,
        text: options.text,
        blocks: options.blocks === undefined ? [] : [...options.blocks],
      });
    },
    async uploadFile(options) {
      const contents = { file: options.path, filename: options.filename };
      if (options.threadTs === undefined) {
        await web.filesUploadV2({ ...contents, channel_id: options.channel });
      } else {
        await web.filesUploadV2({
          ...contents,
          channel_id: options.channel,
          thread_ts: options.threadTs,
        });
      }
    },
    async postEphemeral(options) {
      await web.chat.postEphemeral({
        channel: options.channel,
        user: options.user,
        text: options.text,
      });
    },
  };
}

function firstNonEmpty(...values: readonly (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (value !== undefined && value.trim().length > 0) return value;
  }
  return undefined;
}

function trimInsertionOrdered(set: Set<string>, limit: number): void {
  while (set.size > limit) {
    const oldest = set.values().next().value;
    if (oldest === undefined) return;
    set.delete(oldest);
  }
}

function trimInsertionOrderedMap(map: Map<string, string>, limit: number): void {
  while (map.size > limit) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}
