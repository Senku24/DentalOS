import { Check } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "./button";
import type { BadgeTone } from "./badge";

/** Term/detail pairs for record summaries (profile header, settings read-outs). */
export function DescriptionList({
  items,
  columns = 2,
}: {
  items: { term: string; detail: ReactNode }[];
  columns?: 1 | 2 | 3;
}) {
  return (
    <dl className="dos-dl" data-columns={columns}>
      {items.map((i) => (
        <div key={i.term} className="dos-dl__row">
          <dt>{i.term}</dt>
          <dd>{i.detail ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

export interface TimelineItem {
  id: string;
  title: ReactNode;
  /** Date range / actor line under the title. */
  meta?: ReactNode;
  description?: ReactNode;
  /** Marker colour; meaning is always repeated in text. */
  tone?: BadgeTone;
  current?: boolean;
}

/** Vertical history (assignments, price changes, record versions). Newest first by convention. */
export function Timeline({ items, label }: { items: TimelineItem[]; label: string }) {
  return (
    <ol className="dos-timeline" aria-label={label}>
      {items.map((i) => (
        <li
          key={i.id}
          className="dos-timeline__item"
          data-tone={i.tone ?? "neutral"}
          aria-current={i.current ? "true" : undefined}
        >
          <span className="dos-timeline__dot" aria-hidden="true" />
          <div className="dos-timeline__title">{i.title}</div>
          {i.meta ? <div className="dos-timeline__meta">{i.meta}</div> : null}
          {i.description ? <div className="dos-timeline__desc">{i.description}</div> : null}
        </li>
      ))}
    </ol>
  );
}

/** Wizard progress. The current step carries aria-current="step". */
export function Steps({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="dos-steps" aria-label="Progress">
      {steps.map((s, i) => {
        const state = i < current ? "done" : i === current ? "current" : "todo";
        return (
          <li key={s} className="dos-steps__item" data-state={state} aria-current={state === "current" ? "step" : undefined}>
            <span className="dos-steps__num" aria-hidden="true">
              {state === "done" ? <Check size={14} /> : i + 1}
            </span>
            <span>
              {s}
              {state === "done" ? <span className="dos-sr-only"> (completed)</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Previous/next for server-driven (keyset) lists, where the total is unknown.
 * The caller keeps the cursor stack; this only renders state and announces the page.
 */
export function CursorPager({
  page,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
  loading,
  itemCount,
}: {
  /** 1-based page index. */
  page: number;
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  loading?: boolean;
  itemCount?: number;
}) {
  return (
    <nav className="dos-pagination" aria-label="Pagination">
      <output aria-live="polite">
        {loading
          ? "Loading…"
          : `Page ${page}${itemCount !== undefined ? ` · ${itemCount} shown` : ""}`}
      </output>
      <div className="dos-pagination__nav">
        <Button variant="secondary" size="sm" onClick={onPrev} disabled={!hasPrev || loading}>
          Previous
        </Button>
        <Button variant="secondary" size="sm" onClick={onNext} disabled={!hasNext || loading}>
          Next
        </Button>
      </div>
    </nav>
  );
}

/** Horizontal wrap of filters/actions above a list. */
export function Toolbar({ children, label }: { children: ReactNode; label?: string }) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a toolbar of filters, not a single form
    <div className="dos-toolbar" role="group" aria-label={label}>
      {children}
    </div>
  );
}
