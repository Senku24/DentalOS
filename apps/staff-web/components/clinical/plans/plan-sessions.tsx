"use client";
import { Button, Dialog, EmptyState, TextareaField } from "@dentalos/ui";
import type { PlanItemSessionResponse } from "@dentalos/validation";
import { Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { PlanDetail, PlanItemDetail } from "../../../lib/api/clinical-types";
import { useMutation, useQuery } from "../../../lib/api/hooks";
import { plansApi } from "../../../lib/api/plans";
import { SCHEDULABLE_ITEM_STATUSES } from "../../../lib/api/plans-rules";
import { formatDateTime } from "../../../lib/format";
import { Loadable } from "../../common";
import { StatusBadge, personLabel, type useServiceDirectory } from "../bits";
import { toothShort } from "../fdi";

const OPEN_SESSION = ["PLANNED", "SCHEDULED"];

/**
 * Multi-visit sessions per accepted item. Session status is server-derived (appointment / encounter);
 * staff plan, complete or cancel them. Completing the item is refused while a session is SCHEDULED.
 */
export function PlanSessions({
  plan,
  services,
  canWrite,
  focusItemId,
  encounterId,
  onPlanChanged,
}: {
  plan: PlanDetail;
  services: ReturnType<typeof useServiceDirectory>;
  canWrite: boolean;
  focusItemId?: string;
  encounterId?: string;
  onPlanChanged: () => void;
}) {
  const items = plan.items
    .filter((i) => SCHEDULABLE_ITEM_STATUSES.includes(i.status) || i.status === "COMPLETED")
    .sort((a, b) => a.phase - b.phase || a.sequence - b.sequence);
  const q = useQuery(async () => {
    const all = await Promise.all(items.map((i) => plansApi.items.sessions(i.id)));
    return new Map(items.map((i, k) => [i.id, all[k]?.items ?? []]));
  }, [plan.id, plan.currentVersion, items.map((i) => i.id).join()]);
  const [adding, setAdding] = useState<PlanItemDetail | null>(null);
  const focusRef = useRef<HTMLLIElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll once the sessions have loaded
  useEffect(() => {
    focusRef.current?.scrollIntoView({ block: "nearest" });
  }, [q.data, focusItemId]);

  const refresh = () => {
    q.reload();
    onPlanChanged();
  };
  const complete = useMutation((s: PlanItemSessionResponse) => plansApi.sessions.complete(s.id), {
    success: "Session completed",
    onSuccess: refresh,
  });
  const cancel = useMutation(
    (s: PlanItemSessionResponse) => plansApi.sessions.update(s.id, { status: "CANCELLED" }),
    { success: "Session cancelled", onSuccess: refresh },
  );

  if (items.length === 0)
    return (
      <EmptyState
        title="No sessions to plan"
        description="Sessions are planned for accepted items. Record the patient's decisions first."
      />
    );

  return (
    <>
      <Loadable state={q}>
        {(map) => (
          <ul className="cw-list" aria-label="Sessions by plan item">
            {items.map((i) => {
              const rows = map.get(i.id) ?? [];
              const name = `${services.label(i.serviceId)}${i.toothCode ? ` · ${toothShort(i.toothCode, i.surfaces)}` : ""}`;
              const focused = i.id === focusItemId;
              return (
                <li
                  key={i.id}
                  ref={focused ? focusRef : undefined}
                  className="cw-item"
                  data-current={focused ? "true" : undefined}
                >
                  <div className="cw-row">
                    <strong>
                      Phase {i.phase}.{i.sequence} {name}
                    </strong>
                    <StatusBadge status={i.status} />
                  </div>
                  {rows.length === 0 ? (
                    <span className="cw-meta">No sessions yet.</span>
                  ) : (
                    <div className="cw-table-wrap">
                      <table className="cw-table">
                        <caption className="dos-sr-only">Sessions for {name}</caption>
                        <thead>
                          <tr>
                            <th scope="col">Session</th>
                            <th scope="col">Status</th>
                            <th scope="col">Visit</th>
                            <th scope="col">Notes</th>
                            {canWrite ? (
                              <th scope="col">
                                <span className="dos-sr-only">Actions</span>
                              </th>
                            ) : null}
                          </tr>
                        </thead>
                        <tbody>
                          {[...rows]
                            .sort((a, b) => a.sessionNo - b.sessionNo)
                            .map((s) => (
                              <tr key={s.id}>
                                <td>#{s.sessionNo}</td>
                                <td>
                                  <StatusBadge status={s.status} />
                                </td>
                                <td>
                                  {s.appointmentId ? "Appointment booked" : "Not booked"}
                                  {s.encounterId ? (
                                    <div className="cw-meta">Encounter linked</div>
                                  ) : null}
                                </td>
                                <td>
                                  {s.notes ?? "—"}
                                  <div className="cw-meta">
                                    {personLabel(s.createdBy)} · {formatDateTime(s.createdAt)}
                                  </div>
                                </td>
                                {canWrite ? (
                                  <td>
                                    {OPEN_SESSION.includes(s.status) ? (
                                      <div className="dos-cluster" style={{ flexWrap: "nowrap" }}>
                                        <Button
                                          size="sm"
                                          variant="secondary"
                                          onClick={() => void complete.run(s)}
                                        >
                                          Complete
                                          <span className="dos-sr-only">
                                            {" "}
                                            session {s.sessionNo}
                                          </span>
                                        </Button>
                                        <Button
                                          size="sm"
                                          variant="ghost"
                                          onClick={() => void cancel.run(s)}
                                        >
                                          Cancel
                                          <span className="dos-sr-only">
                                            {" "}
                                            session {s.sessionNo}
                                          </span>
                                        </Button>
                                      </div>
                                    ) : null}
                                  </td>
                                ) : null}
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {canWrite && SCHEDULABLE_ITEM_STATUSES.includes(i.status) ? (
                    <div>
                      <Button size="sm" variant="secondary" onClick={() => setAdding(i)}>
                        <Plus size={14} aria-hidden="true" /> Plan session
                        <span className="dos-sr-only"> for {name}</span>
                      </Button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Loadable>
      {adding ? (
        <AddSessionDialog
          item={adding}
          name={services.label(adding.serviceId)}
          encounterId={encounterId}
          onClose={() => setAdding(null)}
          onDone={() => {
            setAdding(null);
            refresh();
          }}
        />
      ) : null}
    </>
  );
}

function AddSessionDialog({
  item,
  name,
  encounterId,
  onClose,
  onDone,
}: {
  item: PlanItemDetail;
  name: string;
  encounterId?: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [notes, setNotes] = useState("");
  const save = useMutation(
    () =>
      plansApi.items.createSession(item.id, {
        status: "PLANNED",
        notes: notes.trim() || undefined,
        encounterId,
      }),
    { success: (s) => `Session ${s.sessionNo} planned`, onSuccess: onDone },
  );
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Plan a session for ${name}`}
      description="The session number is assigned automatically. Book its appointment from the schedule."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.pending} onClick={() => void save.run()}>
            Plan session
          </Button>
        </>
      }
    >
      <TextareaField
        label="Notes"
        rows={2}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
      />
    </Dialog>
  );
}
