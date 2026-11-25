import type { HandlerRegistrar } from "../index";

/**
 * M4 AI handlers. Owner: I1 (apps/worker/src/handlers/ai/**). Queues: `AI_QUEUES` in @dentalos/validation
 * (`daily-summary`: narrative onto an existing snapshot — the model sees numbers only; `draft-expiry-sweep`: DRAFT past
 * `expiresAt` -> EXPIRED). Placeholder: registers nothing yet.
 */
export const registerAiHandlers: HandlerRegistrar = async () => {};
