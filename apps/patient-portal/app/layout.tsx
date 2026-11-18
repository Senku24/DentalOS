import "@dentalos/ui/tokens.css";
import "@dentalos/ui/ui.css";
import type { ReactNode } from "react";

export const metadata = { title: "DentalOS Patient Portal" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
