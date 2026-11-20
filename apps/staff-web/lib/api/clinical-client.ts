import {
  type ApiClient,
  type Method,
  type MockHandler,
  type RequestOptions,
  apiClient,
  createClient,
} from "./client";
import { withClinicalMessage } from "./clinical-errors";

/**
 * Client for the M2 clinical, plan and consent endpoints. Same transport and configuration as the
 * shared `apiClient`; differences:
 *  - errors are re-labelled with clinical copy (`clinical-errors.ts`);
 *  - in mock mode, requests go to `clinical-mock.ts`, which serves M2 routes from its own fixtures
 *    and falls back to the shared M1 mock for everything else (patients, documents, catalogue).
 */
const lazyMock: MockHandler = async (method, path, query, body) =>
  (await import("./clinical-mock")).clinicalMockHandler(method, path, query, body);

export function withClinicalErrors(c: ApiClient): ApiClient {
  return {
    config: c.config,
    request<T>(method: Method, path: string, opts?: RequestOptions<T>) {
      return c.request<T>(method, path, opts).catch((e: unknown) => {
        if ((e as { name?: string })?.name === "AbortError") throw e;
        throw withClinicalMessage(e);
      });
    },
  };
}

export const clinicalClient: ApiClient = withClinicalErrors(
  createClient({ ...apiClient.config, mockHandler: lazyMock }),
);

/**
 * Follows `nextCursor` until the list ends (or `maxPages` pages), for pickers that must offer the
 * whole list (e.g. a patient's documents; GET /documents defaults to 25 per page).
 */
export async function collectPages<T>(
  fetchPage: (cursor: string | undefined) => Promise<{ items: T[]; nextCursor: string | null }>,
  maxPages = 20,
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const page = await fetchPage(cursor);
    out.push(...page.items);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return out;
}
