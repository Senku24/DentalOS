"use client";
import { X } from "lucide-react";
import { type ReactNode, createContext, useCallback, useContext, useMemo, useState } from "react";
import { Button } from "./button";

type Tone = "success" | "danger" | "info";
interface ToastItem {
  id: number;
  tone: Tone;
  title: string;
  description?: string;
}
interface Api {
  toast: (t: Omit<ToastItem, "id">) => void;
}
const Ctx = createContext<Api | null>(null);
let seq = 0;

export function ToastProvider({
  children,
  durationMs = 6000,
}: { children: ReactNode; durationMs?: number }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const dismiss = useCallback((id: number) => setItems((l) => l.filter((t) => t.id !== id)), []);
  const toast = useCallback(
    (t: Omit<ToastItem, "id">) => {
      const id = ++seq;
      setItems((l) => [...l, { ...t, id }]);
      // Errors persist until dismissed (WCAG 2.2.1: enough time to read/act).
      if (t.tone !== "danger") setTimeout(() => dismiss(id), durationMs);
    },
    [dismiss, durationMs],
  );
  const api = useMemo(() => ({ toast }), [toast]);
  return (
    <Ctx.Provider value={api}>
      {children}
      <section className="dos-toasts" aria-label="Notifications">
        {items.map((t) => (
          <div
            key={t.id}
            className="dos-toast"
            data-tone={t.tone}
            role={t.tone === "danger" ? "alert" : "status"}
          >
            <div className="dos-toast__body">
              <div className="dos-toast__title">{t.title}</div>
              {t.description ? <div>{t.description}</div> : null}
            </div>
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label="Dismiss notification"
              onClick={() => dismiss(t.id)}
            >
              <X size={16} aria-hidden="true" />
            </Button>
          </div>
        ))}
      </section>
    </Ctx.Provider>
  );
}

export function useToast(): Api {
  const c = useContext(Ctx);
  if (!c) throw new Error("useToast must be used inside <ToastProvider>");
  return c;
}
