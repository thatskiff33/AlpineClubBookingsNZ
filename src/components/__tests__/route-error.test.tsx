// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentType } from "react";

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock("@sentry/nextjs", () => sentry);

import AdminError from "@/app/(admin)/error";
import MemberAreaError from "@/app/(authenticated)/error";
import FinanceError from "@/app/(finance)/finance/error";
import LodgeError from "@/app/(lodge)/error";
import PublicError from "@/app/(public)/error";
import WebsiteError from "@/app/(website)/error";
import DynamicWebsiteError from "@/app/(website-dynamic)/error";
import { RouteError, routeErrorDigest } from "@/components/route-error";
import {
  ROUTE_GROUP_BOUNDARIES,
  type RouteGroupKey,
} from "@/lib/route-group-boundaries";

/**
 * Every route group's error boundary, rendered through its REAL `error.tsx`
 * (#4467). `route-group-boundaries.test.ts` proves each group has one in the
 * right place; this proves what each one does: it names its own group, its retry
 * is Next's `retry` (re-fetch and re-render, not a bare `reset`), its way back
 * stays in the group, it reports like the root boundary, and it never shows the
 * error's message — only the digest.
 */

type BoundaryProps = { error: unknown; retry: () => void };

const GROUP_BOUNDARIES: Record<RouteGroupKey, ComponentType<BoundaryProps>> = {
  admin: AdminError,
  authenticated: MemberAreaError,
  finance: FinanceError,
  lodge: LodgeError,
  public: PublicError,
  website: WebsiteError,
  websiteDynamic: DynamicWebsiteError,
};

const SECRET_MESSAGE = "relation \"Member\" leaked: password_hash=abc123";

function serverError(digest = "4213378051") {
  return Object.assign(new Error(SECRET_MESSAGE), { digest });
}

describe("route-group error boundaries (#4467)", () => {
  beforeEach(() => {
    sentry.captureException.mockClear();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("has a boundary under test for every group in the table", () => {
    expect(Object.keys(GROUP_BOUNDARIES).sort()).toEqual(
      Object.keys(ROUTE_GROUP_BOUNDARIES).sort(),
    );
  });

  for (const [area, Boundary] of Object.entries(GROUP_BOUNDARIES) as Array<
    [RouteGroupKey, ComponentType<BoundaryProps>]
  >) {
    const { homeHref, homeLabel } = ROUTE_GROUP_BOUNDARIES[area];

    describe(`${area}`, () => {
      it("names its own group, and Try again calls Next's retry exactly once", () => {
        const retry = vi.fn();
        const { container } = render(
          <Boundary error={serverError()} retry={retry} />,
        );

        expect(
          container.querySelector(`[data-route-error="${area}"]`),
        ).not.toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Try again" }));
        expect(retry).toHaveBeenCalledTimes(1);
      });

      it(`links back to ${homeHref}`, () => {
        render(<Boundary error={serverError()} retry={vi.fn()} />);

        const link = screen.getByRole("link", { name: homeLabel });
        expect(link.getAttribute("href")).toBe(homeHref);
      });

      it("reports to Sentry with the digest and the group, like the root boundary", () => {
        const error = serverError("digest-77");
        render(<Boundary error={error} retry={vi.fn()} />);

        expect(sentry.captureException).toHaveBeenCalledTimes(1);
        expect(sentry.captureException).toHaveBeenCalledWith(error, {
          tags: { digest: "digest-77", routeGroup: area },
        });
      });

      for (const nodeEnv of ["production", "development"]) {
        it(`shows the digest and never the message (NODE_ENV=${nodeEnv})`, () => {
          vi.stubEnv("NODE_ENV", nodeEnv);
          const { container } = render(
            <Boundary error={serverError("digest-42")} retry={vi.fn()} />,
          );

          expect(container.textContent).toContain("Error ID: digest-42");
          expect(container.textContent).not.toContain(SECRET_MESSAGE);
          expect(container.textContent).not.toContain("password_hash");
        });
      }
    });
  }

  it("moves focus to the heading so the failure is announced", () => {
    render(<RouteError error={serverError()} retry={vi.fn()} area="admin" />);

    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "Something went wrong" }),
    );
  });

  it("copes with a thrown value that is not an Error: no digest, no message, still recoverable", () => {
    const retry = vi.fn();
    const { container } = render(
      <RouteError error={SECRET_MESSAGE} retry={retry} area="authenticated" />,
    );

    expect(container.textContent).not.toContain("Error ID");
    expect(container.textContent).not.toContain(SECRET_MESSAGE);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(sentry.captureException).toHaveBeenCalledWith(SECRET_MESSAGE, {
      tags: { digest: undefined, routeGroup: "authenticated" },
    });
  });

  it("reads a digest only when it is a non-empty string", () => {
    expect(routeErrorDigest(serverError("abc"))).toBe("abc");
    expect(routeErrorDigest(new Error("no digest"))).toBeUndefined();
    expect(routeErrorDigest({ digest: 42 })).toBeUndefined();
    expect(routeErrorDigest({ digest: "" })).toBeUndefined();
    expect(routeErrorDigest(null)).toBeUndefined();
    expect(routeErrorDigest("digest")).toBeUndefined();
  });
});
