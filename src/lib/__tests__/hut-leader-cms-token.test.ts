import { beforeEach, describe, expect, it, vi } from "vitest";

// Follow-up to #1320 / PR #1335: the configurable hut-leader label is now
// available to seeded/CMS page content through the {{hut-leader}} and
// {{hut-leader-lower}} text tokens. These tokens resolve through the same
// server-side path as {{club-name}} (resolveTextTokens / buildEmbeddedBody),
// so this file mirrors src/lib/__tests__/page-content-embeds.test.ts: a mutable
// identity getter lets us vary CLUB_HUT_LEADER_LABEL and prove the rendered
// output tracks the configured label, defaulting to "Hut Leader".

vi.mock("server-only", () => ({}));

const identityState = vi.hoisted(() => ({
  hutLeaderLabel: "Hut Leader",
}));

vi.mock("@/config/club-identity", () => ({
  CLUB_NAME: "Club Name",
  CLUB_FACEBOOK_URL: undefined,
  CLUB_PUBLIC_URL: "https://club.example.org",
}));
// {{hut-leader}}/{{club-name}} now resolve DB-first via getClubIdentity (E3
// #1929); the mutable label drives the mocked identity.
vi.mock("@/lib/club-identity-settings", () => ({
  getClubIdentity: vi.fn(async () => ({
    name: "Club Name",
    get hutLeaderLabel() {
      return identityState.hutLeaderLabel;
    },
  })),
}));
vi.mock("@/config/operational", () => ({ APP_CURRENCY: "NZD", APP_STRIPE_CURRENCY: "nzd", APP_TIME_ZONE: "Pacific/Auckland", APP_LOCALE: "en-NZ" }));
vi.mock("@/lib/lodge-capacity", () => ({
  getLodgeCapacity: vi.fn(async () => 42),
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { buildEmbeddedBody, resolveTextTokens } from "../page-content-embeds";

beforeEach(() => {
  identityState.hutLeaderLabel = "Hut Leader";
});

describe("hut-leader CMS token resolution (#1320 follow-up)", () => {
  it("renders the default label in rendered page content", async () => {
    const parts = await buildEmbeddedBody(
      "<p>The {{hut-leader}} assigns chores; ask your {{hut-leader-lower}}.</p>",
    );

    expect(parts).toEqual([
      {
        type: "html",
        value: "<p>The Hut Leader assigns chores; ask your hut leader.</p>",
      },
    ]);
  });

  it("renders a custom label (Warden) in rendered page content", async () => {
    identityState.hutLeaderLabel = "Warden";

    const parts = await buildEmbeddedBody(
      "<p>The {{hut-leader}} assigns chores; ask your {{hut-leader-lower}}.</p>",
    );

    expect(parts).toEqual([
      {
        type: "html",
        value: "<p>The Warden assigns chores; ask your warden.</p>",
      },
    ]);
  });

  it("resolves the standalone token to the configured label", async () => {
    expect(await resolveTextTokens("{{hut-leader}}")).toBe("Hut Leader");
    expect(await resolveTextTokens("{{hut-leader-lower}}")).toBe("hut leader");

    identityState.hutLeaderLabel = "Duty Manager";
    expect(await resolveTextTokens("{{hut-leader}}")).toBe("Duty Manager");
    expect(await resolveTextTokens("{{hut-leader-lower}}")).toBe(
      "duty manager",
    );
  });

  it("is case-insensitive and whitespace tolerant like other text tokens", async () => {
    identityState.hutLeaderLabel = "Warden";
    expect(await resolveTextTokens("{{ HUT-LEADER }}")).toBe("Warden");
    expect(await resolveTextTokens("{{ Hut-Leader-Lower }}")).toBe("warden");
  });

  it("HTML-escapes the resolved label", async () => {
    identityState.hutLeaderLabel = "Warden & Guide";
    expect(await resolveTextTokens("{{hut-leader}}")).toBe(
      "Warden &amp; Guide",
    );
  });
});
