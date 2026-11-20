"use client";
import { Badge, useLink } from "@dentalos/ui";
import type { ClinicalContextResponse } from "@dentalos/validation";
import { AlertTriangle } from "lucide-react";
import { type RefObject, useEffect, useRef } from "react";
import { ageFrom, formatPhone, humanize, patientName, severityTone } from "../../lib/format";
import { canDo } from "../../lib/session";

/**
 * Sticky patient identity + allergy/alert banner (PRD 3.4). Allergies and alerts are shown only to
 * `medical:read` holders (the API redacts them otherwise); the banner says so instead of implying
 * "no allergies".
 */
export function PatientBanner({
  context,
  branchName,
}: {
  context: ClinicalContextResponse;
  branchName: (id: string | null | undefined) => string;
}) {
  const Link = useLink();
  const ref = useRef<HTMLElement>(null);
  useBannerHeight(ref);
  const p = context.patient;
  const age = ageFrom(p.dob);
  const medical = canDo("medical:read");
  const critical = [...context.allergies, ...context.alerts].some(
    (a) => a.severity === "CRITICAL" || a.severity === "HIGH",
  );
  return (
    <section ref={ref} className="cw-banner" aria-label="Patient identity and alerts">
      <div className="cw-row">
        <div style={{ minWidth: 0 }}>
          <h1 className="cw-banner__name">
            {patientName(p)}
            {p.preferredName ? (
              <span className="dos-muted" style={{ fontWeight: 400 }}>
                {" "}
                “{p.preferredName}”
              </span>
            ) : null}
          </h1>
          <div className="cw-banner__meta">
            {p.mrn ?? "No MRN"} · {age === null ? "Age unknown" : `${age} y`} · {humanize(p.sex)} ·{" "}
            {formatPhone(p.phone)} · Registered at {branchName(p.originBranchId)}
          </div>
        </div>
        {canDo("patient:read") ? (
          <Link href={`/patients/${p.id}`} className="dos-link">
            Patient record
          </Link>
        ) : null}
      </div>
      {medical ? (
        <ul className="cw-banner__alerts" aria-label="Allergies and clinical alerts">
          {critical ? (
            <li>
              <AlertTriangle
                size={16}
                aria-hidden="true"
                style={{ color: "var(--color-danger)" }}
              />
              <span className="dos-sr-only">High-severity alert present.</span>
            </li>
          ) : null}
          {context.allergies.length === 0 && context.alerts.length === 0 ? (
            <li>
              <Badge tone="success">No known allergies or alerts</Badge>
            </li>
          ) : null}
          {context.allergies.map((a) => (
            <li key={a.id}>
              <Badge tone={severityTone(a.severity)}>
                Allergy: {a.substance}
                {a.reaction ? ` (${a.reaction})` : ""} · {humanize(a.severity)}
              </Badge>
            </li>
          ))}
          {context.alerts.map((a) => (
            <li key={a.id}>
              <Badge tone={severityTone(a.severity)}>
                Alert: {a.title} · {humanize(a.severity)}
              </Badge>
            </li>
          ))}
        </ul>
      ) : (
        <p className="cw-meta" style={{ margin: 0 }}>
          Allergies, alerts and medical history are not shown for your role (needs medical:read).
        </p>
      )}
    </section>
  );
}

/**
 * Publishes the banner's height as --cw-banner-h on the root, which clinical.css turns into
 * scroll-padding-top while the banner is sticky, so focus never lands under it.
 */
function useBannerHeight(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const root = document.documentElement;
    const ro = new ResizeObserver(() =>
      root.style.setProperty("--cw-banner-h", `${Math.ceil(el.getBoundingClientRect().height)}px`),
    );
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty("--cw-banner-h");
    };
  }, [ref]);
}
