import { Controller, Req, Sse } from "@nestjs/common";
import { type Observable, filter, interval, map, merge, takeUntil } from "rxjs";
import type { Principal } from "../auth/roles";
import { EventBus } from "./event-bus";

interface SseMessage {
  type: string;
  data: unknown;
}

/**
 * Server-Sent Events for live queue/calendar/dashboard updates.
 * Auth is the normal Bearer header, so clients use fetch()-based SSE (EventSource cannot set headers).
 */
@Controller("events")
export class EventsController {
  constructor(private readonly bus: EventBus) {}

  @Sse()
  stream(@Req() req: { principal: Principal }): Observable<SseMessage> {
    const p = req.principal;
    const events = this.bus.stream.pipe(
      // Tenant is a hard boundary; branch applies unless the principal is org-wide.
      filter((e) => e.tenantId === p.tenantId),
      filter((e) => p.orgWide || e.branchId === undefined || p.branchScope.includes(e.branchId)),
      map((e) => ({ type: e.type, data: { ...e.data, branchId: e.branchId } })),
    );
    // Heartbeat keeps proxies/ALB from idling the connection out.
    const heartbeat = interval(15_000).pipe(map(() => ({ type: "ping", data: {} })));
    return merge(events, heartbeat).pipe(takeUntil(this.bus.closing));
  }
}
