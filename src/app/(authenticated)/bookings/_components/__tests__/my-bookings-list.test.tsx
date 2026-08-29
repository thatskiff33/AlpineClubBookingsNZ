// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import type { ReactNode } from "react";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { BookingStatus } from "@prisma/client";
import {
  MyBookingsList,
  type MyBookingItem,
} from "@/app/(authenticated)/bookings/_components/my-bookings-list";

// Render Next's Link as a plain anchor so hrefs are assertable in jsdom.
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: ReactNode;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

// The Radix Select is not exercised here (default "all" filter); stub it to a
// plain wrapper so no pointer machinery runs in jsdom.
// Stub the Radix Select to a bare wrapper. Crucially SelectItem renders
// nothing: the status filter otherwise emits every status *label* as option
// text, which would collide with the status badges the assertions target.
vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectContent: () => null,
  SelectItem: () => null,
  SelectTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectValue: () => <span />,
}));

let seq = 0;
function item(overrides: Partial<MyBookingItem> = {}): MyBookingItem {
  seq += 1;
  return {
    id: `booking-${seq}`,
    checkIn: "2026-08-10T00:00:00.000Z",
    checkOut: "2026-08-12T00:00:00.000Z",
    guestCount: 2,
    finalPriceCents: 12000,
    status: "PAID" as BookingStatus,
    linkLabel: null,
    parentBookingId: null,
    ...overrides,
  };
}

function parentWithChild(
  parentStatus: BookingStatus,
  childStatus: BookingStatus,
) {
  const parent = item({
    id: "parent-1",
    status: parentStatus,
    linkLabel: "linked-parent",
  });
  const child = item({
    id: "child-1",
    status: childStatus,
    guestCount: 1,
    finalPriceCents: 8000,
    linkLabel: "provisional-child",
    parentBookingId: "parent-1",
  });
  return { parent, child };
}

const nonMemberGroupName = /non-member guests linked to this booking/i;

