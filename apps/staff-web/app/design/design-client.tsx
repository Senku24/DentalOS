"use client";
import {
  Alert,
  Badge,
  Button,
  Card,
  type ColumnDef,
  ConfirmDialog,
  DataTable,
  Dialog,
  Drawer,
  EmptyState,
  ErrorState,
  SelectField,
  Skeleton,
  Spinner,
  StatCard,
  StatGrid,
  TextField,
  TextareaField,
  useToast,
} from "@dentalos/ui";
import { Plus, Trash2 } from "lucide-react";
import { type ReactNode, useState } from "react";

const swatches = [
  ["bg", "--color-bg"],
  ["surface", "--color-surface"],
  ["surface-muted", "--color-surface-muted"],
  ["border", "--color-border"],
  ["border-strong", "--color-border-strong"],
  ["text", "--color-text"],
  ["text-muted", "--color-text-muted"],
  ["primary", "--color-primary"],
  ["primary-hover", "--color-primary-hover"],
  ["primary-subtle", "--color-primary-subtle"],
  ["danger", "--color-danger"],
  ["warning", "--color-warning"],
  ["success", "--color-success"],
  ["info", "--color-info"],
] as const;

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} style={{ marginBottom: "var(--space-8)" }}>
      <h2 id={id} style={{ fontSize: "var(--text-lg)", marginBottom: "var(--space-3)" }}>
        {title}
      </h2>
      {children}
    </section>
  );
}
const row = {
  display: "flex",
  flexWrap: "wrap",
  gap: "var(--space-3)",
  alignItems: "center",
} as const;

interface Sample {
  id: string;
  procedure: string;
  tooth: string;
  status: string;
}
const sample: Sample[] = Array.from({ length: 14 }, (_, i) => ({
  id: String(i),
  procedure: ["Scaling", "Root canal", "Crown", "Extraction", "Filling"][i % 5] as string,
  tooth: String(11 + (i % 8)),
  status: ["Proposed", "Accepted", "In progress", "Completed"][i % 4] as string,
}));
const tone = {
  Proposed: "neutral",
  Accepted: "info",
  "In progress": "warning",
  Completed: "success",
} as const;
const cols: ColumnDef<Sample, unknown>[] = [
  { accessorKey: "procedure", header: "Procedure" },
  { accessorKey: "tooth", header: "Tooth (FDI)" },
  {
    accessorKey: "status",
    header: "Status",
    cell: ({ getValue }) => (
      <Badge tone={tone[getValue() as keyof typeof tone]}>{getValue() as string}</Badge>
    ),
  },
];

