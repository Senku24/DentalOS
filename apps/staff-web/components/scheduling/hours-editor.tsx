"use client";
import { Button, SelectField } from "@dentalos/ui";
import { type WorkingHoursSession, hhmmToMinutes, minutesToHHMM } from "@dentalos/validation";
import { Plus, X } from "lucide-react";
import { WEEKDAY_NAMES, WEEKDAY_ORDER } from "../../lib/api/scheduling-hours";
import { timeOptions } from "../../lib/api/scheduling-time";

const START_OPTIONS = timeOptions(15);
const END_OPTIONS = [...timeOptions(15, 15), "24:00"];

export function sessionsText(
  sessions: readonly { startMinute: number; endMinute: number }[],
): string {
  if (sessions.length === 0) return "Closed";
  return sessions
    .map((s) => `${minutesToHHMM(s.startMinute)}–${minutesToHHMM(s.endMinute)}`)
    .join(", ");
}

/**
 * Weekly sessions (weekday 0 = Sunday, minutes after local midnight, [start, end)) for
 * PUT /working-hours. A day without sessions is closed for this subject from the effective date.
 */
export function WeeklySessionsEditor({
  value,
  onChange,
  error,
  disabled,
}: {
  value: WorkingHoursSession[];
  onChange: (v: WorkingHoursSession[]) => void;
  error?: string;
  disabled?: boolean;
}) {
  const ofDay = (wd: number) =>
    value
      .map((s, i) => ({ s, i }))
      .filter((x) => x.s.weekday === wd)
      .sort((a, b) => a.s.startMinute - b.s.startMinute);

  const update = (i: number, patch: Partial<WorkingHoursSession>) =>
    onChange(value.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const remove = (i: number) => onChange(value.filter((_, j) => j !== i));
  const add = (wd: number) => {
    const last = ofDay(wd).at(-1)?.s;
    const start = last ? Math.min(last.endMinute + 60, 23 * 60) : 9 * 60;
    onChange([
      ...value,
      { weekday: wd, startMinute: start, endMinute: Math.min(start + 4 * 60, 1440) },
    ]);
  };
  const copyMonday = () => {
    const mon = value.filter((s) => s.weekday === 1);
    const rest = value.filter((s) => s.weekday === 0 || s.weekday === 1);
    onChange([
      ...rest,
      ...[2, 3, 4, 5, 6].flatMap((wd) => mon.map((s) => ({ ...s, weekday: wd }))),
    ]);
  };

  return (
    <fieldset className="dos-fieldset" aria-invalid={error ? true : undefined}>
      <legend className="dos-label">Weekly sessions</legend>
      <div className="dos-hint">Local branch time. A day with no sessions is closed.</div>
      {error ? (
        <div className="dos-error" role="alert">
          {error}
        </div>
      ) : null}
      <div style={{ marginBlock: 8 }}>
        <Button size="sm" variant="ghost" disabled={disabled} onClick={copyMonday}>
          Copy Monday to Tuesday–Saturday
        </Button>
      </div>
      <div className="sch-hours">
        {WEEKDAY_ORDER.map((wd) => {
          const day = WEEKDAY_NAMES[wd];
          const rows = ofDay(wd);
          return (
            <div key={wd} className="sch-hours__day">
              <strong>{day}</strong>
              <div className="sch-hours__sessions">
                {rows.length === 0 ? <span className="dos-muted">Closed</span> : null}
                {rows.map(({ s, i }, n) => (
                  <div key={`s-${i}`} className="sch-hours__session">
                    <SelectField
                      label={`${day} session ${n + 1} start`}
                      value={minutesToHHMM(s.startMinute)}
                      disabled={disabled}
                      onChange={(e) => update(i, { startMinute: hhmmToMinutes(e.target.value) })}
                    >
                      {START_OPTIONS.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </SelectField>
                    <SelectField
                      label={`${day} session ${n + 1} end`}
                      value={minutesToHHMM(s.endMinute)}
                      disabled={disabled}
                      onChange={(e) => update(i, { endMinute: hhmmToMinutes(e.target.value) })}
                    >
                      {END_OPTIONS.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </SelectField>
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      disabled={disabled}
                      aria-label={`Remove ${day} session ${n + 1}`}
                      onClick={() => remove(i)}
                    >
                      <X size={16} aria-hidden="true" />
                    </Button>
                  </div>
                ))}
                <div>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={disabled || rows.length >= 4}
                    onClick={() => add(wd)}
                  >
                    <Plus size={14} aria-hidden="true" /> Add session
                    <span className="dos-sr-only"> on {day}</span>
                  </Button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}
