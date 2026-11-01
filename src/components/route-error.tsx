"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import * as Sentry from "@sentry/nextjs";
import { AlertTriangle } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  ROUTE_GROUP_BOUNDARIES,
  type RouteGroupKey,
} from "@/lib/route-group-boundaries";

export type RouteErrorProps = {
  /**
   * The value Next hands an `error.tsx`. Typed `unknown` on purpose: a Server
   * Component error arrives as an `Error` carrying a `digest`, but a value thrown
   * from a Client Component is passed through as-is and need not be an `Error`
   * at all (`error.md`, "Props → error").
   */
  error: unknown;
  /**
   * Next's `retry` (stable since 16.3): re-fetches the segment from the server
   * and re-renders it — `router.refresh()` and a boundary reset inside one
   * transition. `reset` alone would only re-render what the client already
   * holds, which for a Server Component error is the same failed payload, so a
   * "Try again" wired to it looks like it works and never can.
   */
  retry: () => void;
  /** Which route group this boundary belongs to. */
  area: RouteGroupKey;
};

/**
 * The digest Next attaches to a Server Component error, if there is one. It is
 * the only part of the error shown to anybody: it matches the server-side log
 * line and the Sentry event, and it carries no detail of its own.
 */
export function routeErrorDigest(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("digest" in error)) {
    return undefined;
  }
  const { digest } = error as { digest?: unknown };
  return typeof digest === "string" && digest.length > 0 ? digest : undefined;
}

/**
 * The shared body of every route group's `error.tsx` (#4467).
 *
 * It renders INSIDE the group's layout, so the navigation an officer or member
 * was using stays on screen and only the failed page is replaced. It reports the
 * error the way the root boundary (`src/app/error.tsx`) does — Sentry with the
 * digest for correlation, plus the console — and adds the route group as a tag.
 *
 * It NEVER renders `error.message` or a stack, in any environment. In a
 * production build a Server Component error's message is already replaced by
 * Next, but a value thrown from a Client Component arrives with its original
 * message intact, so the rule is enforced here rather than trusted to the
 * framework. The digest is the only reference shown.
 *
 * Focus moves to the heading when the boundary appears, so a keyboard or
 * screen-reader user who triggered the failure (a navigation, a refresh) is told
 * what happened rather than left on a control that no longer exists.
 */
export function RouteError({ error, retry, area }: RouteErrorProps) {
  const { homeHref, homeLabel } = ROUTE_GROUP_BOUNDARIES[area];
  const digest = routeErrorDigest(error);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    // OBS-02: report to Sentry with the error digest for correlation, matching
    // the root boundary, and name the route group the failure surfaced in.
    Sentry.captureException(error, {
      tags: { digest, routeGroup: area },
    });
    console.error("Route error:", error);
  }, [error, digest, area]);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <div
      className="mx-auto flex max-w-lg flex-col items-center px-4 py-16 text-center"
      data-route-error={area}
    >
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <AlertTriangle aria-hidden="true" className="h-6 w-6" />
      </span>
      <h1
        ref={headingRef}
        tabIndex={-1}
        className="mt-4 text-2xl font-semibold text-foreground focus:outline-none"
      >
        Something went wrong
      </h1>
      <p className="mt-3 text-sm text-muted-foreground">
        This page could not be shown. Try again, or go back and carry on from
        there. If it keeps happening, let the club know
        {digest ? " and quote the error ID below" : ""}.
      </p>
      <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:justify-center">
        <Button type="button" onClick={() => retry()}>
          Try again
        </Button>
        <Button asChild variant="outline">
          <Link href={homeHref}>{homeLabel}</Link>
        </Button>
      </div>
      {digest ? (
        <p className="mt-6 text-sm text-muted-foreground">
          Error ID: <code className="font-mono">{digest}</code>
        </p>
      ) : null}
    </div>
  );
}
