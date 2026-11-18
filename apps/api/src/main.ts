import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: ["log", "warn", "error"] });
  app.enableShutdownHooks(); // graceful shutdown (PRD 6.2)
  await app.listen(Number(process.env.PORT ?? 3001));
}
bootstrap();
