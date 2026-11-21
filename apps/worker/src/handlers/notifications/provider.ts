import { createHash } from "node:crypto";
import { type NotificationChannel, maskAddress } from "@dentalos/validation";
import { log } from "./work";

/**
 * Message provider interface (ADR 0004 §9.2). `send` throws on failure; a `ProviderError.code` is stored as the
 * outbox `lastError` (a code, never message text or addresses: the outbox error column must stay free of personal data).
 * A real provider (WhatsApp / SMS / e-mail gateway) is one more implementation selected by NOTIFY_PROVIDER.
 */
export interface ProviderSendRequest {
  channel: NotificationChannel;
  to: string;
  subject?: string | null;
  body: string;
  providerTemplateRef?: string | null;
  /** The outbox idempotency key: providers use it to de-duplicate re-sends. */
  idempotencyKey: string;
}
export interface NotificationProvider {
  /** Stored in `NotificationOutbox.provider` (upper-case, one of NOTIFICATION_PROVIDERS). */
  readonly name: string;
  send(req: ProviderSendRequest): Promise<{ providerMessageId: string }>;
}

export class ProviderError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ProviderError";
  }
}

const truthy = (v: string | undefined) =>
  !!v && !["0", "false", "no", "off"].includes(v.toLowerCase());

/**
 * Dev sender: logs a masked line (never the body), returns a deterministic fake provider message id (the same
 * idempotency key yields the same id, like a real provider's de-duplication). Dev knob `NOTIFY_FAIL=1` makes every
 * send fail with `forced_failure` so retry / backoff / FAILED can be exercised (read at send time).
 */
export class ConsoleProvider implements NotificationProvider {
  readonly name = "CONSOLE";
  async send(req: ProviderSendRequest) {
    if (truthy(process.env.NOTIFY_FAIL)) throw new ProviderError("forced_failure");
    const providerMessageId = `console-${createHash("sha256").update(req.idempotencyKey).digest("hex").slice(0, 24)}`;
    log("info", "notification sent (console provider)", {
      channel: req.channel,
      to: maskAddress(req.to),
      bodyChars: req.body.length,
      providerMessageId,
    });
    return { providerMessageId };
  }
}

/** NOTIFY_PROVIDER (default "console"); an unknown name fails the worker at start-up, not at the first send. */
export function selectProvider(
  name = process.env.NOTIFY_PROVIDER ?? "console",
): NotificationProvider {
  switch (name.trim().toLowerCase()) {
    case "console":
      return new ConsoleProvider();
    default:
      throw new Error(`NOTIFY_PROVIDER "${name}" is not supported (available: console)`);
  }
}
