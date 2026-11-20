"use client";
import { Alert, Badge, Button, Checkbox, Dialog, SelectField, useLink } from "@dentalos/ui";
import type { EncounterDetailResponse, EncounterResponse } from "@dentalos/validation";
import { Lock, PenLine } from "lucide-react";
import { useState } from "react";
import { clinicalApi } from "../../lib/api/clinical";
import { useMutation } from "../../lib/api/hooks";
import { formatDateTime } from "../../lib/format";
import { canDo, scopedBranchIds } from "../../lib/session";
import { BranchOptions, Section, useBranches } from "../common";
import { Kv, isMe, personLabel, useBranchDentists } from "./bits";

/**
 * The encounter context (PRD 3.4): treating dentist, branch, status and timing, always visible
 * beside the record. Signing is offered only to the treating dentist holding clinical:sign; the
 * confirmation states that signed content becomes immutable (ADR 0003 §2).
 */
export function EncounterPanel({
  encounter,
  branchName,
  onChanged,
}: {
  encounter: EncounterDetailResponse;
  branchName: (id: string | null | undefined) => string;
  onChanged: () => void;
}) {
  const Link = useLink();
  const [signing, setSigning] = useState(false);
  const [handing, setHanding] = useState(false);
  const open = encounter.status === "OPEN";
  const scope = { branchId: encounter.branchId };
  const mayHold = canDo("clinical:sign", scope);
  const treating = isMe(encounter.treatingDentistUserId);
  const canHandOver =
    open && canDo("clinical:write", scope) && (treating || isMe(encounter.openedBy));

  return (
    <Section
      title="Encounter"
      actions={
        open ? (
          <Badge tone="info">Open</Badge>
        ) : (
          <Badge tone="success">
            <Lock size={12} aria-hidden="true" /> Signed
          </Badge>
        )
      }
    >
      <Kv
        items={[
          [
            "Treating dentist",
            <strong key="d">{personLabel(encounter.treatingDentistUserId)}</strong>,
          ],
          ["Branch", branchName(encounter.branchId)],
          ["Opened", `${formatDateTime(encounter.openedAt)} by ${personLabel(encounter.openedBy)}`],
          [
            "Appointment",
            encounter.appointmentId ? (
              <Link
                key="a"
                href={`/appointments?appointment=${encounter.appointmentId}`}
                className="dos-link"
              >
                Linked visit
              </Link>
            ) : (
              "Walk-in / unscheduled"
            ),
          ],
          ...(encounter.signedAt
            ? ([
                [
                  "Signed",
                  `${formatDateTime(encounter.signedAt)} by ${personLabel(encounter.signedBy)}`,
                ],
              ] as [string, string][])
            : []),
        ]}
      />
      {open ? (
        <div className="dos-stack" data-gap="sm">
          {mayHold && treating ? (
            <Button onClick={() => setSigning(true)}>
              <PenLine size={16} aria-hidden="true" /> Sign encounter
            </Button>
          ) : (
            <p className="cw-meta" style={{ margin: 0 }}>
              {mayHold
                ? `Only the treating dentist (${personLabel(encounter.treatingDentistUserId)}) can sign this encounter.`
                : "Signing needs the clinical:sign permission and is done by the treating dentist."}
            </p>
          )}
          {canHandOver ? (
            <Button variant="secondary" size="sm" onClick={() => setHanding(true)}>
              Hand over to another dentist
            </Button>
          ) : null}
        </div>
      ) : (
        <Alert tone="info">
          Signed records can't be edited. Corrections are added as amendments with a reason.
        </Alert>
      )}
      {signing ? (
        <SignDialog
          encounter={encounter}
          onClose={() => setSigning(false)}
          onDone={() => {
            setSigning(false);
            onChanged();
          }}
        />
      ) : null}
      {handing ? (
        <HandOverDialog
          encounter={encounter}
          onClose={() => setHanding(false)}
          onDone={() => {
            setHanding(false);
            onChanged();
          }}
        />
      ) : null}
    </Section>
  );
}

