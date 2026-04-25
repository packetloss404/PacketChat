"use client";

import { useEffect } from "react";

type GlobalErrorProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

export default function GlobalError({ error, reset }: GlobalErrorProps) {
  useEffect(() => {
    if (typeof console !== "undefined") {
      console.error("PacketChat global error", error);
    }
  }, [error]);

  return (
    <html lang="en">
      <body>
        <div
          style={{
            minHeight: "100vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
            fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
            background: "#0b0d10",
            color: "#e6e8eb"
          }}
        >
          <section
            style={{
              maxWidth: 520,
              width: "100%",
              padding: 24,
              borderRadius: 12,
              border: "1px solid #2a2f36",
              background: "#13161a"
            }}
          >
            <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.7 }}>
              PacketChat
            </div>
            <h1 style={{ margin: "8px 0 12px", fontSize: 22 }}>Something went wrong</h1>
            <p style={{ margin: "0 0 16px", color: "#aab1bb" }}>
              {error.message || "An unexpected error occurred while rendering this page."}
              {error.digest ? <span style={{ display: "block", fontSize: 12, opacity: 0.7, marginTop: 6 }}>Reference: {error.digest}</span> : null}
            </p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={() => reset()}
                style={{
                  padding: "8px 14px",
                  borderRadius: 8,
                  border: "1px solid #3a4049",
                  background: "#1c2026",
                  color: "#e6e8eb",
                  cursor: "pointer"
                }}
              >
                Try again
              </button>
              <a
                href="/"
                style={{
                  padding: "8px 14px",
                  borderRadius: 8,
                  border: "1px solid #3a4049",
                  background: "transparent",
                  color: "#e6e8eb",
                  textDecoration: "none"
                }}
              >
                Back to home
              </a>
            </div>
          </section>
        </div>
      </body>
    </html>
  );
}
