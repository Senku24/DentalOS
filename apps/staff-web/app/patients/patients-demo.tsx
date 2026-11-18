"use client";
import { Alert, Badge, type ColumnDef, DataTable } from "@dentalos/ui";

interface Row {
  id: string;
  name: string;
  phone: string;
  branch: string;
  lastVisit: string;
  balance: number;
}
const data: Row[] = [
  ["Aarav Mehta", "98•••• 2210", "Saket", "2026-11-14", 0],
  ["Isha Kapoor", "99•••• 8841", "Gurugram", "2026-11-12", 4500],
  ["Rohan Gupta", "98•••• 1175", "Saket", "2026-11-09", 0],
  ["Meera Nair", "97•••• 6620", "Noida", "2026-10-30", 12000],
  ["Kabir Singh", "99•••• 3098", "Saket", "2026-10-21", 0],
  ["Ananya Rao", "98•••• 7714", "Gurugram", "2026-10-02", 800],
].map(([name, phone, branch, lastVisit, balance], i) => ({
  id: `p${i}`,
  name: name as string,
  phone: phone as string,
  branch: branch as string,
  lastVisit: lastVisit as string,
  balance: balance as number,
}));

const inr = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});

const columns: ColumnDef<Row, unknown>[] = [
  { accessorKey: "name", header: "Patient" },
  { accessorKey: "phone", header: "Phone", enableSorting: false },
  { accessorKey: "branch", header: "Last branch" },
  { accessorKey: "lastVisit", header: "Last visit" },
  {
    accessorKey: "balance",
    header: "Outstanding",
    cell: ({ getValue }) => {
      const v = getValue() as number;
      return v > 0 ? (
        <Badge tone="warning">{inr.format(v)} due</Badge>
      ) : (
        <Badge tone="success">Settled</Badge>
      );
    },
  },
];

export function PatientsDemo() {
  return (
    <div style={{ display: "grid", gap: "var(--space-4)" }}>
      <Alert tone="info">
        Sample rows to exercise the table. Real patient data arrives with M1.
      </Alert>
      <DataTable
        caption="Patients"
        columns={columns}
        data={data}
        getRowId={(r) => r.id}
        emptyTitle="No patients yet"
      />
    </div>
  );
}
