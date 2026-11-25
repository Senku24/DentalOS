import { SetMetadata } from "@nestjs/common";

// Leaf module (no imports from the guards): `AuthGuard` and `PortalGuard` both read these keys.

/** Metadata keys (read by `AuthGuard`, which skips portal routes, and by `PortalGuard`). */
export const PORTAL_KEY = "portalAuth";
export const PORTAL_STEP_UP_KEY = "portalStepUp";

/**
 * Marks a route (or controller) as PATIENT-PORTAL authenticated: the staff `AuthGuard` skips it and `PortalGuard`
 * authenticates the portal access token and the live session instead. Staff tokens are refused here and portal tokens
 * are refused everywhere else. Do not combine with `@Can` / `@StepUp` (they are staff concepts and are ignored).
 * Unauthenticated portal routes (request / verify OTP, refresh) use `@Public()`, not this.
 */
export const PortalAuth = () => SetMetadata(PORTAL_KEY, true);

/**
 * Requires a fresh step-up OTP in the session (`PortalSession.stepUpAt`), else 403 `{ error: "step_up_required" }`.
 * The window is the tenant's `portal.stepUpWindowMinutes` (default 10, at most 15: the DB enforces 15 on signatures).
 * Use on consent signing and plan decisions.
 */
export const PortalStepUp = () => SetMetadata(PORTAL_STEP_UP_KEY, true);
