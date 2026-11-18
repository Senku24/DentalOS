"use client";
import { useCallback, useState } from "react";

/** Keyset paging state: a stack of cursors so "Previous" works without server offsets. */
export function useCursorPaging() {
  const [stack, setStack] = useState<(string | undefined)[]>([undefined]);
  const cursor = stack[stack.length - 1];
  const next = useCallback((nextCursor: string | null | undefined) => {
    if (nextCursor) setStack((s) => [...s, nextCursor]);
  }, []);
  const prev = useCallback(() => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)), []);
  const reset = useCallback(() => setStack([undefined]), []);
  return { cursor, page: stack.length, hasPrev: stack.length > 1, next, prev, reset };
}

/** Debounced value for search-as-you-type against the server. */
export { useDebounced } from "./use-debounced";
