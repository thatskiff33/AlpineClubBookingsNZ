"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // OBS-02: Report to Sentry with error digest for correlation
    Sentry.captureException(error, {
      tags: { digest: error.digest },
    });
    console.error("Global error:", error);
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
            fontFamily: "system-ui, sans-serif",
            backgroundColor: "#f9fafb",
          }}
        >
          <div style={{ textAlign: "center", maxWidth: "28rem", padding: "1rem" }}>
            <h1
              style={{
                fontSize: "3.75rem",
                fontWeight: "bold",
                color: "#111827",
                marginBottom: "1rem",
              }}
            >
              500
            </h1>
            <h2
              style={{
                fontSize: "1.5rem",
                fontWeight: "600",
                color: "#374151",
                marginBottom: "1rem",
              }}
            >
              Something went wrong
            </h2>
            <p style={{ color: "#6b7280", marginBottom: "2rem" }}>
              A critical error occurred. Please try refreshing the page.
            </p>
            <button
              onClick={reset}
              style={{
                padding: "0.75rem 1.5rem",
                backgroundColor: "#111827",
                color: "white",
                border: "none",
                borderRadius: "0.5rem",
                cursor: "pointer",
                fontSize: "1rem",
              }}
            >
              Try Again
            </button>
            {error.digest && (
              <p style={{ marginTop: "1.5rem", fontSize: "0.75rem", color: "#9ca3af" }}>
                Error ID: {error.digest}
              </p>
            )}
          </div>
        </div>
      </body>
    </html>
  );
}
