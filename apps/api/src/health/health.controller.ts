import { PrismaClient } from "@dentalos/db";
import { Controller, Get, Inject } from "@nestjs/common";
import { PRISMA, Public } from "../auth/auth.guard";

@Controller("health")
export class HealthController {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}
  @Public() @Get("live") live() {
    return { status: "ok" };
  }
  @Public() @Get("ready") async ready() {
    await this.prisma.$queryRaw`SELECT 1`;
    return { status: "ready" };
  }
}
