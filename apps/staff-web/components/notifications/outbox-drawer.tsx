"use client";
import {
  Alert,
  Button,
  ConfirmDialog,
  DescriptionList,
  Drawer,
  Skeleton,
  Timeline,
  type TimelineItem,
  useLink,
} from "@dentalos/ui";
import {
  NOTIFICATION_MAX_ATTEMPTS,
  type OutboxResponse,
  retryDelaySeconds,
} from "@dentalos/validation";
import { useEffect } from "react";
import { useState } from "react";
import { errorStateFor } from "../../lib/api/errors";
import { useMutation, useQuery } from "../../lib/api/hooks";
import { notificationsApi as nApi } from "../../lib/api/notifications";
import { channelLabel, consentReason, purposeLabel } from "../../lib/api/notifications-labels";
import { formatDateTime, humanize } from "../../lib/format";
import { canDo } from "../../lib/session";
import { DeliveryChip, OutboxStatusChip } from "./status-chip";
import { usePatientNames } from "./use-patient-names";

/** Lifecycle of one message, newest first, from the fields the outbox row carries. */
export function buildEvents(r: OutboxResponse): TimelineItem[] {
  const ev: TimelineItem[] = [];
  const cancelled = r.status === "FAILED" && r.lastError === "cancelled";
  if (r.deliveryStatus === "failed")
    ev.push({
      id: "delivery-failed",
      tone: "danger",
      title: "Delivery failed",
      meta: r.deliveredAt ? formatDateTime(r.deliveredAt) : "Reported by the provider",
      description: r.lastError ?? undefined,
    });
  else if (r.deliveredAt)
    ev.push({
      id: "delivered",
      tone: "success",
      title: r.deliveryStatus === "read" ? "Read by the patient" : "Delivered",
      meta: formatDateTime(r.deliveredAt),
    });
  if (r.status === "FAILED")
    ev.push({
      id: "failed",
      tone: cancelled ? "neutral" : "danger",
      title: cancelled ? "Cancelled by staff" : "Failed",
      meta: `${r.attempts} of ${NOTIFICATION_MAX_ATTEMPTS} attempts`,
      description: cancelled ? "It was never sent." : (r.lastError ?? undefined),
    });
  if (r.sentAt)
    ev.push({
      id: "sent",
      tone: "success",
      title: `Handed to ${r.provider ?? "the provider"}`,
      meta: formatDateTime(r.sentAt),
      description: r.providerMessageId ? `Provider id ${r.providerMessageId}` : undefined,
    });
  if (r.status === "QUEUED")
    ev.push({
      id: "queued-next",
      tone: "info",
      current: true,
      title: r.attempts > 0 ? `Retrying (attempt ${r.attempts + 1})` : "Waiting to send",
      meta: r.nextAttemptAt ? `Next attempt ${formatDateTime(r.nextAttemptAt)}` : undefined,
      description:
        r.attempts > 0
          ? `Backoff after this attempt: ${retryDelaySeconds(r.attempts)} seconds.`
          : undefined,
    });
  if (r.status === "SKIPPED_NO_CONSENT" || r.status === "OPTED_OUT")
    ev.push({
      id: "blocked",
      tone: r.status === "OPTED_OUT" ? "neutral" : "warning",
      title: r.status === "OPTED_OUT" ? "Not sent: patient opted out" : "Not sent: no consent",
      description: consentReason(r.lastError),
    });
  if (new Date(r.scheduledFor).getTime() - new Date(r.createdAt).getTime() > 60_000)
    ev.push({
      id: "scheduled",
      tone: "neutral",
      title: "Scheduled for later",
      meta: formatDateTime(r.scheduledFor),
      description: "Held back for the appointment time or by quiet hours.",
    });
  ev.push({
    id: "created",
    tone: "neutral",
    title: "Queued",
    meta: `${formatDateTime(r.createdAt)} · ${humanize(r.source.split(":")[0])}`,
  });
  return ev;
}

/**
 * Detail drawer of an outbox row: masked destination, attempts, delivery timeline and (with
 * comms:send) retry of a failed message or cancel of a queued one. Retrying creates a NEW queued
 * message (a failed row is final), so `onSelect` moves the drawer to it.
 */
export function OutboxDrawer({
  id,
  onClose,
  onChanged,
  onSelect,
}: {
  id: string | null;
  onClose: () => void;
  /** A row changed (retry / cancel / status poll): the caller refreshes its list. */
  onChanged: () => void;
  onSelect: (id: string) => void;
}) {
  return (
    <Drawer
      open={id !== null}
      onOpenChange={(o) => !o && onClose()}
      title="Message details"
      description="What was sent, to where, and what happened to it."
    >
      {id ? <Body key={id} id={id} onChanged={onChanged} onSelect={onSelect} /> : null}
    </Drawer>
  );
}

