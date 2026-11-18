"use client";
import { type KeyboardEvent, type ReactNode, useId, useRef } from "react";

export interface TabItem {
  id: string;
  label: ReactNode;
  /** Optional count/badge shown after the label. */
  badge?: ReactNode;
}

/**
 * WAI-ARIA tabs (automatic activation): one tab stop, Left/Right/Home/End move and select.
 * Render the active panel as `children`; it is labelled by the active tab.
 */
export function Tabs({
  label,
  items,
  value,
  onValueChange,
  children,
}: {
  /** Accessible name of the tab list. */
  label: string;
  items: TabItem[];
  value: string;
  onValueChange: (id: string) => void;
  children: ReactNode;
}) {
  const uid = useId();
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const tabId = (id: string) => `${uid}-tab-${id}`;
  const panelId = `${uid}-panel`;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = items.findIndex((t) => t.id === value);
    let next = -1;
    if (e.key === "ArrowRight") next = (i + 1) % items.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + items.length) % items.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const t = items[next];
    if (!t) return;
    onValueChange(t.id);
    refs.current[t.id]?.focus();
  };

  return (
    <div className="dos-tabs">
      <div className="dos-tabs__list" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
        {items.map((t) => {
          const selected = t.id === value;
          return (
            <button
              key={t.id}
              ref={(el) => {
                refs.current[t.id] = el;
              }}
              type="button"
              role="tab"
              id={tabId(t.id)}
              className="dos-tabs__tab"
              aria-selected={selected}
              aria-controls={panelId}
              tabIndex={selected ? 0 : -1}
              onClick={() => onValueChange(t.id)}
            >
              {t.label}
              {t.badge !== undefined ? <span className="dos-tabs__badge">{t.badge}</span> : null}
            </button>
          );
        })}
      </div>
      <div
        className="dos-tabs__panel"
        role="tabpanel"
        id={panelId}
        aria-labelledby={tabId(value)}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: APG tabs pattern — panel is focusable
        tabIndex={0}
      >
        {children}
      </div>
    </div>
  );
}
