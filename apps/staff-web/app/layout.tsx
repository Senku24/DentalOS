import "@dentalos/ui/tokens.css";
import "@dentalos/ui/ui.css";
import type { ReactNode } from "react";
import { Providers } from "../components/providers";
import { ShellFrame } from "../components/shell-frame";

export const metadata = { title: { default: "DentalOS", template: "%s · DentalOS" } };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <ShellFrame>{children}</ShellFrame>
        </Providers>
      </body>
    </html>
  );
}
