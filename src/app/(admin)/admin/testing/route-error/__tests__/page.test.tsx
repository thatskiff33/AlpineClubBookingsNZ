// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

/**
 * The route-error probe's gate (#4467). The page is TEST-ONLY: in a real
 * production runtime it must be a 404 whatever the request carries, and it must
 * not even read the request. These cases drive the real `isRealProductionRuntime()`
 * through the same environment variables a deployment sets, rather than mocking
 * the gate, so a change to the gate's wiring in the page is what fails here.
 */

const mocks = vi.hoisted(() => ({
  cookieValue: undefined as string | undefined,
  cookiesRead: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => {
    mocks.cookiesRead();
    return {
      get: (name: string) =>
        name === "route-error-probe" && mocks.cookieValue !== undefined
          ? { name, value: mocks.cookieValue }
          : undefined,
    };
  },
}));

const NOT_FOUND = new Error("NEXT_NOT_FOUND (test sentinel)");
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw NOT_FOUND;
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

describe("route-error probe page (#4467)", () => {
  beforeEach(() => {
    mocks.cookieValue = undefined;
    mocks.cookiesRead.mockClear();
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
      it(`404s for ${label}, even with the throw cookie, and never reads it`, async () => {
        stubRuntime(runtime);
        mocks.cookieValue = ROUTE_ERROR_PROBE_THROW;

        await expect(RouteErrorProbePage()).rejects.toBe(NOT_FOUND);
        expect(mocks.cookiesRead).not.toHaveBeenCalled();
      });
    }
  });

  describe("on the E2E stack (production build, declared non-production, staging slot)", () => {
    beforeEach(() => {
      stubRuntime({
        nodeEnv: "production",
        declaredRole: "non-production",
        slot: "staging",
      });
    });

    it("throws its fixed message while the throw cookie is set", async () => {
      mocks.cookieValue = ROUTE_ERROR_PROBE_THROW;

      await expect(RouteErrorProbePage()).rejects.toThrow(
        ROUTE_ERROR_PROBE_MESSAGE,
      );
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

  it("is available under next dev (development build, nothing declared)", async () => {
    stubRuntime({ nodeEnv: "development" });
    mocks.cookieValue = ROUTE_ERROR_PROBE_THROW;

    await expect(RouteErrorProbePage()).rejects.toThrow(
      ROUTE_ERROR_PROBE_MESSAGE,
    );
  });
});