export function DesignClient() {
  const { toast } = useToast();
  const [dialog, setDialog] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [mode, setMode] = useState<"data" | "loading" | "empty" | "error">("data");

  return (
    <>
      <Section id="d-colour" title="Colour tokens">
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
            gap: "var(--space-3)",
          }}
        >
          {swatches.map(([name, v]) => (
            <div key={name} className="dos-card" style={{ padding: "var(--space-3)" }}>
              <div
                style={{
                  height: 36,
                  borderRadius: "var(--radius-sm)",
                  background: `var(${v})`,
                  border: "1px solid var(--color-border)",
                }}
              />
              <div style={{ fontSize: "var(--text-sm)", marginTop: "var(--space-2)" }}>{name}</div>
              <code style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)" }}>
                {v}
              </code>
            </div>
          ))}
        </div>
      </Section>

      <Section id="d-type" title="Typography">
        <Card>
          <div style={{ fontSize: "var(--text-2xl)", fontWeight: 600 }}>Display 2xl</div>
          <div style={{ fontSize: "var(--text-xl)", fontWeight: 600 }}>Heading xl</div>
          <div style={{ fontSize: "var(--text-lg)", fontWeight: 600 }}>Heading lg</div>
          <p style={{ fontSize: "var(--text-md)" }}>
            Body md — Treatment plan for tooth 36 proposed on 14 Nov 2026.
          </p>
          <p style={{ fontSize: "var(--text-sm)", color: "var(--color-text-muted)" }}>
            Body sm muted — Last updated by Dr. Mehta, Saket branch.
          </p>
        </Card>
      </Section>

      <Section id="d-buttons" title="Buttons">
        <div style={row}>
          <Button>Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Danger</Button>
          <Button size="sm">Small</Button>
          <Button disabled>Disabled</Button>
          <Button loading>Saving</Button>
          <Button iconOnly aria-label="Add patient">
            <Plus size={18} aria-hidden="true" />
          </Button>
        </div>
      </Section>

      <Section id="d-badges" title="Badges">
        <div style={row}>
          <Badge>Neutral</Badge>
          <Badge tone="brand">Brand</Badge>
          <Badge tone="success">Completed</Badge>
          <Badge tone="warning">Pending</Badge>
          <Badge tone="danger">Overdue</Badge>
          <Badge tone="info">Scheduled</Badge>
        </div>
      </Section>

      <Section id="d-forms" title="Form fields">
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
            gap: "var(--space-4)",
            maxWidth: 820,
          }}
        >
          <TextField label="Full name" required placeholder="e.g. Aarav Mehta" />
          <TextField label="Mobile number" hint="We send appointment reminders here" />
          <TextField
            label="Email"
            type="email"
            error="Enter a valid email address"
            defaultValue="aarav@"
          />
          <TextField label="Date of birth" disabled defaultValue="12 Mar 1991" />
          <SelectField label="Enquiry source">
            <option>Walk-in</option>
            <option>Website</option>
            <option>Referral</option>
          </SelectField>
          <TextareaField label="Clinical alerts" hint="Allergies, conditions, medications" />
        </div>
      </Section>

      <Section id="d-cards" title="Cards and stats">
        <StatGrid>
          <StatCard label="Revenue (month)" value="₹8,42,000" hint="+6% vs last month" />
          <StatCard label="No-shows" value="4.1%" hint="Target under 5%" />
          <StatCard label="Loading example" value="" loading />
        </StatGrid>
      </Section>

      <Section id="d-table" title="Data table">
        <fieldset
          style={{ ...row, marginBottom: "var(--space-3)", border: 0, padding: 0, marginInline: 0 }}
        >
          <legend className="dos-sr-only">Table state preview</legend>
          {(["data", "loading", "empty", "error"] as const).map((m) => (
            <Button
              key={m}
              size="sm"
              variant={mode === m ? "primary" : "secondary"}
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
            >
              {m}
            </Button>
          ))}
        </fieldset>
        <DataTable
          caption="Treatment plan procedures"
          columns={cols}
          data={mode === "empty" ? [] : sample}
          loading={mode === "loading"}
          error={
            mode === "error"
              ? {
                  title: "Could not load procedures",
                  description: "Check your connection and try again.",
                  action: (
                    <Button variant="secondary" onClick={() => setMode("data")}>
                      Retry
                    </Button>
                  ),
                }
              : undefined
          }
          emptyTitle="No procedures yet"
          emptyDescription="Add a procedure to start this treatment plan."
          emptyAction={<Button size="sm">Add procedure</Button>}
          pageSize={5}
          toolbarActions={
            <Button size="sm">
              <Plus size={16} aria-hidden="true" /> Add
            </Button>
          }
        />
      </Section>

      <Section id="d-overlays" title="Dialogs, drawers and toasts">
        <div style={row}>
          <Button variant="secondary" onClick={() => setDialog(true)}>
            Open dialog
          </Button>
          <Button variant="secondary" onClick={() => setDrawer(true)}>
            Open drawer
          </Button>
          <Button variant="danger" onClick={() => setConfirm(true)}>
            <Trash2 size={16} aria-hidden="true" /> Confirm destructive
          </Button>
          <Button
            variant="secondary"
            onClick={() =>
              toast({
                tone: "success",
                title: "Appointment booked",
                description: "Reminder queued for tomorrow 9:00.",
              })
            }
          >
            Success toast
          </Button>
          <Button
            variant="secondary"
            onClick={() =>
              toast({
                tone: "danger",
                title: "Payment could not be verified",
                description: "No money has been recorded. Try again.",
              })
            }
          >
            Error toast
          </Button>
        </div>
        <Dialog
          open={dialog}
          onOpenChange={setDialog}
          title="Edit branch"
          description="Changes apply to future bookings only."
          footer={
            <>
              <Button variant="secondary" onClick={() => setDialog(false)}>
                Cancel
              </Button>
              <Button onClick={() => setDialog(false)}>Save</Button>
            </>
          }
        >
          <TextField label="Branch name" defaultValue="Saket" />
        </Dialog>
        <Drawer
          open={drawer}
          onOpenChange={setDrawer}
          title="Patient summary"
          description="Quick view without leaving the list."
        >
          <p>Allergies: Penicillin. Last visit: 14 Nov 2026.</p>
        </Drawer>
        <ConfirmDialog
          open={confirm}
          onOpenChange={setConfirm}
          title="Deactivate this branch?"
          description="Staff assigned only to this branch will lose access. Historical records are kept."
          confirmLabel="Deactivate branch"
          tone="danger"
          onConfirm={() => setConfirm(false)}
        />
      </Section>

      <Section id="d-feedback" title="Feedback and states">
        <div style={{ display: "grid", gap: "var(--space-3)", maxWidth: 720 }}>
          <Alert tone="info">Your session will expire in 5 minutes.</Alert>
          <Alert tone="success">Receipt sent by WhatsApp.</Alert>
          <Alert tone="warning">Stock is low for 3 items at Noida.</Alert>
          <Alert tone="danger">This invoice is already posted and cannot be edited.</Alert>
          <div style={row}>
            <Spinner label="Loading patients" /> <Skeleton width={160} />
          </div>
          <div className="dos-card">
            <EmptyState
              title="No appointments today"
              description="Booked visits will appear here."
              action={<Button size="sm">Book appointment</Button>}
            />
          </div>
          <div className="dos-card">
            <ErrorState
              title="Something went wrong"
              description="We could not load this section."
            />
          </div>
        </div>
      </Section>
    </>
  );
}
