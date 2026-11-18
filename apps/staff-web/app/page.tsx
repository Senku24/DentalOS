import { Alert, Badge, Card, PageHeader, StatCard, StatGrid } from "@dentalos/ui";

export const metadata = { title: "Dashboard" };

export default function Dashboard() {
  return (
    <>
      <PageHeader title="Dashboard" description="Today across your selected branch" />
      <div style={{ display: "grid", gap: "var(--space-6)" }}>
        <Alert tone="info">
          Sample figures. Live branch and organisation metrics arrive with M4 (analytics).
        </Alert>
        <StatGrid>
          <StatCard label="Appointments today" value="24" hint="18 completed · 6 remaining" />
          <StatCard label="Waiting now" value="3" hint="Longest wait 12 min" />
          <StatCard label="Collections today" value="₹1,42,500" hint="₹38,000 outstanding" />
          <StatCard label="New patients (7d)" value="31" hint="+12% vs previous week" />
        </StatGrid>
        <Card as="section">
          <h2 style={{ fontSize: "var(--text-lg)", marginBottom: "var(--space-3)" }}>
            Build status
          </h2>
          <p style={{ color: "var(--color-text-muted)", margin: 0 }}>
            <Badge tone="brand">M0</Badge> Foundation, design system and app shell. Modules appear
            in the navigation as they ship.
          </p>
        </Card>
      </div>
    </>
  );
}
