import {
  type ApiClient,
  type Method,
  type MockHandler,
  type RequestOptions,
  apiClient,
  createClient,
} from "./client";
import { withNotificationMessage } from "./notifications-errors";

/**
 * Client for the M3 notification endpoints: same transport as the shared `apiClient`, errors
 * re-labelled with notification copy, and in mock mode requests go to `notifications-mock.ts`
 * (which falls back to the clinical / M1 mocks for patients and the catalogue).
 */
const lazyMock: MockHandler = async (method, path, query, body) =>
  (await import("./notifications-mock")).notificationsMockHandler(method, path, query, body);

export function withNotificationErrors(c: ApiClient): ApiClient {
  return {
    config: c.config,
    request<T>(method: Method, path: string, opts?: RequestOptions<T>) {
      return c.request<T>(method, path, opts).catch((e: unknown) => {
        if ((e as { name?: string })?.name === "AbortError") throw e;
        throw withNotificationMessage(e);
      });
    },
  };
}

export const notificationsClient: ApiClient = withNotificationErrors(
  createClient({ ...apiClient.config, mockHandler: lazyMock }),
);