function Body({
  id,
  onChanged,
  onSelect,
}: { id: string; onChanged: () => void; onSelect: (id: string) => void }) {
  const Link = useLink();
  const q = useQuery(() => nApi.outbox.get(id), [id]);
  const row = q.data;
  const names = usePatientNames([row?.patientId]);
  const [confirmCancel, setConfirmCancel] = useState(false);

  // A queued message is picked up within seconds: keep the drawer fresh.
  const queued = row?.status === "QUEUED";
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload is stable
  useEffect(() => {
    if (!queued) return;
    const t = setInterval(q.reload, 4000);
    return () => clearInterval(t);
  }, [queued]);

  const retry = useMutation(() => nApi.outbox.retry(id), {
    success: (r) =>
      r.status === "QUEUED"
        ? "Retry queued"
        : `Retry recorded as ${r.status === "OPTED_OUT" ? "opted out" : "skipped: no consent"}`,
    onSuccess: (r) => {
      onChanged();
      onSelect(r.id);
    },
  });
  const cancel = useMutation(() => nApi.outbox.cancel(id), {
    success: "Message cancelled",
    onSuccess: () => {
      setConfirmCancel(false);
      q.reload();
      onChanged();
    },
    onError: () => {
      setConfirmCancel(false);
      q.reload();
      onChanged();
    },
  });

  if (q.error) {
    const e = errorStateFor(q.error);
    return (
      <Alert tone="danger">
        {e.title}: {e.description}{" "}
        <Button size="sm" variant="secondary" onClick={q.reload}>
          Try again
        </Button>
      </Alert>
    );
  }
  if (!row)
    return (
      <div className="dos-stack" data-gap="sm" aria-busy="true">
        <span className="dos-sr-only">Loading</span>
        <Skeleton height="1.25em" width="70%" />
        <Skeleton height="1.25em" width="50%" />
        <Skeleton height="6em" />
      </div>
    );

  const mayAct = canDo("comms:send", { branchId: row.branchId ?? undefined });
  return (
    <div className="dos-stack">
      <div className="dos-cluster">
        <OutboxStatusChip status={row.status} />
        <DeliveryChip status={row.deliveryStatus} />
      </div>
      {row.status === "SKIPPED_NO_CONSENT" || row.status === "OPTED_OUT" ? (
        <Alert tone="warning">
          {row.status === "OPTED_OUT"
            ? "The patient has opted out, so this message was not sent."
            : "The patient has not consented to this kind of message, so it was not sent."}{" "}
          {consentReason(row.lastError)}
        </Alert>
      ) : null}
      {row.status === "FAILED" && row.lastError && row.lastError !== "cancelled" ? (
        <Alert tone="danger">Last error: {row.lastError.replace(/_/g, " ")}</Alert>
      ) : null}
      <DescriptionList
        columns={1}
        items={[
          { term: "To", detail: <span className="dos-mono">{row.toAddressMasked}</span> },
          {
            term: "Patient",
            detail: row.patientId ? (
              <Link href={`/patients/${row.patientId}`} className="dos-link">
                {names[row.patientId] ?? "Open patient"}
              </Link>
            ) : (
              "None (test message)"
            ),
          },
          { term: "Channel", detail: channelLabel(row.channel) },
          { term: "Purpose", detail: purposeLabel(row.purpose) },
          { term: "Template", detail: <span className="dos-mono">{row.templateCode}</span> },
          {
            term: "Attempts",
            detail: `${row.attempts} of ${NOTIFICATION_MAX_ATTEMPTS}`,
          },
          { term: "Provider", detail: row.provider ?? "Not sent yet" },
          { term: "Source", detail: humanize(row.source.split(":")[0]) },
          { term: "Created", detail: formatDateTime(row.createdAt) },
        ]}
      />
      <div>
        <h3 className="dos-section-title">Delivery timeline</h3>
        <Timeline label="Delivery events" items={buildEvents(row)} />
        {row.provider === "CONSOLE" ? (
          <p className="dos-hint">
            The console provider only logs messages on the server. It has no delivery receipts
            (webhooks), so "delivered" and "read" never appear for it.
          </p>
        ) : null}
      </div>
      {mayAct && row.status === "FAILED" ? (
        <div className="dos-stack" data-gap="sm">
          <Button loading={retry.pending} onClick={() => void retry.run()}>
            Retry sending
          </Button>
          <p className="dos-hint">
            Retrying queues a new message with the same text and address. Consent and quiet hours
            are checked again, so it may be skipped.
          </p>
        </div>
      ) : null}
      {mayAct && row.status === "QUEUED" ? (
        <div>
          <Button variant="danger" onClick={() => setConfirmCancel(true)}>
            Cancel this message
          </Button>
        </div>
      ) : null}
      <ConfirmDialog
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        title="Cancel this message?"
        description="It will not be sent. A cancelled message can't be queued again, but you can retry it as a new message."
        confirmLabel="Cancel message"
        tone="danger"
        loading={cancel.pending}
        onConfirm={() => void cancel.run()}
      />
    </div>
  );
}
