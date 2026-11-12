// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "@/lib/__tests__/support/club-time-render";
import type { ClubIdentity } from "@/config/club-identity-types";

/**
 * #4951 — client pages that fetch before they can show their card still have
 * exactly one level-1 heading while they wait, and when the fetch fails. Those
 * states show no visible title, so the h1 is screen-reader-only.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/lib/use-age-tier-options", () => ({ useAgeTierOptions: () => [] }));
vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ hutLeaderLabel: "Hut Leader" }),
}));

import LodgeInstructionsPage from "../(authenticated)/lodge-instructions/page";
import { GroupJoinPageClient } from "../(website-dynamic)/join/[code]/group-join-page-client";
import { MemberGroupJoinPanel } from "../(website-dynamic)/join/[code]/member-group-join-panel";

function expectOneLevelOneHeading(name: string) {
  const headings = screen.getAllByRole("heading", { level: 1 });
  expect(headings).toHaveLength(1);
  expect(headings[0]).toHaveAccessibleName(name);
}

function stubPendingFetch() {
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("/join/[code] while the group loads", () => {
  it("non-member form", () => {
    stubPendingFetch();
    render(
      <GroupJoinPageClient club={{ name: "Test Alpine Club" } as ClubIdentity} code="ABC123" />
    );
    expectOneLevelOneHeading("Join a group booking");
  });

  it("member panel", () => {
    stubPendingFetch();
    render(<MemberGroupJoinPanel code="ABC123" />);
    expectOneLevelOneHeading("Join a group booking");
  });
});

describe("/lodge-instructions", () => {
  it("loading", () => {
    stubPendingFetch();
    render(<LodgeInstructionsPage />);
    expectOneLevelOneHeading("Lodge Instructions");
  });

  it("failed to load", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 500 })));
    render(<LodgeInstructionsPage />);
    await screen.findByText(/failed to load the lodge instructions/i);
    expectOneLevelOneHeading("Lodge Instructions");
  });
});
