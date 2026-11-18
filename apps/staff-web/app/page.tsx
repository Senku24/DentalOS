import { Badge, Button } from "@dentalos/ui";

export default function Home() {
  return (
    <main style={{ padding: "var(--space-8)" }}>
      <h1>DentalOS Staff</h1>
      <p style={{ color: "var(--color-text-muted)" }}>M0 foundation shell</p>
      <Badge tone="success">Foundation</Badge> <Button>Get started</Button>
    </main>
  );
}
