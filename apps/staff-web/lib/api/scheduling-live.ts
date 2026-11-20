import { SCHEDULING_EVENT_TYPES } from "@dentalos/validation";
import { buildUrl } from "./routes";
import { schedulingClient, schedulingRoutes } from "./scheduling";

/**
 * Live scheduling updates from `GET /events` (apps/api/src/realtime/events.controller.ts).
 * The server filters by tenant and the caller's branch scope; it takes no query parameters, so the
 * branch filter is applied here using `data.branchId`. Auth is the Bearer header / session cookie,
 * which EventSource cannot send, so the stream is read with fetch(). When the stream fails (proxy,
 * offline, older API) the caller falls back to polling and the stream is retried with backoff.
 */

export interface SseMessage {
  event: string;
  data: string;
  id?: string;
}

/**
 * Incremental text/event-stream parser. Feed decoded chunks; complete messages are returned and the
 * unfinished tail is kept in `rest`. Handles CRLF, multi-line data and comment lines (": ping").
 */
export function parseSseChunk(buffer: string): { messages: SseMessage[]; rest: string } {
  const normalized = buffer.replace(/\r\n?/g, "\n");
  const blocks = normalized.split("\n\n");
  const rest = blocks.pop() ?? "";
  const messages: SseMessage[] = [];
  for (const block of blocks) {
    let event = "message";
    let id: string | undefined;
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      const i = line.indexOf(":");
      const field = i < 0 ? line : line.slice(0, i);
      let value = i < 0 ? "" : line.slice(i + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
      else if (field === "id") id = value;
    }
    if (data.length === 0 && event === "message") continue;
    messages.push({ event, data: data.join("\n"), ...(id !== undefined ? { id } : {}) });
  }
  return { messages, rest };
}

export interface SchedulingChange {
  type: (typeof SCHEDULING_EVENT_TYPES)[number];
  appointmentId?: string;
  branchId?: string;
  toStatus?: string;
}

/** Keeps scheduling events for `branchId` (events without a branch are kept: tenant-wide). */
export function toSchedulingChange(msg: SseMessage, branchId?: string): SchedulingChange | null {
  if (!(SCHEDULING_EVENT_TYPES as readonly string[]).includes(msg.event)) return null;
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(msg.data) as Record<string, unknown>;
  } catch {
    return null;
  }
  const evBranch = typeof data.branchId === "string" ? data.branchId : undefined;
  if (branchId && evBranch && evBranch !== branchId) return null;
  return {
    type: msg.event as SchedulingChange["type"],
    appointmentId: typeof data.appointmentId === "string" ? data.appointmentId : undefined,
    branchId: evBranch,
    toStatus: typeof data.toStatus === "string" ? data.toStatus : undefined,
  };
}

export type LiveStatus = "connecting" | "live" | "polling";

export interface LiveOptions {
  branchId?: string;
  onChange: (c: SchedulingChange | { type: "poll" }) => void;
  onStatus?: (s: LiveStatus) => void;
  /** Polling interval while the stream is down. */
  pollMs?: number;
}

/** Starts the live subscription; returns a stop function. Browser only. */
export function subscribeScheduling(opts: LiveOptions): () => void {
  const pollMs = opts.pollMs ?? 20_000;
  let stopped = false;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let unsubscribeMock: (() => void) | undefined;
  let attempt = 0;

  const setStatus = (s: LiveStatus) => !stopped && opts.onStatus?.(s);
  const startPolling = () => {
    setStatus("polling");
    if (pollTimer) return;
    pollTimer = setInterval(() => !stopped && opts.onChange({ type: "poll" }), pollMs);
  };
  const stopPolling = () => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = undefined;
  };

  const cfg = schedulingClient.config;
  if (cfg.mock) {
    // Mock mode: the in-memory fake publishes events on every write.
    setStatus("connecting");
    void import("./scheduling-mock").then((m) => {
      if (stopped) return;
      unsubscribeMock = m.subscribeMockEvents((e) => {
        const change = toSchedulingChange(
          { event: e.type, data: JSON.stringify(e.data) },
          opts.branchId,
        );
        if (change) opts.onChange(change);
      });
      setStatus("live");
    });
    return () => {
      stopped = true;
      unsubscribeMock?.();
    };
  }

  const connect = async () => {
    if (stopped) return;
    setStatus(attempt === 0 ? "connecting" : "polling");
    controller = new AbortController();
    try {
      const headers: Record<string, string> = { Accept: "text/event-stream" };
      if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
      const f = cfg.fetch ?? globalThis.fetch;
      const res = await f(buildUrl(cfg.baseUrl, schedulingRoutes.events()), {
        headers,
        credentials: "include",
        signal: controller.signal,
        cache: "no-store",
      });
      if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
      attempt = 0;
      stopPolling();
      setStatus("live");
      // Anything missed while connecting is picked up by one refresh.
      opts.onChange({ type: "poll" });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const { messages, rest } = parseSseChunk(buf);
        buf = rest;
        for (const m of messages) {
          const change = toSchedulingChange(m, opts.branchId);
          if (change) opts.onChange(change);
        }
      }
      throw new Error("SSE closed");
    } catch {
      if (stopped) return;
      startPolling();
      attempt += 1;
      const delay = Math.min(60_000, 2_000 * 2 ** Math.min(attempt, 5));
      retryTimer = setTimeout(() => void connect(), delay);
    }
  };
  void connect();

  return () => {
    stopped = true;
    controller?.abort();
    stopPolling();
    if (retryTimer) clearTimeout(retryTimer);
  };
}
