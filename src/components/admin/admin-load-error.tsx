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
  const [retrying, setRetrying] = useState(false);

  async function retry() {
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  }

  return (
    <Alert variant="error" title={title} data-testid={testId}>
      <p>{message}</p>
      {children}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-2"
        disabled={retrying}
        onClick={retry}
      >
        Try again
      </Button>
    </Alert>
  );
}
