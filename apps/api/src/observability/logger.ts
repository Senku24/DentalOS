import { randomUUID } from "node:crypto";
import { currentTraceIds } from "@dentalos/config";
import type { LoggerService } from "@nestjs/common";
import pino from "pino";

/** Structured JSON logs to stdout (shipped to in-region CloudWatch). Never log tokens or PII. */
export const makeLogger = (dest?: pino.DestinationStream) =>
  pino(
    {
      level: process.env.LOG_LEVEL ?? "info",
      base: { service: process.env.SERVICE_NAME ?? "api" },
      // Correlate every log line with the active trace.
      mixin: () => currentTraceIds(),
      redact: {
        paths: ["req.headers.authorization", "req.headers.cookie", "*.token", "*.password"],
        censor: "[redacted]",
      },
    },
    dest,
  );
export const logger = makeLogger();

/** Routes NestJS framework logging through pino. */
export class PinoNestLogger implements LoggerService {
  constructor(private readonly l = logger) {}
  log(message: unknown, ctx?: string) {
    this.l.info({ ctx }, String(message));
  }
  error(message: unknown, trace?: string, ctx?: string) {
    this.l.error({ ctx, trace }, String(message));
  }
  warn(message: unknown, ctx?: string) {
    this.l.warn({ ctx }, String(message));
  }
  debug(message: unknown, ctx?: string) {
    this.l.debug({ ctx }, String(message));
  }
  verbose(message: unknown, ctx?: string) {
    this.l.trace({ ctx }, String(message));
  }
}

interface Req {
  method: string;
  originalUrl?: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  principal?: { tenantId: string; userId: string };
}
interface Res {
  statusCode: number;
  setHeader(k: string, v: string): void;
  on(ev: "finish", cb: () => void): void;
}

/** Request id + one access-log line per request. Path only (no query string: it may carry identifiers). */
export function requestLogger(req: Req, res: Res, next: () => void) {
  const incoming = req.headers["x-request-id"];
  const id = typeof incoming === "string" && incoming.length <= 64 ? incoming : randomUUID();
  res.setHeader("x-request-id", id);
  const start = performance.now();
  res.on("finish", () => {
    logger.info(
      {
        reqId: id,
        method: req.method,
        path: (req.originalUrl ?? req.url).split("?")[0],
        status: res.statusCode,
        ms: Math.round(performance.now() - start),
        tenantId: req.principal?.tenantId,
        actorId: req.principal?.userId,
      },
      "request",
    );
  });
  next();
}
