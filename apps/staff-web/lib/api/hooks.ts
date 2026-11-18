"use client";
import { useToast } from "@dentalos/ui";
import { type DependencyList, useCallback, useEffect, useRef, useState } from "react";
import { type ApiError, asApiError } from "./errors";

export interface QueryState<T> {
  data: T | undefined;
  error: ApiError | undefined;
  loading: boolean;
  reload: () => void;
}

/**
 * Minimal data hook: runs `fn` when `deps` change, ignores stale responses, exposes reload().
 * (No cache layer yet; swap for TanStack Query when it is added as a dependency.)
 */
export function useQuery<T>(fn: () => Promise<T>, deps: DependencyList, enabled = true) {
  const [state, setState] = useState<{ data?: T; error?: ApiError; loading: boolean }>({
    loading: enabled,
  });
  const [nonce, setNonce] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  // biome-ignore lint/correctness/useExhaustiveDependencies: caller-provided deps drive refetch
  useEffect(() => {
    if (!enabled) {
      setState({ loading: false });
      return;
    }
    let live = true;
    setState((s) => ({ data: s.data, loading: true }));
    fnRef.current().then(
      (data) => live && setState({ data, loading: false }),
      (e) => live && setState({ error: asApiError(e), loading: false }),
    );
    return () => {
      live = false;
    };
  }, [...deps, nonce, enabled]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data: state.data, error: state.error, loading: state.loading, reload } as QueryState<T>;
}

/**
 * Wraps a write: tracks pending state, toasts success/failure, returns the result (or undefined
 * when it failed). Validation errors are returned to the caller via `onError` for field mapping.
 */
export function useMutation<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
  opts: {
    success?: string | ((r: R) => string);
    onSuccess?: (r: R) => void;
    onError?: (e: ApiError) => void;
  } = {},
) {
  const { toast } = useToast();
  const [pending, setPending] = useState(false);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const run = useCallback(
    async (...args: A): Promise<R | undefined> => {
      setPending(true);
      try {
        const r = await fn(...args);
        const o = optsRef.current;
        if (o.success) toast({ tone: "success", title: typeof o.success === "string" ? o.success : o.success(r) });
        o.onSuccess?.(r);
        return r;
      } catch (e) {
        const err = asApiError(e);
        optsRef.current.onError?.(err);
        if (err.kind !== "validation" || Object.keys(err.fieldErrors).length === 0)
          toast({ tone: "danger", title: "Couldn't save", description: err.message });
        return undefined;
      } finally {
        setPending(false);
      }
    },
    [fn, toast],
  );
  return { run, pending };
}
