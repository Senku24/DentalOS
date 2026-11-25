import type { HandlerRegistrar } from "../index";

/**
 * M4 portal handlers. Owner: P1 (apps/worker/src/handlers/portal/**). Queues: `PORTAL_QUEUES` in @dentalos/validation
 * (`scrub-otp-message`: blank `variables.code` of a FINAL PORTAL_OTP outbox row — migration 0009 allows exactly that change;
 * `retention-sweep`: delete expired OTPs / sessions past retention as the schema owner). Placeholder: registers nothing yet.
 */
export const registerPortalHandlers: HandlerRegistrar = async () => {};
