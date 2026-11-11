// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContactPageClient } from "@/components/website/contact-page-client";
import type { ClubIdentity } from "@/config/club-identity-types";

// Controllable search params: mutate nav.search then (re)render to simulate a
// same-route client navigation that changes ?recipient= without remounting the
// form (e.g. a sidebar "Send a message" link to /contact?recipient=<key>).
const nav = vi.hoisted(() => ({ search: "" }));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(nav.search),
}));

// Radix Select is portal/pointer based and not assertable in jsdom, so mock it
// to surface the controlled value (mirrors member-import-dialog.test.tsx).
vi.mock("@/components/ui/select", () => ({
  Select: ({ value, children }: { value?: string; children: ReactNode }) => (
    <div data-testid="recipient-select" data-value={value}>
      {children}
    </div>
  ),
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectValue: () => <span />,
}));

const MEMBERS = [
  {
    id: "m1",
    role: "Booking Officer",
    roleKey: "booking-officer",
    name: "Ann Lee",
    phone: "021 000 001",
    contactKey: "assign-bookings",
  },
  {
    id: "m2",
    role: "Secretary",
    roleKey: "secretary",
    name: "Bo Tan",
    phone: null,
    contactKey: "assign-secretary",
  },
  {
    id: "m3",
    role: "Treasurer",
    roleKey: "treasurer",
    name: "Cy Ng",
    phone: null,
    contactKey: null,
  },
];

const club = {
  name: "Example Club",
  publicUrl: "https://example.org",
  socialLinks: { facebook: "https://facebook.com/example" },
} as unknown as ClubIdentity;

function recipientValue() {
  return screen.getByTestId("recipient-select").getAttribute("data-value");
}

describe("ContactPageClient recipient pre-selection", () => {
  beforeEach(() => {
    nav.search = "";
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ members: MEMBERS }),
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("pre-selects the committee member named in ?recipient= once members load", async () => {
    nav.search = "recipient=assign-secretary";
    render(<ContactPageClient club={club} />);
    await waitFor(() => expect(recipientValue()).toBe("assign-secretary"));
  });

  it("re-syncs the Send to value when ?recipient= changes on the same route", async () => {
    // Landed on /contact with no recipient -> defaults to General enquiry.
    const { rerender } = render(<ContactPageClient club={club} />);
    await waitFor(() => expect(recipientValue()).toBe("general"));

    // A sidebar "Send a message" link navigates to a published assignment key
    // without remounting the form. The select must follow.
    nav.search = "recipient=assign-bookings";
    rerender(<ContactPageClient club={club} />);
    await waitFor(() => expect(recipientValue()).toBe("assign-bookings"));
  });

  it("falls back to General for an unknown recipient once members load", async () => {
    nav.search = "recipient=not-a-real-key";
    render(<ContactPageClient club={club} />);
    await waitFor(() => expect(recipientValue()).toBe("general"));
  });

  it("renders contactable assignments without email metadata or required phone fields", async () => {
    render(<ContactPageClient club={club} />);

    await waitFor(() =>
      expect(screen.getByText("Secretary \u2014 Bo Tan")).toBeTruthy(),
    );

    expect(screen.queryByText("Treasurer \u2014 Cy Ng")).toBeNull();
    expect(screen.queryByText(/example\.org/i)).toBeNull();
    expect(screen.getByText("Booking Officer")).toBeTruthy();
    expect(screen.getByText("021 000 001")).toBeTruthy();
  });
});

describe("ContactPageClient club details contact selection", () => {
  beforeEach(() => {
    nav.search = "";
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ members: MEMBERS }),
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const lodge = { name: "Alpine Lodge", address: "1 Mountain Rd, Ruapehu" };

  it("defaults to the booking officer and shows the club address above it", async () => {
    render(<ContactPageClient club={club} lodge={lodge} />);

    await waitFor(() =>
      expect(screen.getByText("Booking Officer")).toBeTruthy(),
    );
    // Club Details member (the fallback booking officer).
    expect(screen.getByText("Ann Lee")).toBeTruthy();
    // The address from Site Appearance & Content is rendered.
    expect(screen.getByText("1 Mountain Rd, Ruapehu")).toBeTruthy();
  });

  it("shows the admin-selected committee role instead of the booking officer", async () => {
    render(
      <ContactPageClient
        club={club}
        lodge={lodge}
        contactRoleKey="secretary"
      />,
    );

    await waitFor(() => expect(screen.getByText("Secretary")).toBeTruthy());
    expect(screen.getByText("Bo Tan")).toBeTruthy();
    // The booking officer is no longer the club-details contact.
    expect(screen.queryByText("Booking Officer")).toBeNull();
    // Address is still shown, above the committee info.
    expect(screen.getByText("1 Mountain Rd, Ruapehu")).toBeTruthy();
  });

  it("shows only the address when the configured role has no published members", async () => {
    render(
      <ContactPageClient
        club={club}
        lodge={lodge}
        contactRoleKey="nonexistent-role"
      />,
    );

    await waitFor(() =>
      expect(screen.getByText("1 Mountain Rd, Ruapehu")).toBeTruthy(),
    );
    expect(screen.queryByText("Booking Officer")).toBeNull();
    expect(screen.queryByText("Ann Lee")).toBeNull();
  });
});
