import { withBillingMessage } from "./billing-errors";
import {
  type ApiClient,
  type Method,
  type MockHandler,
  type RequestOptions,
  apiClient,
  createClient,
} from "./client";

/**
 * Client for the M3 billing endpoints. Same transport as the shared `apiClient`; errors are re-labelled with
 * billing copy (`billing-errors.ts`) and, in mock mode, requests go to `billing-mock.ts`, which serves the
 * billing routes from its own fixtures and falls back to the clinical / M1 mocks for everything else
 * (patients, plans, catalogue, branches).
 */
const lazyMock: MockHandler = async (method, path, query, body) =>
  (await import("./billing-mock")).billingMockHandler(method, path, query, body);

export function withBillingErrors(c: ApiClient): ApiClient {
  return {
    config: c.config,
    request<T>(method: Method, path: string, opts?: RequestOptions<T>) {
      return c.request<T>(method, path, opts).catch((e: unknown) => {
        if ((e as { name?: string })?.name === "AbortError") throw e;
        throw withBillingMessage(e);
      });
    },
  };
}

export const billingClient: ApiClient = withBillingErrors(
  createClient({ ...apiClient.config, mockHandler: lazyMock }),
);
