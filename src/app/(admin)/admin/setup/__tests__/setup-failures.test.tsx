// @vitest-environment jsdom

/**
 * A refused setup load, progress write, finish or provider test says why
 * (#4976, ALP-589).
 *
 * The load and the provider test parsed the reply as JSON with no catch, and
 * every handler showed `err.message`, so an HTML 502 from the proxy read as a
 * JSON parse error and a dropped connection as "Failed to fetch".
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { itShowsEveryRefusal } from "@/lib/__tests__/support/failed-write-cases";
import { MODULE_KEYS } from "@/config/modules";
import type { FeatureFlags } from "@/config/schema";
import { emptyAdminPermissionMatrix } from "@/lib/admin-permissions";

vi.mock("@/components/admin/lodge-capacity-card", () => ({
  LodgeCapacityCard: () => null,
}));

import { SetupPageClient } from "../setup-page-client";

const setupBody = {
  readiness: {
    status: "warning",
    summary: { total: 1, complete: 0, warning: 1, blocked: 0, skipped: 0 },
    categories: [
      {
        id: "providers",
        title: "Providers",
        description: "Provider connections.",
        status: "warning",
        checks: [
          {
            id: "smtp",
            title: "Email delivery",
            description: "Outgoing email.",
            status: "warning",
            required: false,
            message: "Email delivery was not checked.",
            details: [],
            progress: "open",
            action: { type: "provider-test", provider: "smtp", label: "Test email" },
          },
        ],
      },
    ],
    generatedAt: "2026-07-01T00:00:00.000Z",
  },
  progress: { completedStepIds: [], skippedStepIds: [], completedAt: null, completedByMemberId: null },
};

const allOn = Object.fromEntries(MODULE_KEYS.map((key) => [key, true])) as FeatureFlags;

type Answer = () => Response | Promise<Response>;

function installFetch({ load, progress, providerTest }: { load?: Answer; progress?: Answer; providerTest?: Answer }) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/admin/setup/progress") return (progress ?? (() => Response.json({ ok: true })))();
    if (url === "/api/admin/setup/provider-test") {
      return (providerTest ?? (() => Response.json({ ok: true, provider: "smtp", checkedAt: "2026-07-01T00:00:00.000Z", message: "Email delivery works." })))();
    }
    return (load ?? (() => Response.json(setupBody)))();
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderSetup() {
  render(<SetupPageClient permissionMatrix={emptyAdminPermissionMatrix()} features={allOn} />);
}

async function press(name: string) {
  renderSetup();
  fireEvent.click(await screen.findByRole("button", { name }));
}

const setupLoads = (fetchMock: ReturnType<typeof installFetch>) =>
  fetchMock.mock.calls.filter(([input]) => String(input) === "/api/admin/setup");

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("setup page refusals", () => {
  describe("loading setup readiness", () => {
    itShowsEveryRefusal({
      fallback: "Failed to load setup readiness",
      submit: async (answer) => {
        installFetch({ load: answer });
        renderSetup();
      },
    });
  });

  describe("acknowledging a step", () => {
    itShowsEveryRefusal({
      fallback: "Failed to update setup progress",
      submit: async (answer) => {
        installFetch({ progress: answer });
        await press("Acknowledge");
      },
    });

    it("reloads readiness on success", async () => {
      const fetchMock = installFetch({});
      await press("Acknowledge");

      await waitFor(() => expect(setupLoads(fetchMock)).toHaveLength(2));
    });
  });

  describe("finishing setup", () => {
    itShowsEveryRefusal({
      fallback: "Failed to finish setup",
      submit: async (answer) => {
        installFetch({ progress: answer });
        await press("Mark Setup Complete");
      },
    });
  });

  describe("testing a provider", () => {
    itShowsEveryRefusal({
      fallback: "Provider test failed",
      submit: async (answer) => {
        installFetch({ providerTest: answer });
        await press("Test email");
      },
    });

    it("shows the result and reloads readiness on success", async () => {
      const fetchMock = installFetch({});
      await press("Test email");

      expect(await screen.findByText("Email delivery works.")).toBeInTheDocument();
      await waitFor(() => expect(setupLoads(fetchMock)).toHaveLength(2));
    });
  });
});
