// #3474 — the member lodge roster PAGE: the module gate, and the held-night
// row the owner decided to show (6 Oct 2026, "Show holds on roster").
//
// ENFORCES INV-PRIV-017 at the surface. The builder's payload is pinned by
// `member-lodge-roster-privacy.test.ts`; this file covers the two things only
// the page decides — that a club without the module never reaches the builder
// (so its members see exactly what they saw before #3474), and that a held
// night is drawn as one unattributed row.
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  session: { user: { id: "viewer-1" } } as Record<string, unknown> | null,
  moduleFlags: { memberLodgeRoster: true } as Record<string, boolean>,
  buildMemberLodgeRoster: vi.fn(),
}));

class NotFoundError extends Error {}

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new NotFoundError("NEXT_NOT_FOUND");
  },
}));

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(async () => mocks.session),
}));

vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: vi.fn(async () => mocks.moduleFlags),
}));

vi.mock("@/lib/club-format-server", () => ({
  clubFormatValues: vi.fn(async () => ({ locale: "en-NZ", currency: "NZD" })),
}));

vi.mock("@/lib/member-lodge-roster", () => ({
  ROSTER_WINDOW_DAYS: 30,
  buildMemberLodgeRoster: mocks.buildMemberLodgeRoster,
}));

import LodgeRosterPage from "@/app/(authenticated)/lodge-roster/page";

function lodge(overrides: Record<string, unknown> = {}) {
  return {
    lodgeId: "lodge-a",
    lodgeName: "Alpha",
    granularity: "FULL_NAME",
    people: [],
    groups: [],
    custodians: [],
    heldNights: [],
    ...overrides,
  };
}

async function render(): Promise<string> {
  const element = (await LodgeRosterPage()) as ReactElement;
  return renderToStaticMarkup(element);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session = { user: { id: "viewer-1" } };
  mocks.moduleFlags = { memberLodgeRoster: true };
});

describe("lodge roster page — a club without the roster", () => {
  it("is Not Found and never builds a roster, so no held night is read", async () => {
    mocks.moduleFlags = { memberLodgeRoster: false };
    await expect(LodgeRosterPage()).rejects.toBeInstanceOf(NotFoundError);
    expect(
      mocks.buildMemberLodgeRoster,
      "INV-PRIV-017 / #3474: the hold reversal is for roster clubs ONLY; with the module off nothing may be read."
    ).not.toHaveBeenCalled();
  });
});

describe("lodge roster page — whole-lodge held nights (#3474)", () => {
  it("states held nights as one private-booking row, naming nobody", async () => {
    mocks.buildMemberLodgeRoster.mockResolvedValue({
      from: "2026-07-01",
      to: "2026-07-31",
      lodges: [
        lodge({ heldNights: ["2026-07-12", "2026-07-13", "2026-07-14"] }),
      ],
    });

    const html = await render();
    expect(html).toContain("Reserved for a private booking");
    expect(html).toContain("whole lodge");
    // A held night must not be reported as an empty lodge.
    expect(html).not.toContain("Nobody is booked in");
  });

  it("draws no held-night row when the lodge has none", async () => {
    mocks.buildMemberLodgeRoster.mockResolvedValue({
      from: "2026-07-01",
      to: "2026-07-31",
      lodges: [lodge()],
    });

    const html = await render();
    expect(html).not.toContain("Reserved for a private booking");
    expect(html).toContain("Nobody is booked in");
  });
});
