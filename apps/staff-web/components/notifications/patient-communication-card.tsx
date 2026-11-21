"use client";
import { Badge, Button, useLink } from "@dentalos/ui";
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_PURPOSES,
  type NotificationChannel,
  type NotificationPurpose,
  type PreferenceCheckResponse,
} from "@dentalos/validation";
import { useState } from "react";
import { api } from "../../lib/api/endpoints";
import { asApiError } from "../../lib/api/errors";
import { useQuery } from "../../lib/api/hooks";
import { notificationsApi as nApi } from "../../lib/api/notifications";
import {
  channelLabel,
  consentReason,
  purposeLabel,
  statusLabel,
} from "../../lib/api/notifications-labels";
import { formatDateTime } from "../../lib/format";
import { canDo } from "../../lib/session";
import { Loadable, Section } from "../common";
import { OutboxStatusChip } from "./status-chip";

/**
 * Communication preferences per channel and purpose plus the patient's recent messages, for the
 * patient profile. Read-only: preferences are edited where they are today (the profile's consent
 * section, via `api.patients.setCommPrefs`). "Check" asks the API whether a message would go out
 * (same consent resolver as the send job). Needs `patient:read`; messages need `comms:read`.
 */
export function PatientCommunicationCard({
  patientId,
  recentLimit = 5,
}: { patientId: string; recentLimit?: number }) {
  const Link = useLink();
  const prefs = useQuery(() => api.patients.commPrefs(patientId), [patientId]);
  const mayRead = canDo("comms:read");
  const recent = useQuery(
    () => nApi.outbox.list({ patientId, limit: recentLimit }),
    [patientId, recentLimit],
    mayRead,
  );
  const [check, setCheck] = useState<{
    key: string;
    busy: boolean;
    result?: PreferenceCheckResponse;
    error?: string;
  } | null>(null);

  const runCheck = async (channel: NotificationChannel, purpose: NotificationPurpose) => {
    const key = `${channel}:${purpose}`;
    setCheck({ key, busy: true });
    try {
      const result = await nApi.checkPreferences({ patientId, channel, purpose });
      setCheck({ key, busy: false, result });
    } catch (e) {
      setCheck({ key, busy: false, error: asApiError(e).message });
    }
  };

  return (
    <Section
      title="Communication"
      description="Whether we may message this patient, and what we sent recently."
    >
      <Loadable state={prefs} rows={3}>
        {(p) => {
          const find = (c: string, pu: string) =>
            p.items.find((x) => x.channel === c && x.purpose === pu);
          return (
            <div className="dos-stack" data-gap="sm">
              <div style={{ overflowX: "auto" }}>
                <table className="dos-table" aria-label="Communication preferences">
                  <thead>
                    <tr>
                      <th scope="col">Purpose</th>
                      {NOTIFICATION_CHANNELS.map((c) => (
                        <th key={c} scope="col">
                          {channelLabel(c)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {NOTIFICATION_PURPOSES.map((pu) => (
                      <tr key={pu}>
                        <th scope="row">{purposeLabel(pu)}</th>
                        {NOTIFICATION_CHANNELS.map((c) => {
                          const row = find(c, pu);
                          const key = `${c}:${pu}`;
                          return (
                            <td key={c}>
                              <div className="dos-cluster">
                                <Badge tone={!row ? "neutral" : row.optIn ? "success" : "danger"}>
                                  {!row ? "Not set" : row.optIn ? "Opted in" : "Opted out"}
                                </Badge>
                                {mayRead ? (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    loading={check?.key === key && check.busy}
                                    onClick={() => void runCheck(c, pu)}
                                  >
                                    Check
                                    <span className="dos-sr-only">
                                      {" "}
                                      {purposeLabel(pu)} on {channelLabel(c)}
                                    </span>
                                  </Button>
                                ) : null}
                              </div>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div aria-live="polite">
                {check?.result ? (
                  <p style={{ margin: 0 }}>
                    <strong>
                      {purposeLabel(check.result.purpose)} on {channelLabel(check.result.channel)}:{" "}
                      {check.result.decision === "SEND" ? "would be sent" : "would not be sent"}
                    </strong>
                    . {consentReason(check.result.reason)}
                    {check.result.decision === "SEND" && !check.result.hasAddress
                      ? " There is no phone or email on file for this channel, so it would fail."
                      : ""}
                  </p>
                ) : null}
                {check?.error ? <p className="dos-error">{check.error}</p> : null}
              </div>
            </div>
          );
        }}
      </Loadable>
      {mayRead ? (
        <div className="dos-stack" data-gap="sm">
          <h3 className="dos-label" style={{ margin: 0 }}>
            Recent messages
          </h3>
          <Loadable state={recent} rows={2}>
            {(r) =>
              r.items.length === 0 ? (
                <p className="dos-muted" style={{ margin: 0 }}>
                  No messages have been sent to this patient yet.
                </p>
              ) : (
                <ul
                  className="dos-stack"
                  data-gap="sm"
                  style={{ listStyle: "none", margin: 0, padding: 0 }}
                >
                  {r.items.map((m) => (
                    <li key={m.id} className="dos-cluster">
                      <OutboxStatusChip status={m.status} />
                      <span>
                        {channelLabel(m.channel)} ·{" "}
                        <span className="dos-mono">{m.templateCode}</span>
                      </span>
                      <span className="dos-muted">{formatDateTime(m.createdAt)}</span>
                      <span className="dos-sr-only">{statusLabel(m.status)}</span>
                    </li>
                  ))}
                </ul>
              )
            }
          </Loadable>
          <Link href="/notifications" className="dos-link">
            Open the message log
          </Link>
        </div>
      ) : null}
    </Section>
  );
}
