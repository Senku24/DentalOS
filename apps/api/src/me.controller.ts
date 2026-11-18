import { Controller, Get, Req } from "@nestjs/common";
import { Can } from "./auth/auth.guard";
import type { Principal } from "./auth/roles";

@Controller("me")
export class MeController {
  @Get() me(@Req() req: { principal: Principal }) {
    return req.principal;
  }

  /** Smoke route proving @Can wiring; replaced by real admin endpoints in M1. */
  @Can("staff:manage") @Get("admin") admin() {
    return { ok: true };
  }
}
