"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";
import "./display.css";

// Route-segment last resort for the /display surface (issue hoppers99/AlpineClubBookingsNZ#176, ADR-003 §5
// "Unattended surface"). The in-tree React boundaries (LayoutErrorBoundary /
// AreaErrorBoundary in display-screen.tsx) catch render throws inside the board
// and drop to the FallbackBoard or the minimal shell; THIS boundary is the
// framework-level backstop for anything that escapes them — a throw during the
// lifecycle hook, before a board is chosen, or in a boundary's own fallback.
//
// It renders with ZERO data dependencies (no payload, no modules, no template)
// so it can never itself throw, and it keeps the wall on the branded dark
// background — never a blank/white error page — matching the FallbackBoard's
// visual language. A real wall stays silent (an unattended screen shows no error
// text); the dark shell just marks the screen as intentionally on. The critical
// background is inlined so the shell holds even if the route stylesheet has not
// applied. No auto-reset: a persistent render throw must not hot-loop an
// unattended screen, so it parks on the quiet shell until the page reloads —
// exactly the non-resetting stance the in-tree boundaries already take.
export default function DisplayError({
  error,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // OBS-02: report to Sentry with the error digest for correlation, matching
    // the app-level error boundaries.
    Sentry.captureException(error, {
      tags: { digest: error.digest, surface: "display" },
    });
    console.error("Display surface error:", error);
  }, [error]);

  return (
    <div
      className="display-shell display-loading"
      data-display-fallback="error"
      style={{
        position: "fixed",
        inset: 0,
        background:
          "linear-gradient(160deg, #08171d 0%, #0a1c23 55%, #07141a 100%)",
      }}
    />
  );
}
