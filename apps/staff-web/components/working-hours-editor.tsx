"use client";
import { WEEKDAYS, type WorkingHours } from "@dentalos/validation";
import { Button, Input } from "@dentalos/ui";
import { Plus, X } from "lucide-react";

const DAY_LABEL: Record<(typeof WEEKDAYS)[number], string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

/**
 * Edits Branch.workingHours: per weekday, up to four sessions in branch-local time. A day with no
 * sessions is closed. Errors arrive keyed by zod path ("workingHours.mon.0", "workingHours").
 */
export function WorkingHoursEditor({
  value,
  onChange,
  errors,
  disabled,
}: {
  value: WorkingHours;
  onChange: (v: WorkingHours) => void;
  errors: Record<string, string>;
  disabled?: boolean;
}) {
  const setDay = (day: (typeof WEEKDAYS)[number], sessions: { open: string; close: string }[]) => {
    const next = { ...value };
    if (sessions.length) next[day] = sessions;
    else delete next[day];
    onChange(next);
  };
  const rootError = errors.workingHours;

  return (
    <fieldset className="dos-fieldset">
      <legend className="dos-label">Working hours</legend>
      <div className="dos-hint">Local branch time. Leave a day empty to mark it closed.</div>
      {rootError ? <div className="dos-error">{rootError}</div> : null}
      <div className="dos-stack" data-gap="sm">
        {WEEKDAYS.map((day) => {
          const sessions = value[day] ?? [];
          const dayError = Object.entries(errors).find(([k]) =>
            k.startsWith(`workingHours.${day}`),
          )?.[1];
          return (
            <div key={day} className="dos-stack" data-gap="sm" style={{ paddingBlock: 4 }}>
              <div className="dos-cluster" style={{ justifyContent: "space-between" }}>
                <strong style={{ minWidth: 96 }}>{DAY_LABEL[day]}</strong>
                {sessions.length === 0 ? <span className="dos-muted">Closed</span> : null}
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={disabled || sessions.length >= 4}
                  onClick={() =>
                    setDay(day, [
                      ...sessions,
                      sessions.length ? { open: "16:00", close: "20:00" } : { open: "09:30", close: "13:30" },
                    ])
                  }
                  aria-label={`Add session on ${DAY_LABEL[day]}`}
                >
                  <Plus size={16} aria-hidden="true" /> Session
                </Button>
              </div>
              {sessions.map((s, i) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: sessions have no identity beyond order
                  key={i}
                  className="dos-cluster"
                >
                  <Input
                    type="time"
                    aria-label={`${DAY_LABEL[day]} session ${i + 1} opens`}
                    value={s.open}
                    disabled={disabled}
                    style={{ width: 130 }}
                    aria-invalid={dayError ? true : undefined}
                    onChange={(e) =>
                      setDay(
                        day,
                        sessions.map((x, j) => (j === i ? { ...x, open: e.target.value } : x)),
                      )
                    }
                  />
                  <span aria-hidden="true">to</span>
                  <Input
                    type="time"
                    aria-label={`${DAY_LABEL[day]} session ${i + 1} closes`}
                    value={s.close}
                    disabled={disabled}
                    style={{ width: 130 }}
                    aria-invalid={dayError ? true : undefined}
                    onChange={(e) =>
                      setDay(
                        day,
                        sessions.map((x, j) => (j === i ? { ...x, close: e.target.value } : x)),
                      )
                    }
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    iconOnly
                    disabled={disabled}
                    aria-label={`Remove ${DAY_LABEL[day]} session ${i + 1}`}
                    onClick={() => setDay(day, sessions.filter((_, j) => j !== i))}
                  >
                    <X size={16} aria-hidden="true" />
                  </Button>
                </div>
              ))}
              {dayError ? <div className="dos-error">{dayError}</div> : null}
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}

export function summariseHours(wh: WorkingHours): string {
  const open = WEEKDAYS.filter((d) => (wh[d]?.length ?? 0) > 0);
  if (open.length === 0) return "Not set";
  return `${open.length} day${open.length === 1 ? "" : "s"} · ${open.map((d) => d.slice(0, 1).toUpperCase() + d.slice(1, 3)).join(", ")}`;
}
