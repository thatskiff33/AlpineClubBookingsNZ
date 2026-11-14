"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

/**
 * The third outcome of an admin read: not "rows" and not "no rows", but "we
 * could not find out" (#4961).
 *
 * A list that failed to load used to render as its own empty state ("No
 * payments found", $0.00 totals, "No hut leader assignments yet"), or kept the
 * previous query's rows under the new filters. Both read as a real answer. A
 * page that loads data renders this INSTEAD of its empty state while its load
 * error is set, and clears its stale rows and totals on the same failure.
 *
 * The sentence comes from the caller, read through `@/lib/api-error-message`
 * or `@/lib/admin-query-error` — this component never reads a response itself.
 * It is an error `Alert`, so it carries `role="alert"` and is announced when it
 * appears.
 *
 * Try again keeps keyboard focus while it runs. The button is `aria-disabled`,
 * never `disabled` (a disabled button drops focus and does not get it back),
 * and a click on it is ignored. A failed retry leaves the alert's words
 * unchanged, which a live region does not announce, so a separate polite status
 * says "Trying again." and then that it still could not be loaded. A page must
 * keep this mounted while its retry is in flight: it clears its error only when
 * the read succeeds, and must not swap to a "Loading..." branch meanwhile.
 */
export function AdminLoadError({
  title,
  message,
  onRetry,
  children,
  "data-testid": testId,
}: {
  /** What could not be loaded, as a heading: "Payments could not be loaded". */
  title: string;
  /** Why, in a sentence the admin can act on. */
  message: string;
  /** Re-runs the page's own load; the page clears the error when it succeeds. */
  onRetry: () => unknown;
  /** An extra line under the reason, such as where a refused filter is. */
  children?: ReactNode;
  "data-testid"?: string;
}) {
  // "failed" is reached only when this is still mounted after the retry
  // settled: on success the page clears its error and unmounts it.
  const [retry, setRetry] = useState<"idle" | "running" | "failed">("idle");
  const running = retry === "running";

  async function handleRetry() {
    if (running) return;
    setRetry("running");
    try {
      await onRetry();
    } finally {
      setRetry("failed");
    }
  }

  return (
    <>
      <Alert variant="error" title={title} data-testid={testId}>
        <p>{message}</p>
        {children}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-2 aria-disabled:opacity-50"
          aria-disabled={running || undefined}
          onClick={handleRetry}
        >
          Try again
        </Button>
      </Alert>
      <p role="status" aria-live="polite" className="sr-only">
        {running ? "Trying again." : retry === "failed" ? "Still could not be loaded." : ""}
      </p>
    </>
  );
}
