// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

/**
 * The route-error probe's gates (#4467). The page is TEST-ONLY and runs three
 * steps in a fixed order — production gate, admin guard, cookie — and these
 * cases pin that order:
 *
 *   - in a real production runtime it is a 404 whatever the request carries,
 *     and it neither runs the guard nor reads the cookie;
 *   - outside production, a caller the admin guard refuses (signed out, or
 *     signed in without admin standing) is redirected and never reaches the
 *     cookie, so it can never make the page throw;
 *   - only an admitted admin's cookie decides between throwing and rendering.
 *
 * The production gate is the REAL `isRealProductionRuntime()`, driven through
 * the environment variables a deployment sets. The admin guard is mocked: what
 * is under test is that this page calls it and obeys it before the cookie, and
 * `admin-route-authorization-proof.test.ts` already drives the real guard over
 * every admin page on disk, this one included.
 */

const mocks = vi.hoisted(() => ({
  cookieValue: undefined as string | undefined,
  calls: [] as string[],
  guardResult: { outcome: "admitted" } as
    | { outcome: "admitted" }
    | { outcome: "redirect"; destination: string },
}));

vi.mock("next/headers", () => ({
  cookies: async () => {
    mocks.calls.push("cookies");
    return {
      get: (name: string) =>
        name === "route-error-probe" && mocks.cookieValue !== undefined
          ? { name, value: mocks.cookieValue }
          : undefined,
    };
  },
}));

vi.mock("@/lib/admin-layout-guard", () => ({
  guardAdminLayout: async () => {
    mocks.calls.push("guard");
    return mocks.guardResult;
  },
}));

class NotFoundSentinel extends Error {}
class RedirectSentinel extends Error {
  constructor(readonly destination: string) {
    super(`redirect ${destination}`);
  }
}
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new NotFoundSentinel("NEXT_NOT_FOUND (test sentinel)");
  },
  redirect: (destination: string) => {
    throw new RedirectSentinel(destination);
  },
}));

import RouteErrorProbePage from "../page";
import {
  ROUTE_ERROR_PROBE_HEADING,
  ROUTE_ERROR_PROBE_MESSAGE,
  ROUTE_ERROR_PROBE_THROW,
} from "@/lib/route-error-probe";

function stubRuntime(runtime: {
  nodeEnv: string;
  declaredRole?: "production" | "non-production";
  slot?: string;
}) {
  vi.stubEnv("NODE_ENV", runtime.nodeEnv);
  vi.stubEnv("APP_ENVIRONMENT_ROLE", runtime.declaredRole ?? "");
  vi.stubEnv("APP_RUNTIME_ROLE", runtime.slot ?? "");
}

const E2E_STACK = {
  nodeEnv: "production",
  declaredRole: "non-production",
  slot: "staging",
} as const;

describe("route-error probe page (#4467)", () => {
  beforeEach(() => {
    mocks.cookieValue = undefined;
    mocks.calls = [];
    mocks.guardResult = { outcome: "admitted" };
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("is unreachable in a real production runtime", () => {
    const productionRuntimes = [
      {
        label: "a deployment that declares production",
        runtime: { nodeEnv: "production", declaredRole: "production", slot: "web-blue" },
      },
      {
        label: "a declared production even in a development build",
        runtime: { nodeEnv: "development", declaredRole: "production" },
      },
      {
        label: "an UNDECLARED production build in a live slot (the backstop)",
        runtime: { nodeEnv: "production", slot: "web-green" },
      },
      {
        label: "an undeclared production build with no slot at all",
        runtime: { nodeEnv: "production" },
      },
    ] as const;

    for (const { label, runtime } of productionRuntimes) {
      it(`404s for ${label}, even with the throw cookie, running neither the guard nor the cookie read`, async () => {
        stubRuntime(runtime);
        mocks.cookieValue = ROUTE_ERROR_PROBE_THROW;

        await expect(RouteErrorProbePage()).rejects.toBeInstanceOf(
          NotFoundSentinel,
        );
        expect(mocks.calls).toEqual([]);
      });
    }
  });

  describe("outside production, a caller the admin guard refuses", () => {
    for (const [label, destination] of [
      ["a signed-out request", "/login?callbackUrl=%2Fadmin%2Ftesting%2Froute-error"],
      ["a signed-in member without admin standing", "/dashboard"],
    ] as const) {
      it(`redirects ${label} and never reads the throw cookie`, async () => {
        stubRuntime(E2E_STACK);
        mocks.guardResult = { outcome: "redirect", destination };
        mocks.cookieValue = ROUTE_ERROR_PROBE_THROW;

        const outcome = RouteErrorProbePage();
        await expect(outcome).rejects.toBeInstanceOf(RedirectSentinel);
        await expect(outcome).rejects.toMatchObject({ destination });
        expect(mocks.calls).toEqual(["guard"]);
      });
    }
  });

  describe("for an admitted admin on the E2E stack", () => {
    beforeEach(() => {
      stubRuntime(E2E_STACK);
    });

    it("throws its fixed message while the throw cookie is set, after the guard", async () => {
      mocks.cookieValue = ROUTE_ERROR_PROBE_THROW;

      await expect(RouteErrorProbePage()).rejects.toThrow(
        ROUTE_ERROR_PROBE_MESSAGE,
      );
      expect(mocks.calls).toEqual(["guard", "cookies"]);
    });

    it("renders normally without the cookie, which is what a retry sees", async () => {
      render(await RouteErrorProbePage());

      expect(
        screen.getByRole("heading", { name: ROUTE_ERROR_PROBE_HEADING }),
      ).toBeTruthy();
    });

    it("ignores any other cookie value", async () => {
      mocks.cookieValue = "1";

      render(await RouteErrorProbePage());

      expect(
        screen.getByRole("heading", { name: ROUTE_ERROR_PROBE_HEADING }),
      ).toBeTruthy();
    });
  });

  it("is available to an admitted admin under next dev (development build, nothing declared)", async () => {
    stubRuntime({ nodeEnv: "development" });
    mocks.cookieValue = ROUTE_ERROR_PROBE_THROW;

    await expect(RouteErrorProbePage()).rejects.toThrow(
      ROUTE_ERROR_PROBE_MESSAGE,
    );
  });
});
