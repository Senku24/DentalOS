import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { PinoNestLogger, logger, requestLogger } from "./observability/logger";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: new PinoNestLogger() });
  app.use(requestLogger);
  app.enableShutdownHooks(); // graceful shutdown on SIGTERM (PRD 6.2)
  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port, "0.0.0.0");
  logger.info({ port }, "api listening");
}
bootstrap();
