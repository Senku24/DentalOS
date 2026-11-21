import { Badge } from "@dentalos/ui";
import { DELIVERY_TONE, statusLabel, statusTone } from "../../lib/api/notifications-labels";

/** Outbox status as a text chip (QUEUED / SENT / FAILED / SKIPPED_NO_CONSENT / OPTED_OUT). */
export function OutboxStatusChip({ status }: { status: string }) {
  return <Badge tone={statusTone(status)}>{statusLabel(status)}</Badge>;
}

/** Provider delivery state (queued / sent / delivered / read / failed), when a receipt exists. */
export function DeliveryChip({ status }: { status: string | null | undefined }) {
  if (!status) return null;
  return (
    <Badge tone={DELIVERY_TONE[status] ?? "neutral"}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </Badge>
  );
}
