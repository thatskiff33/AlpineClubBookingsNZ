// @vitest-environment jsdom
//
// Page-level guard for the #796 group-joiner discriminator (#1975 nesting).
// The nesting decision is resolved on the server (bookings/page.tsx) from the
// raw booking shape — parentBookingId + the group-join row — so it can only be
// exercised here, where the real query result is mapped into the DTO the client
// list renders. A joiner reuses parentBookingId but always carries a join row,
// and must never nest as a "Your non-member guests" sub-row.

import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement, ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findMany: vi.fn() },
    // #2263: the page also reads the viewer's own whole-lodge requests for the
    // "My requests" section. Defaulted to empty so these nesting cases keep
    // asserting only what they are about; the section is hidden when empty.
    bookingRequest: { findMany: vi.fn(async () => []) },
    // #2562: and the viewer's own booking-policy exception requests, from both
    // tables. Defaulted to empty for the same reason as the section above.
    newBookingPolicyExceptionRequest: { findMany: vi.fn(async () => []) },
    bookingChangeRequest: { findMany: vi.fn(async () => []) },
    // #3033: the batched "which of these bookings have money held for review"
    // read. Defaulted to empty so these nesting cases keep asserting only what
    // they are about; the qualifier has its own suite.
    manualRefundTask: { findMany: vi.fn(async () => []) },
  },
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

// Render Next's Link as a plain anchor so hrefs land in the static markup.
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
  }: {
    href: string;
    children: ReactNode;
  }) => <a href={href}>{children}</a>,
}));

// Stub the Radix Select so no pointer/portal machinery runs under static render.
vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectContent: () => null,
  SelectItem: () => null,
  SelectTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectValue: () => <span />,
}));

import MyBookingsPage from "@/app/(authenticated)/bookings/page";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";

const VIEWER_ID = "member-M";

function booking(overrides: Record<string, unknown> = {}) {
  return {
    id: "booking-1",
    memberId: VIEWER_ID,
    parentBookingId: null,
    hasNonMembers: false,
    groupBookingJoin: null,
    status: "PAID",
    checkIn: new Date("2026-08-10T00:00:00.000Z"),
    checkOut: new Date("2026-08-12T00:00:00.000Z"),
    finalPriceCents: 12000,
    guests: [] as unknown[],
    ...overrides,
  };
}

async function renderPage() {
  const element = await MyBookingsPage();
  return renderToStaticMarkup(element as ReactElement);
}

describe("MyBookingsPage split-child nesting discriminator (#1975/#796)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth).mockResolvedValue({ user: { id: VIEWER_ID } } as never);
  });

  it("nests a genuine #738 split child (hasNonMembers, no join row) under its parent", async () => {
    const parent = booking({ id: "P", parentBookingId: null });
    const splitChild = booking({
      id: "C",
      parentBookingId: "P",
      hasNonMembers: true,
      groupBookingJoin: null,
      status: "PENDING",
      guests: [{ id: "g1" }],
    });
    vi.mocked(prisma.booking.findMany).mockResolvedValue([parent, splitChild] as never);

    const html = await renderPage();
    // The nesting container renders only for a genuine split child.
    expect(html).toContain('role="group"');
    expect(html).toContain("/bookings/C");
  });

  it("never nests a #796 group joiner (parentBookingId set + join row present)", async () => {
    // Organiser booking the viewer is only a guest on.
    const organiser = booking({ id: "O", memberId: "organiser-X" });
    // The viewer independently joined the group: joiner booking owned by them,
    // parentBookingId=O, but with a group-join row (and no non-members).
    const joiner = booking({
      id: "J",
      memberId: VIEWER_ID,
      parentBookingId: "O",
      hasNonMembers: false,
      groupBookingJoin: { id: "gj-1" },
      status: "CONFIRMED",
      guests: [{ id: "g1" }],
    });
    vi.mocked(prisma.booking.findMany).mockResolvedValue([organiser, joiner] as never);

    const html = await renderPage();
    // No nesting container: the joiner is not carried as a nestable child.
    expect(html).not.toContain('role="group"');
    // The joiner still renders as its own top-level row.
    expect(html).toContain("/bookings/J");
  });

  // #2002: the provisional-child label keys on the same discriminator as
  // nesting, not raw parentBookingId — so a joiner's own top-level row must not
  // wear the #738 split-child label.
  it("does not label a #796 group joiner as a provisional split child (#2002)", async () => {
    const organiser = booking({ id: "O", memberId: "organiser-X" });
    const joiner = booking({
      id: "J",
      memberId: VIEWER_ID,
      parentBookingId: "O",
      hasNonMembers: false,
      groupBookingJoin: { id: "gj-1" },
      status: "CONFIRMED",
      guests: [{ id: "g1" }],
    });
    vi.mocked(prisma.booking.findMany).mockResolvedValue([organiser, joiner] as never);

    const html = await renderPage();
    // The joiner renders top-level but wears no linked/provisional label.
    expect(html).toContain("/bookings/J");
    expect(html).not.toContain("Provisional non-member guests");
    expect(html).not.toContain("linked to your member booking");
  });

  // #2002 guard: a genuine #738 split child keeps its provisional label when it
  // falls back to a top-level row (parent not in the visible set here).
  it("keeps the provisional label on a genuine #738 split child in the fallback row (#2002)", async () => {
    const splitChild = booking({
      id: "C",
      parentBookingId: "P",
      hasNonMembers: true,
      groupBookingJoin: null,
      status: "PENDING",
      guests: [{ id: "g1" }],
    });
    // Parent P is not returned, so the child cannot nest and falls back to its
    // own top-level row — where the inline label must still show.
    vi.mocked(prisma.booking.findMany).mockResolvedValue([splitChild] as never);

    const html = await renderPage();
    expect(html).not.toContain('role="group"');
    expect(html).toContain("Provisional non-member guests");
  });

  // #2002: the guest-linked label (viewer is a guest on someone else's booking)
  // is a different case and stays unaffected by the discriminator fix.
  it("still shows the guest-linked label for a booking the viewer is only a guest on (#2002)", async () => {
    const guestBooking = booking({
      id: "G",
      memberId: "owner-Y",
      parentBookingId: null,
      guests: [{ id: "g-viewer" }],
    });
    vi.mocked(prisma.booking.findMany).mockResolvedValue([guestBooking] as never);

    const html = await renderPage();
    expect(html).toContain("You are listed as a guest on this booking");
    expect(html).not.toContain("Provisional non-member guests");
  });
});
