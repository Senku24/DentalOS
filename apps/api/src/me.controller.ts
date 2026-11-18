import { Controller, Get, Req } from "@nestjs/common";
import type { Principal } from "./auth/roles";

@Controller("me")
export class MeController {
  @Get() me(@Req() req: { principal: Principal }) {
    return req.principal;
  }
}
