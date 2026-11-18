import type { z } from "@dentalos/validation";
import { ApiError, mapHttpError, networkError } from "./errors";
import { type QueryValue, buildUrl } from "./routes";

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RequestOptions<T> {
  query?: Record<string, QueryValue>;
  body?: unknown;
  /** Response schema. Parsed in development to catch contract drift; never blocks the UI. */
  schema?: z.ZodType<T>;
  signal?: AbortSignal;
}

export type MockHandler = (
  method: Method,
  path: string,
  query: Record<string, string>,
  body: unknown,
) => Promise<unknown>;

export interface ClientConfig {
  /** e.g. "http://localhost:4000". Empty = same origin. */
  baseUrl: string;
  /** DEV ONLY: bearer token passed through as-is (NEXT_PUBLIC_DEV_TOKEN). Real sessions come later. */
  token?: string;
  /** Serve every call from in-memory fixtures (no network). */
  mock: boolean;
  fetch?: typeof fetch;
  /** Overrides the fixture handler (tests). */
  mockHandler?: MockHandler;
  /** Warn on response schema mismatch. */
  checkResponses?: boolean;
}

export interface ApiClient {
  readonly config: ClientConfig;
  request<T>(method: Method, path: string, opts?: RequestOptions<T>): Promise<T>;
}

const stringQuery = (q: Record<string, QueryValue> | undefined) => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(q ?? {})) {
    if (v === undefined || v === null || v === "") continue;
    out[k] = String(v);
  }
  return out;
};

export function createClient(config: ClientConfig): ApiClient {
  async function request<T>(method: Method, path: string, opts: RequestOptions<T> = {}) {
    let data: unknown;
    if (config.mock) {
      const handler = config.mockHandler ?? (await import("./mock")).mockHandler;
      data = await handler(method, path, stringQuery(opts.query), opts.body);
    } else {
      const f = config.fetch ?? globalThis.fetch;
      const headers: Record<string, string> = { Accept: "application/json" };
      if (opts.body !== undefined) headers["Content-Type"] = "application/json";
      if (config.token) headers.Authorization = `Bearer ${config.token}`;
      let res: Response;
      try {
        res = await f(buildUrl(config.baseUrl, path, opts.query), {
          method,
          headers,
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          signal: opts.signal,
          credentials: "include",
        });
      } catch (e) {
        if ((e as { name?: string })?.name === "AbortError") throw e;
        throw networkError();
      }
      const text = res.status === 204 ? "" : await res.text();
      let parsed: unknown = undefined;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }
      if (!res.ok) throw mapHttpError(res.status, parsed);
      data = parsed;
    }
    if (opts.schema && config.checkResponses) {
      const r = opts.schema.safeParse(data);
      if (!r.success) {
        // Contract drift is a developer concern: surface it loudly in dev, keep the screen working.
        console.warn(`[api] ${method} ${path} response did not match schema`, r.error.issues);
      }
    }
    return data as T;
  }
  return { config, request };
}

const env = {
  url: process.env.NEXT_PUBLIC_API_URL ?? "",
  mock: process.env.NEXT_PUBLIC_API_MOCK,
  token: process.env.NEXT_PUBLIC_DEV_TOKEN,
  prod: process.env.NODE_ENV === "production",
};

/**
 * Mock mode: NEXT_PUBLIC_API_MOCK=1 forces fixtures, =0 forces the network. Unset → fixtures in
 * development when no NEXT_PUBLIC_API_URL is configured, so every screen renders without an API.
 */
export const MOCK_MODE = env.mock === "1" || (env.mock !== "0" && !env.url && !env.prod);

export const apiClient: ApiClient = createClient({
  baseUrl: env.url,
  token: env.token,
  mock: MOCK_MODE,
  checkResponses: !env.prod,
});

export { ApiError };
