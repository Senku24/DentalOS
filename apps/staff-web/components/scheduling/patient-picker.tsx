"use client";
import { Button, Spinner } from "@dentalos/ui";
import type { PatientSummary } from "@dentalos/validation";
import { type KeyboardEvent, useEffect, useId, useState } from "react";
import { api } from "../../lib/api/endpoints";
import { formatDate, formatPhone, patientName } from "../../lib/format";
import { useDebounced } from "../../lib/use-debounced";

/**
 * Patient search (reuses GET /patients from the shared client) as an ARIA combobox: type a name,
 * phone, email or MRN; Up/Down move, Enter selects, Esc closes. The picked patient shows as a card
 * with "Change".
 */
export function PatientPicker({
  value,
  onChange,
  error,
  label = "Patient",
  autoFocus,
}: {
  value: PatientSummary | null;
  onChange: (p: PatientSummary | null) => void;
  error?: string;
  label?: string;
  autoFocus?: boolean;
}) {
  const uid = useId();
  const [term, setTerm] = useState("");
  const q = useDebounced(term.trim(), 250);
  const [results, setResults] = useState<PatientSummary[]>([]);
  const [loading, setLoading] = useState(false);
  // A failed search must not read as "0 matches" (the receptionist might register a duplicate).
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` re-runs a failed search
  useEffect(() => {
    if (q.length < 2) {
      setResults([]);
      setLoading(false);
      setFailed(false);
      return;
    }
    let live = true;
    setLoading(true);
    setFailed(false);
    api.patients.search({ q, limit: 8 }).then(
      (r) => {
        if (!live) return;
        setResults(r.items);
        setActive(0);
        setOpen(true);
        setLoading(false);
      },
      () => {
        if (!live) return;
        setResults([]);
        setFailed(true);
        setLoading(false);
      },
    );
    return () => {
      live = false;
    };
  }, [q, attempt]);

  if (value) {
    return (
      <div className="dos-field">
        <span className="dos-label" id={`${uid}-l`}>
          {label}
        </span>
        <div className="sch-picked" aria-labelledby={`${uid}-l`}>
          <div>
            <strong>{patientName(value)}</strong>
            <small>
              {[
                value.mrn,
                formatPhone(value.phone),
                value.dob ? `DOB ${formatDate(value.dob)}` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </small>
          </div>
          <Button size="sm" variant="secondary" onClick={() => onChange(null)}>
            Change<span className="dos-sr-only"> patient</span>
          </Button>
        </div>
        {error ? (
          <div className="dos-error" role="alert">
            {error}
          </div>
        ) : null}
      </div>
    );
  }

  const listId = `${uid}-list`;
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(results.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter" && open && results[active]) {
      e.preventDefault();
      onChange(results[active] as PatientSummary);
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  };
  const expanded = open && results.length > 0;

  return (
    <div className="dos-field">
      <label className="dos-label" htmlFor={`${uid}-i`}>
        {label}
        <span aria-hidden="true"> *</span>
      </label>
      <input
        id={`${uid}-i`}
        className="dos-input"
        type="search"
        role="combobox"
        autoComplete="off"
        // biome-ignore lint/a11y/noAutofocus: opened from an explicit "Book" action inside a dialog
        autoFocus={autoFocus}
        aria-expanded={expanded}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={expanded ? `${uid}-o-${active}` : undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={`${uid}-h${error ? ` ${uid}-e` : ""}`}
        placeholder="Name, phone, email or MRN"
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => results.length && setOpen(true)}
      />
      <div className="dos-hint" id={`${uid}-h`}>
        Type at least 2 characters. {loading ? <Spinner label="Searching patients" /> : null}
        <span aria-live="polite">
          {!loading && q.length >= 2 && !failed
            ? `${results.length} match${results.length === 1 ? "" : "es"}`
            : ""}
        </span>
      </div>
      {failed && !loading ? (
        <div className="dos-error" role="alert">
          Patient search failed; this does not mean the patient isn't registered.{" "}
          <Button size="sm" variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
            Search again
          </Button>
        </div>
      ) : null}
      {error ? (
        <div className="dos-error" id={`${uid}-e`}>
          {error}
        </div>
      ) : null}
      {expanded ? (
        // biome-ignore lint/a11y/useSemanticElements lint/a11y/useFocusableInteractive: ARIA 1.2 combobox popup; focus stays in the input (aria-activedescendant)
        <div
          role="listbox"
          className="sch-picker__results"
          id={listId}
          aria-label="Matching patients"
        >
          {results.map((p, i) => (
            // biome-ignore lint/a11y/useSemanticElements: ARIA 1.2 combobox option, selected from the input with the arrow keys
            <div
              role="option"
              key={p.id}
              id={`${uid}-o-${i}`}
              tabIndex={-1}
              aria-selected={i === active}
              className="sch-picker__option"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onChange(p)}
              onKeyDown={(e) => e.key === "Enter" && onChange(p)}
            >
              {patientName(p)}
              <small>
                {[p.mrn, formatPhone(p.phone), p.dob ? `DOB ${formatDate(p.dob)}` : null]
                  .filter(Boolean)
                  .join(" · ")}
              </small>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
