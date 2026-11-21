import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #5148: the member work party page's own gate. The proxy gates
 * the module only, so the page's `canViewWorkParties` check is what keeps an
 * organisation account or a non-member login out; removing it must fail here,
 * not only in the API route's test. Every refusal is the same 404.
 */
const h = vi.hoisted(() => ({
  auth: vi.fn(),
  modules: { workParties: true },
  findMemberWorkParty: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`redirect:${path}`);
  }),
  notFound: vi.fn(() => {
    throw new Error("notFound");
  }),
}));
vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: vi.fn(async () => h.modules),
}));
vi.mock("@/lib/club-time/server", async () => {
  const { bindClubTime, requireClubTimeZone } = await import("@/lib/club-time");
  const { CLUB_FORMAT_TEST } = await import(
    "@/lib/__tests__/support/club-format-fixture"
  );
  const zone = requireClubTimeZone("Pacific/Auckland");
  return {
    clubTime: async () => bindClubTime(zone, CLUB_FORMAT_TEST),
    clubTodayDateOnlyInstant: async () => new Date("2026-07-01T00:00:00.000Z"),
  };
});
vi.mock("@/lib/work-party-member", () => ({
  findMemberWorkParty: h.findMemberWorkParty,
}));

import MemberWorkPartyPage from "../page";

const member = { id: "m-1", accessRoles: ["USER"], role: "USER", canLogin: true };
const workParty = {
  id: "wp-1",
  name: "Spring Working Bee",
  description: "Bring gloves",
  startDate: "2026-07-10",
  endDate: "2026-07-12",
  discountPercent: 50,
  lodgeId: "lodge-1",
  lodgeName: "Main Lodge",
  join: { checkIn: "2026-07-10", checkOut: "2026-07-13" },
};

async function render() {
  const element = await MemberWorkPartyPage({
    params: Promise.resolve({ id: "wp-1" }),
  });
  return renderToStaticMarkup(element);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.modules.workParties = true;
  h.auth.mockResolvedValue({ user: member });
  h.findMemberWorkParty.mockResolvedValue(workParty);
});

describe("/dashboard/work-parties/[id]", () => {
  it("shows a member the work party and its Join link", async () => {
    const html = await render();
    expect(html).toContain("Spring Working Bee");
    expect(html).toContain("Main Lodge");
    expect(html).toContain("50% off");
    expect(html).toContain('href="/book?workParty=wp-1"');
    expect(html).toContain("Join Work Party");
    // One h1 (the name); the card title is a level-2 heading (#4951).
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toMatch(/role="heading" aria-level="2"[^>]*>Details</);
    expect(h.findMemberWorkParty).toHaveBeenCalledWith(
      "wp-1",
      new Date("2026-07-01T00:00:00.000Z"),
    );
  });

  it("says a finished work party has finished and offers no Join", async () => {
    h.findMemberWorkParty.mockResolvedValue({ ...workParty, join: null });
    const html = await render();
    expect(html).toContain("This work party has finished.");
    expect(html).not.toContain("Join Work Party");
  });

  it("sends a visitor with no session to sign in", async () => {
    h.auth.mockResolvedValue(null);
    await expect(render()).rejects.toThrow("redirect:/login");
  });

  it.each([
    ["an organisation account", { id: "o-1", accessRoles: ["ORG"], role: "SCHOOL", canLogin: true }],
    ["a member who is also an organisation", { id: "o-2", accessRoles: ["USER", "ORG"], role: "USER", canLogin: true }],
    ["a non-member login", { id: "n-1", accessRoles: [], role: "NON_MEMBER", canLogin: true }],
    ["a login-disabled member", { ...member, canLogin: false }],
  ])("404s %s without reading the work party", async (_label, user) => {
    h.auth.mockResolvedValue({ user });
    await expect(render()).rejects.toThrow("notFound");
    expect(h.findMemberWorkParty).not.toHaveBeenCalled();
  });

  it("404s while the Work parties module is off", async () => {
    h.modules.workParties = false;
    await expect(render()).rejects.toThrow("notFound");
    expect(h.findMemberWorkParty).not.toHaveBeenCalled();
  });

  it("404s an inactive or unknown work party", async () => {
    h.findMemberWorkParty.mockResolvedValue(null);
    await expect(render()).rejects.toThrow("notFound");
  });
});
