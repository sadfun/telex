export interface ConversationAddress {
  readonly channel: string;
  readonly key: string;
  readonly isPrivate: boolean;
  readonly isGuest: boolean;
}

export interface SenderIdentity {
  readonly id: string;
  readonly displayName: string;
}

export interface ActionButton {
  readonly label: string;
  readonly kind: "url" | "webApp";
  readonly url: string;
}

export interface SendOptions {
  readonly button?: ActionButton;
}

export interface ChoiceOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

export interface ProgressAction {
  readonly label: string;
}

export interface ProgressPlanStep {
  readonly step: string;
  readonly status: "pending" | "inProgress" | "completed";
}

export interface ProgressSnapshot {
  readonly summary?: string;
  readonly message?: string;
  readonly actions: readonly ProgressAction[];
  readonly plan: readonly ProgressPlanStep[];
}

export interface OutboundStream {
  start(): Promise<void>;
  setProgress(progress: ProgressSnapshot): void;
  appendFinal(delta: string): void;
  complete(text: string): Promise<void>;
  fail(message: string): Promise<void>;
}

export interface MessageResponder {
  createStream(): OutboundStream;
  sendText(text: string, options?: SendOptions): Promise<void>;
  askChoice(prompt: string, options: readonly ChoiceOption[]): Promise<string>;
}

export interface InboundMessage {
  readonly id: string;
  readonly address: ConversationAddress;
  readonly sender: SenderIdentity;
  readonly text: string;
  readonly responder: MessageResponder;
}

export type MessageHandler = (message: InboundMessage) => Promise<void>;

export interface MessagingChannel {
  readonly name: string;
  start(handler: MessageHandler): Promise<void>;
  stop(): Promise<void>;
}
