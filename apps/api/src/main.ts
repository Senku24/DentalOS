import "reflect-metadata";
import { initTracing } from "@dentalos/config";

// Tracing must start before the app (and Prisma client) are created so everything is instrumented.
initTracing({ serviceName: process.env.SERVICE_NAME ?? "dentalos-api", prisma: true });

async function bootstrap() {
  const { NestFactory } = await import("@nestjs/core");
  const { AppModule } = await import("./app.module");
  const { PinoNestLogger, logger, requestLogger } = await import("./observability/logger");
  const { tracingMiddleware } = await import("./observability/tracing");

  const app = await NestFactory.create(AppModule, { logger: new PinoNestLogger() });
  app.use(tracingMiddleware);
  app.use(requestLogger);
  app.enableShutdownHooks(); // graceful shutdown on SIGTERM (PRD 6.2)
  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port, "0.0.0.0");
  logger.info({ port }, "api listening");
}
bootstrap();
