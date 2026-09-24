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

// This page test owns the list's nesting discriminator, so the classifier is
// stubbed and reconciliation keeps its own reader tests. The canonical SELECT
// is the REAL one: since #3278 the page composes its relation shapes out of it,
// and a `{}` stand-in would be asserting against a query shape nothing builds.
vi.mock("@/lib/booking-money-reconciliation-store", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/booking-money-reconciliation-store")),
  reconcileStoredBookingMoney: vi.fn(() => ({ state: "RECONCILED", reasons: [] })),
}));

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
import { reconcileStoredBookingMoney } from "@/lib/booking-money-reconciliation-store";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { ClubFormatTestProvider } from "@/lib/__tests__/support/club-time-render";

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
  // The list the page renders reads the club's format from the provider that
  // AppProviders mounts in production (#3564); a server page's returned JSX
  // carries no such shell, so the test supplies it.
  return renderToStaticMarkup(
    <ClubFormatTestProvider>{element as ReactElement}</ClubFormatTestProvider>,
  );
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

  /*
    #3278 — the page classifies THE ROW IT RENDERS, from one read.

    It used to read the list, then issue a second `booking.findMany` for the
    same ids and classify that. Two things followed, both only in the harmful
    direction: a commit landing between the reads made the card show one read's
    `finalPriceCents` under the other read's verdict, and a booking that
    vanished in the gap — a DRAFT deleted, say — was missing from the second
    result, which threw and took the member's whole bookings page down.

    Counting the reads is what makes the second read unrepresentable; asserting
    the classifier saw the very object the list mapped is what makes "the
    verdict belongs to this number" true rather than likely.
  */
  it("classifies the rows it renders from a single booking read (#3278)", async () => {
    const own = booking({ id: "A" });
    const other = booking({ id: "B" });
    vi.mocked(prisma.booking.findMany).mockResolvedValue([own, other] as never);

    await renderPage();

    expect(prisma.booking.findMany).toHaveBeenCalledTimes(1);
    expect(reconcileStoredBookingMoney).toHaveBeenCalledTimes(2);
    expect(vi.mocked(reconcileStoredBookingMoney).mock.calls[0]![0]).toBe(own);
    expect(vi.mocked(reconcileStoredBookingMoney).mock.calls[1]![0]).toBe(other);
  });

  // The other half of the same defect: with one read there is no gap for a
  // booking to disappear in, so the list renders instead of throwing.
  it("renders rather than throwing when the classifier is driven straight off the list (#3278)", async () => {
    vi.mocked(prisma.booking.findMany).mockResolvedValue([
      booking({ id: "A" }),
    ] as never);

    await expect(renderPage()).resolves.toContain("/bookings/A");
  });
});

/*
  #3278 — WHO THE MY-BOOKINGS LIST MARKS AN AMOUNT FOR.

  The verdict is officer-only (owner decision, 20 September 2026), and this
  page had no viewer concept at all before it: it is "my bookings", so it never
  needed one. It needs one now for a reason the page's own `where` makes plain
  — it also selects bookings the viewer merely appears on as a GUEST, whose
  figure belongs to another member. So the exposure here was one member reading
  an integrity verdict about another member's money, and the signal chosen is
  `canSeeBookingAdminTools`, the SAME officer predicate the booking-detail page
  gates the rest of a booking's private evidence on.
*/
describe("MyBookingsPage stored-money verdicts are officer-only (#3278)", () => {
  const OFFICER = {
    user: { id: VIEWER_ID, accessRoles: [{ role: "ADMIN" }] },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(reconcileStoredBookingMoney).mockReturnValue({
      state: "UNRECONCILED",
      reasons: ["HEADLINE_TOTAL_MISMATCH"],
    } as never);
  });

  it("marks nothing for an ordinary member, on their own booking", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: VIEWER_ID } } as never);
    vi.mocked(prisma.booking.findMany).mockResolvedValue([
      booking({ id: "A" }),
    ] as never);

    const html = await renderPage();
    expect(html).toContain("/bookings/A");
    expect(html).not.toContain("recorded amount needs review");
    expect(html).not.toContain("Money review");
  });

  // The cross-member case, which is the one that mattered: the list carries a
  // booking OWNED BY SOMEBODY ELSE that this viewer is only a guest on.
  it("never marks another member's amount for a non-officer viewer", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: VIEWER_ID } } as never);
    vi.mocked(prisma.booking.findMany).mockResolvedValue([
      booking({ id: "O", memberId: "organiser-X" }),
    ] as never);

    const html = await renderPage();
    expect(html).toContain("/bookings/O");
    expect(html).not.toContain("recorded amount needs review");
    // Not merely unrendered: no reason token reaches this browser's payload.
    expect(html).not.toContain("HEADLINE_TOTAL_MISMATCH");
  });

  it("marks it for an officer", async () => {
    vi.mocked(auth).mockResolvedValue(OFFICER as never);
    vi.mocked(prisma.booking.findMany).mockResolvedValue([
      booking({ id: "A" }),
    ] as never);

    const html = await renderPage();
    expect(html).toContain("recorded amount needs review");
    expect(html).toContain("Money review");
  });

  it("marks nothing for an officer when the booking reconciles", async () => {
    vi.mocked(auth).mockResolvedValue(OFFICER as never);
    vi.mocked(reconcileStoredBookingMoney).mockReturnValue({
      state: "RECONCILED",
      reasons: [],
    } as never);
    vi.mocked(prisma.booking.findMany).mockResolvedValue([
      booking({ id: "A" }),
    ] as never);

    const html = await renderPage();
    expect(html).toContain("/bookings/A");
    expect(html).not.toContain("recorded amount needs review");
  });
});
