/**
 * Public surface of the billing UI for other areas (the commander mounts the finance tab in the patient profile).
 * Importing this file also needs `components/billing/billing.css` somewhere on the route; the finance tab uses
 * the `bil-` classes (add `import "../../../components/billing/billing.css"` to the host layout or page).
 */
export { PatientFinanceTab } from "./patient-finance";
export { PaymentDrawer } from "./payment-drawer";
export { InvoiceStatusBadge, Money } from "./bits";
