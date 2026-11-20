import type { ReactNode } from "react";

/** Centered single-column card for the auth pages (works at 375 px). */
export function AuthCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main
      style={{
        display: "grid",
        placeItems: "start center",
        padding: "48px 16px",
        minHeight: "60vh",
      }}
    >
      <section
        className="dos-card"
        aria-labelledby="auth-title"
        style={{ width: "100%", maxWidth: 440, display: "grid", gap: 16 }}
      >
        <h1 id="auth-title" style={{ margin: 0, fontSize: "1.25rem" }}>
          {title}
        </h1>
        {children}
      </section>
    </main>
  );
}
