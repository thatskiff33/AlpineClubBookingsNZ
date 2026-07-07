// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ hutLeaderLabel: "Hut Leader" }),
}));
vi.mock("@/hooks/use-scroll-to-feedback", () => ({
  useScrollToFeedback: () => ({
    scrollToError: vi.fn(),
    scrollToTop: vi.fn(),
  }),
}));

import { LodgeCapacityCard } from "@/components/admin/lodge-capacity-card";

function stubFetch(status: number, body: Record<string, unknown> = {}) {
  const fetchMock = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
  vi.stubGlobal("fetch", fetchMock);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("LodgeCapacityCard — graceful cross-area 403 (#1548)", () => {
  it("renders nothing on a 403 and shows no error box", async () => {
    stubFetch(403, { error: "Forbidden" });
    render(<LodgeCapacityCard />);

    // The card is briefly visible while loading, then unmounts to null once the
    // forbidden status resolves — never the red error box.
    await waitFor(() => {
      expect(screen.queryByText("Lodge settings")).toBeNull();
    });
    expect(screen.queryByText("Failed to load lodge settings")).toBeNull();
  });

  it("keeps the error box on a genuine 500 failure", async () => {
    stubFetch(500, {});
    render(<LodgeCapacityCard />);

    await waitFor(() => {
      expect(screen.getByText("Failed to load lodge settings")).toBeTruthy();
    });
  });
});