function SignDialog({
  encounter,
  onClose,
  onDone,
}: {
  encounter: EncounterDetailResponse;
  onClose: () => void;
  onDone: () => void;
}) {
  const [attest, setAttest] = useState(false);
  const [error, setError] = useState<string>();
  const sign = useMutation(() => clinicalApi.encounters.sign(encounter.id), {
    success: "Encounter signed",
    onSuccess: onDone,
    onError: (e) => setError(e.message),
  });
  const counts = [
    `${encounter.notes.length} note${encounter.notes.length === 1 ? "" : "s"}`,
    `${encounter.diagnoses.length} diagnos${encounter.diagnoses.length === 1 ? "is" : "es"}`,
    `${encounter.procedures.length} procedure${encounter.procedures.length === 1 ? "" : "s"}`,
    `${encounter.toothRecords.length} chart entr${encounter.toothRecords.length === 1 ? "y" : "ies"}`,
  ].join(", ");
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !sign.pending && onClose()}
      title="Sign this encounter?"
      description="Signing is final. The signed notes, diagnoses, procedures and chart entries become immutable and can only be corrected by adding an amendment with a reason."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} autoFocus disabled={sign.pending}>
            Cancel
          </Button>
          <Button disabled={!attest} loading={sign.pending} onClick={() => void sign.run()}>
            Sign and lock
          </Button>
        </>
      }
    >
      <div className="dos-stack">
        <p style={{ margin: 0 }}>This record contains {counts}.</p>
        {encounter.notes.length === 0 ? (
          <Alert tone="warning">
            There are no clinical notes. Add notes before signing if needed.
          </Alert>
        ) : null}
        <Checkbox
          label="I attest that this record is complete and accurate."
          checked={attest}
          onChange={(e) => setAttest(e.target.checked)}
        />
        {error ? <Alert tone="danger">{error}</Alert> : null}
      </div>
    </Dialog>
  );
}

function HandOverDialog({
  encounter,
  onClose,
  onDone,
}: {
  encounter: EncounterDetailResponse;
  onClose: () => void;
  onDone: () => void;
}) {
  const { ids } = useBranchDentists(encounter.branchId);
  const [userId, setUserId] = useState("");
  const [error, setError] = useState<string>();
  const save = useMutation(
    () => clinicalApi.encounters.update(encounter.id, { treatingDentistUserId: userId }),
    {
      success: "Encounter handed over",
      onSuccess: onDone,
      onError: (e) => setError(e.fieldErrors.treatingDentistUserId ?? e.message),
    },
  );
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Hand over encounter"
      description="The new treating dentist becomes responsible for completing and signing this record. The change is audited."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!userId} loading={save.pending} onClick={() => void save.run()}>
            Hand over
          </Button>
        </>
      }
    >
      <SelectField
        label="New treating dentist"
        required
        value={userId}
        error={error}
        onChange={(e) => setUserId(e.target.value)}
      >
        <option value="">Select a dentist</option>
        {ids
          .filter((id) => id !== encounter.treatingDentistUserId)
          .map((id) => (
            <option key={id} value={id}>
              {personLabel(id)}
            </option>
          ))}
      </SelectField>
    </Dialog>
  );
}

/** Opens a walk-in encounter (appointments open theirs from the schedule). */
export function OpenEncounterDialog({
  patientId,
  defaultBranchId,
  onClose,
  onDone,
}: {
  patientId: string;
  defaultBranchId: string;
  onClose: () => void;
  onDone: (e: EncounterResponse) => void;
}) {
  const { branches } = useBranches();
  const allowed = scopedBranchIds(branches).filter((b) => canDo("clinical:write", { branchId: b }));
  const [branchId, setBranchId] = useState(defaultBranchId);
  const effectiveBranch = branchId || allowed[0] || "";
  const { ids } = useBranchDentists(effectiveBranch);
  const [dentist, setDentist] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useMutation(
    () =>
      clinicalApi.encounters.open({
        patientId,
        branchId: effectiveBranch,
        treatingDentistUserId: dentist || undefined,
      }),
    {
      success: "Encounter opened",
      onSuccess: onDone,
      onError: (e) => setErrors({ ...e.fieldErrors, _form: e.message }),
    },
  );
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Open encounter"
      description="Starts a clinical record for this visit. Notes, findings and charting are added to it until the treating dentist signs."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!effectiveBranch}
            loading={save.pending}
            onClick={() => void save.run()}
          >
            Open encounter
          </Button>
        </>
      }
    >
      <div className="dos-stack">
        <SelectField
          label="Branch"
          required
          value={effectiveBranch}
          error={errors.branchId}
          onChange={(e) => setBranchId(e.target.value)}
        >
          <BranchOptions branches={branches} ids={allowed} />
        </SelectField>
        <SelectField
          label="Treating dentist"
          hint="Defaults to you."
          value={dentist}
          error={errors.treatingDentistUserId}
          onChange={(e) => setDentist(e.target.value)}
        >
          <option value="">Me</option>
          {ids
            .filter((id) => !isMe(id))
            .map((id) => (
              <option key={id} value={id}>
                {personLabel(id)}
              </option>
            ))}
        </SelectField>
        {errors._form && !errors.treatingDentistUserId && !errors.branchId ? (
          <Alert tone="danger">{errors._form}</Alert>
        ) : null}
      </div>
    </Dialog>
  );
}
