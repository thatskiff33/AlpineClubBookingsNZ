// @vitest-environment jsdom

/**
 * Which filter the public-requests tab opens on, read from the link's query.
 *
 * The "Quote accepted, ready for approval" email links this tab on the
 * Accepted filter. It once named the filter `filter=ACCEPTED` while the panel
 * reads `status`, so officers landed on the default Queue. The email test
 * proves the emailed link reads back as ACCEPTED through the panel's reader;
 * this file proves the mounted panel acts on that same link, so neither half
 * can drift without a failure here.
 */
import { render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PublicBookingRequestsPanel } from "@/components/admin/booking-requests/public-booking-requests-panel";
import { buildPublicBookingRequestsHref } from "@/lib/admin-booking-requests-path";

const h = vi.hoisted(() => ({ search: "", replace: vi.fn() }));

// next/navigation: the panel replaces the URL in an effect and reads params.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: h.replace, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(h.search),
}));

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ hutLeaderLabel: "Hut Leader" }),
  ClubIdentityProvider: ({ children }: { children: ReactNode }) => children,
}));

function renderPanelOpenedWith(search: string) {
  h.search = search;
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ data: [] }),
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  render(<PublicBookingRequestsPanel />);
  return fetchMock;
}

/** The query string of a link the way the browser hands it to the page. */
function queryOf(href: string) {
  return new URL(href, "http://localhost").search;
}

function isActive(name: string) {
  return screen.getByRole("button", { name }).className.includes("bg-primary");
}

describe("PublicBookingRequestsPanel opening filter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.search = "";
  });

  it("opens on Accepted from the link the quote-accepted email builds", async () => {
    const fetchMock = renderPanelOpenedWith(
      queryOf(buildPublicBookingRequestsHref("ACCEPTED")),
    );

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/admin/booking-requests?status=ACCEPTED&page=1"),
    );
    expect(fetchMock).not.toHaveBeenCalledWith("/api/admin/booking-requests?status=QUEUE&page=1");
    expect(isActive("Accepted")).toBe(true);
    expect(isActive("Queue")).toBe(false);
    // The panel's own URL sync keeps the filter in the address bar.
    expect(h.replace).toHaveBeenCalledWith(
      expect.stringContaining("status=ACCEPTED"),
      expect.anything(),
    );
  });

  it("opens on Queue when the link names no filter", async () => {
    const fetchMock = renderPanelOpenedWith("?tab=public");

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/admin/booking-requests?status=QUEUE&page=1"),
    );
    expect(isActive("Queue")).toBe(true);
    expect(isActive("Accepted")).toBe(false);
    expect(h.replace).toHaveBeenCalledWith(
      expect.not.stringContaining("status="),
      expect.anything(),
    );
  });

  it("opens on Queue for the retired filter key, which no panel reads", async () => {
    // The key the email used to send. Pinned so nobody re-adds a second
    // spelling of the key to make an old link work.
    const fetchMock = renderPanelOpenedWith("?tab=public&filter=ACCEPTED");

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/admin/booking-requests?status=QUEUE&page=1"),
    );
    expect(isActive("Queue")).toBe(true);
  });
});
