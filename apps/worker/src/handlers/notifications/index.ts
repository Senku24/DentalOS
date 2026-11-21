import type { HandlerRegistrar } from "../index";
import { registerAppointmentHandlers } from "./appointments";
import { registerBillingHandlers } from "./billing";
import { selectProvider } from "./provider";
import { registerRecallHandler } from "./recall";
import { registerSendHandler } from "./send";
import { registerScanTicks } from "./tick";

/**
 * M3 notification handlers (ADR 0004 §9.5): send (provider via NOTIFY_PROVIDER), appointment reminder scan + reminder /
 * change notices, invoice / payment / refund receipts, plan-consent request, recall sweep, and the cron fan-out.
 * Queue names: `NOTIFICATION_QUEUES` in @dentalos/validation (+ `notifications.reminder-scan` / `notifications.scan-tick`).
 */
export const registerNotificationHandlers: HandlerRegistrar = async (ctx) => {
  const provider = selectProvider();
  await registerSendHandler(ctx, provider);
  await registerAppointmentHandlers(ctx);
  await registerBillingHandlers(ctx);
  await registerRecallHandler(ctx);
  await registerScanTicks(ctx);
};
