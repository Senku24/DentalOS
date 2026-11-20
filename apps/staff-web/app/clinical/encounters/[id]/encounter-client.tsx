"use client";
import { Button, ErrorState, Skeleton } from "@dentalos/ui";
import { ClinicalWorkspace } from "../../../../components/clinical/workspace";
import { RequirePermission } from "../../../../components/common";
import { clinicalApi } from "../../../../lib/api/clinical";
import { errorStateFor } from "../../../../lib/api/errors";
import { useQuery } from "../../../../lib/api/hooks";

/** Resolves the encounter's patient, then shows the workspace focused on that encounter. */
export function EncounterWorkspace({ id }: { id: string }) {
  return (
    <RequirePermission permission="clinical:read">
      <Resolve id={id} />
    </RequirePermission>
  );
}

function Resolve({ id }: { id: string }) {
  const enc = useQuery(() => clinicalApi.encounters.get(id), [id]);
  if (enc.error) {
    const e = errorStateFor(enc.error);
    return (
      <ErrorState
        title={enc.error.kind === "not_found" ? "Encounter not found" : e.title}
        description={e.description}
        action={
          <Button variant="secondary" onClick={enc.reload}>
            Try again
          </Button>
        }
      />
    );
  }
  if (!enc.data)
    return (
      <div className="dos-stack" aria-busy="true">
        <span className="dos-sr-only">Loading encounter</span>
        <Skeleton height="4.5rem" />
        <Skeleton height="20rem" />
      </div>
    );
  return <ClinicalWorkspace key={id} patientId={enc.data.patientId} encounterId={id} />;
}
