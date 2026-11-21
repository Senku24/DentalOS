import { createHmac, timingSafeEqual } from "node:crypto";
import {
  type GatewayProvider,
  type GatewayWebhookPayload,
  gatewayWebhookPayload,
  isWebhookTimestampFresh,
  parseWebhookSignatureHeader,
} from "@dentalos/validation";

/**
 * Pluggable payment gateway (ADR 0004 §5). `MANUAL` has no gateway (staff record payments). `STUB` returns a fake
 * hosted-checkout URL and lets a developer fire the signed webhook locally. A real gateway is one more implementation
 * (and `Payment.gateway` is text: no migration). No network I/O happens inside a database transaction: the service
 * calls `createCheckout` / `refund` before / after its transactions.
 */
export interface PaymentGateway {
  readonly id: Exclude<GatewayProvider, "MANUAL">;
  createCheckout(input: {
    amountPaise: number;
    patientId: string;
    reference: string;
    idempotencyKey: string;
    returnUrl?: string;
  }): Promise<{ gatewayRef: string; checkoutUrl: string; expiresAt: Date }>;
  /** Hosted-checkout URL of an existing payment (idempotent replays). */
  checkoutUrlFor(gatewayRef: string): string;
  /** Parses and validates a webhook body (the signature was already verified over the raw bytes). */
  parseWebhook(rawBody: Buffer): GatewayWebhookPayload;
  /** Asks the gateway to return money; the refund is confirmed later by a `refund.processed` webhook. */
  refund(input: {
    gatewayRef: string;
    amountPaise: number;
    idempotencyKey: string;
  }): Promise<{ gatewayRef: string }>;
}

export const CHECKOUT_TTL_MS = 30 * 60_000;

export class StubGateway implements PaymentGateway {
  readonly id = "STUB" as const;

  async createCheckout(input: { idempotencyKey: string }) {
    // Deterministic per idempotency key: a retried checkout cannot mint a second gateway reference.
    const gatewayRef = `stub_${Buffer.from(input.idempotencyKey).toString("base64url").slice(0, 40)}`;
    return {
      gatewayRef,
      checkoutUrl: this.checkoutUrlFor(gatewayRef),
      expiresAt: new Date(Date.now() + CHECKOUT_TTL_MS),
    };
  }

  checkoutUrlFor(gatewayRef: string) {
    return `https://stub-gateway.invalid/checkout/${encodeURIComponent(gatewayRef)}`;
  }

  parseWebhook(rawBody: Buffer): GatewayWebhookPayload {
    let json: unknown;
    try {
      json = JSON.parse(rawBody.toString("utf8"));
    } catch {
      throw new SyntaxError("body is not JSON");
    }
    return gatewayWebhookPayload.parse(json);
  }

  async refund(input: { gatewayRef: string }) {
    return { gatewayRef: input.gatewayRef };
  }
}

/**
 * `X-DentalOS-Signature: t=<unix s>,v1=<hex HMAC-SHA256(secret, "t.rawBody")>` — constant-time compare, several `v1`
 * for secret rotation, signed timestamp within the tolerance (replay window). Fails closed without secrets.
 */
export function verifyWebhookSignature(
  rawBody: Buffer | undefined,
  header: string | undefined,
  secrets: string[],
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  if (!rawBody || secrets.length === 0) return false;
  const parsed = parseWebhookSignatureHeader(header);
  if (!parsed || !isWebhookTimestampFresh(parsed.timestamp, nowSeconds)) return false;
  let ok = false;
  for (const secret of secrets) {
    const expected = createHmac("sha256", secret)
      .update(`${parsed.timestamp}.`)
      .update(rawBody)
      .digest();
    for (const sig of parsed.signatures) {
      const got = Buffer.from(sig, "hex");
      if (got.length === expected.length && timingSafeEqual(got, expected)) ok = true;
    }
  }
  return ok;
}