describe("MyBookingsList nested split presentation (#1975)", () => {
  it("nests the provisional child inside the parent card as a sub-row", () => {
    const { parent, child } = parentWithChild("PAID", "PENDING");
    render(<MyBookingsList bookings={[parent, child]} />);

    // The nested group exists and holds the child link.
    const group = screen.getByRole("group", { name: nonMemberGroupName });
    const childLink = within(group).getByRole("link");
    expect(childLink).toHaveAttribute(
      "href",
      expect.stringContaining("/bookings/child-1"),
    );
    expect(within(group).getByText("Your non-member guests")).toBeInTheDocument();

    // The child is NOT also rendered as a top-level sibling: exactly two links
    // total (parent link + one nested child link).
    expect(screen.getAllByRole("link")).toHaveLength(2);
  });

  it("suppresses the redundant parent + child inline labels when nested", () => {
    const { parent, child } = parentWithChild("PAID", "PENDING");
    render(<MyBookingsList bookings={[parent, child]} />);

    expect(
      screen.queryByText("Includes linked provisional non-member guests"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        "Provisional non-member guests · linked to your member booking",
      ),
    ).not.toBeInTheDocument();
  });

  it("shows the child's own status badge inside the nested sub-row", () => {
    const { parent, child } = parentWithChild("PAID", "PENDING");
    render(<MyBookingsList bookings={[parent, child]} />);

    const group = screen.getByRole("group", { name: nonMemberGroupName });
    // Child badge label "Pending"; parent badge "Paid" sits outside the group.
    expect(within(group).getByText("Pending")).toBeInTheDocument();
  });

  it("renders the child post-#1967-switch (child still PENDING, parent PAID by IB) nested", () => {
    // After the member settles their own place by internet banking the child
    // stays PENDING; it must still nest under the (now PAID) parent.
    const { parent, child } = parentWithChild("PAID", "PENDING");
    render(<MyBookingsList bookings={[parent, child]} />);
    const group = screen.getByRole("group", { name: nonMemberGroupName });
    expect(within(group).getByText("Pending")).toBeInTheDocument();
  });

  it("keeps a live child nested under a cancelled parent", () => {
    const { parent, child } = parentWithChild("CANCELLED", "PENDING");
    render(<MyBookingsList bookings={[parent, child]} />);
    const group = screen.getByRole("group", { name: nonMemberGroupName });
    expect(within(group).getByText("Pending")).toBeInTheDocument();
    // Parent still shown with its cancelled badge.
    expect(screen.getByText("Cancelled")).toBeInTheDocument();
  });

  it("keeps a cancelled child nested under a live parent", () => {
    const { parent, child } = parentWithChild("PAID", "CANCELLED");
    render(<MyBookingsList bookings={[parent, child]} />);
    const group = screen.getByRole("group", { name: nonMemberGroupName });
    expect(within(group).getByText("Cancelled")).toBeInTheDocument();
  });

  it("nests a bumped child under a live parent", () => {
    const { parent, child } = parentWithChild("PAID", "BUMPED");
    render(<MyBookingsList bookings={[parent, child]} />);
    const group = screen.getByRole("group", { name: nonMemberGroupName });
    expect(within(group).getByText("Bumped")).toBeInTheDocument();
  });

  it("falls back to a top-level row (with the full linked label) when the parent is absent from the list", () => {
    // Parent not passed (filtered/paged out): the child must not disappear.
    const { child } = parentWithChild("PAID", "PENDING");
    render(<MyBookingsList bookings={[child]} />);

    expect(
      screen.queryByRole("group", { name: nonMemberGroupName }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "Provisional non-member guests · linked to your member booking",
      ),
    ).toBeInTheDocument();
    // Rendered as its own clickable row.
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute(
      "href",
      expect.stringContaining("/bookings/child-1"),
    );
  });

  it("keeps the parent's inline label when its child is absent from the list", () => {
    const { parent } = parentWithChild("PAID", "PENDING");
    render(<MyBookingsList bookings={[parent]} />);
    expect(
      screen.queryByRole("group", { name: nonMemberGroupName }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("Includes linked provisional non-member guests"),
    ).toBeInTheDocument();
  });

  it("leaves a standalone booking as a single whole-card link (unchanged)", () => {
    render(<MyBookingsList bookings={[item({ id: "solo" })]} />);
    expect(
      screen.queryByRole("group", { name: nonMemberGroupName }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  it("does not nest a guest-linked booking (member is only a guest) even if it carries a parent id", () => {
    // A booking the member is only a guest on is not their split child.
    const host = item({ id: "host", status: "PAID" });
    const guestLinked = item({
      id: "guest-1",
      linkLabel: "guest-linked",
      parentBookingId: "host",
    });
    render(<MyBookingsList bookings={[host, guestLinked]} />);
    expect(
      screen.queryByRole("group", { name: nonMemberGroupName }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByRole("link")).toHaveLength(2);
  });
});

/**
 * #3033 (epic #2797) — the stale post-edit figure on the My Bookings row.
 *
 * `finalPriceCents` IS updated by a structural edit, so a booking whose
 * adjustment is unresolved shows a number that looks authoritative and is not
 * the last word. The fix is a qualifier, never a substitution: hiding the figure
 * would leave the member with nothing, and correcting it is the estimation this
 * whole epic exists to forbid.
 *
 * MUTATION PROOF. Render the chip unconditionally and "says nothing on an
 * ordinary booking" fails. Replace the total with the qualifier and "keeps the
 * figure and qualifies it" fails. Replace the status badge with the chip and
 * "keeps the booking status, which is still true" fails.
 */
describe("a booking whose adjustment is still being worked out (#3033)", () => {
  it("keeps the figure and qualifies it, rather than hiding or correcting it", () => {
    render(
      <MyBookingsList
        bookings={[item({ id: "under-review", financialReviewPending: true })]}
      />,
    );

    const card = screen.getByRole("link", { name: /Aug 2026/ });
    expect(card).toHaveTextContent("$120.00");
    expect(card).toHaveTextContent("being checked");
    expect(card).toHaveTextContent("Adjustment being checked");
  });

  it("keeps the booking status, which is still true", () => {
    // The stay is confirmed. Overwriting the status to say something about the
    // money would misstate the booking.
    render(
      <MyBookingsList
        bookings={[item({ id: "under-review", financialReviewPending: true })]}
      />,
    );

    expect(screen.getByText("Paid")).toBeInTheDocument();
  });

  it("says nothing on an ordinary booking", () => {
    render(<MyBookingsList bookings={[item({ id: "ordinary" })]} />);

    expect(screen.queryByText("Adjustment being checked")).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Aug 2026/ }),
    ).not.toHaveTextContent("being checked");
  });
});
