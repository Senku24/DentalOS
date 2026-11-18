import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { Subject } from "rxjs";

export interface DomainEvent {
  tenantId: string;
  /** Branch the event belongs to; subscribers restricted to other branches never see it. */
  branchId?: string;
  type: string;
  /** Ids/status only — no clinical or PII content over realtime channels. */
  data: Record<string, unknown>;
}

/**
 * In-process fan-out. Production: bridge via Postgres LISTEN/NOTIFY so several API instances
 * deliver the same events (decision in the plan). Subscribers MUST filter by tenant/branch.
 */
@Injectable()
export class EventBus implements OnModuleDestroy {
  readonly stream = new Subject<DomainEvent>();
  /** Emits once on shutdown so every open SSE stream (incl. heartbeats) terminates. */
  readonly closing = new Subject<void>();
  publish(e: DomainEvent) {
    this.stream.next(e);
  }
  /** Ends open SSE streams so graceful shutdown is not blocked by long-lived connections. */
  onModuleDestroy() {
    this.closing.next();
    this.closing.complete();
    this.stream.complete();
  }
}
