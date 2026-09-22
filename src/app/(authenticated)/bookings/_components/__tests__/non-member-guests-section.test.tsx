// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { BookingStatus } from "@prisma/client";
import {
  NonMemberGuestsSection,
  type NonMemberGuestChild,
} from "@/app/(authenticated)/bookings/_components/non-member-guests-section";
import { bindClubFormat } from "@/lib/club-format-bound";

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

function child(overrides: Partial<NonMemberGuestChild> = {}): NonMemberGuestChild {
  return {
    id: "child-1",
    status: "PENDING" as BookingStatus,
    guestCount: 2,
    finalPriceCents: 9000,
    moneyReconciliation: {
      visibility: "VISIBLE",
      reconciliation: { state: "RECONCILED", reasons: [] },
    },
    datesDiffer: false,
    checkIn: new Date("2026-08-10T00:00:00.000Z"),
    checkOut: new Date("2026-08-12T00:00:00.000Z"),
    ...overrides,
  };
}

/**
 * The club's format, PINNED rather than inherited (#3565). The component now
 * takes the binding the page resolves from the persisted setting; a test that
 * read the environment instead would change its expected strings the day a
 * deployment's `CURRENCY` changed.
 */
const money = bindClubFormat({ currencyCode: "NZD", locale: "en-NZ" });

describe("NonMemberGuestsSection (#1975 parent detail section)", () => {
  it("renders nothing when there are no children", () => {
    const { container } = render(
      <NonMemberGuestsSection guests={[]} money={money} nonOwnerAdminViewer={false} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the owner heading and a link to each child booking", () => {
    render(
      <NonMemberGuestsSection
        money={money}
        guests={[child()]}
        nonOwnerAdminViewer={false}
      />,
    );
    expect(
      screen.getByText("Your non-member guests"),
    ).toBeInTheDocument();
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "/bookings/child-1");
    expect(link).toHaveTextContent("2 non-member guests");
    expect(link).toHaveTextContent("$90.00");
  });

  it("uses third-person copy for a non-owner admin viewer", () => {
    render(
      <NonMemberGuestsSection guests={[child()]} money={money} nonOwnerAdminViewer />,
    );
    expect(
      screen.getByText("The member's non-member guests"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Your non-member guests"),
    ).not.toBeInTheDocument();
  });

  // #3278: the verdict is officer-only, so the ordinary member who owns this
  // party is handed a withheld view and the row prints the amount alone.
  it("says nothing about a child's stored money when the verdict was withheld", () => {
    render(
      <NonMemberGuestsSection
        money={money}
        guests={[child({ moneyReconciliation: { visibility: "WITHHELD" } })]}
        nonOwnerAdminViewer={false}
      />,
    );

    expect(screen.getByRole("link")).toHaveTextContent("$90.00");
    expect(screen.getByRole("link")).not.toHaveTextContent("needs review");
  });

  it("qualifies an unreconciled child amount without changing it", () => {
    render(
      <NonMemberGuestsSection
        money={money}
        guests={[
          child({
            moneyReconciliation: {
              visibility: "VISIBLE",
              reconciliation: {
                state: "UNRECONCILED",
                reasons: ["HEADLINE_TOTAL_MISMATCH"],
              },
            },
          }),
        ]}
        nonOwnerAdminViewer={false}
      />,
    );

    expect(screen.getByRole("link")).toHaveTextContent("$90.00");
    expect(screen.getByRole("link")).toHaveTextContent("recorded amount needs review");
  });

  it("renders the child's own status badge (e.g. a PENDING child under a PAID parent)", () => {
    render(
      <NonMemberGuestsSection
        money={money}
        guests={[child({ status: "PENDING" as BookingStatus })]}
        nonOwnerAdminViewer={false}
      />,
    );
    expect(screen.getByText("Pending")).toBeInTheDocument();
  });

  it("shows a cancelled child's status", () => {
    render(
      <NonMemberGuestsSection
        money={money}
        guests={[child({ status: "CANCELLED" as BookingStatus })]}
        nonOwnerAdminViewer={false}
      />,
    );
    expect(screen.getByText("Cancelled")).toBeInTheDocument();
  });

  it("hides dates when they match the parent and shows them when they differ", () => {
    // #2264: these stay dates render through `formatNZDate`, the club-pinned
    // medium form ("Aug 2026"), where they used to use `dateStyle: "long"`
    // ("August 2026"). The month is matched in its short form here for that
    // reason — the assertion is about whether the dates appear at all.
    const { rerender } = render(
      <NonMemberGuestsSection
        money={money}
        guests={[child({ datesDiffer: false })]}
        nonOwnerAdminViewer={false}
      />,
    );
    expect(screen.queryByText(/Aug 2026/)).not.toBeInTheDocument();

    rerender(
      <NonMemberGuestsSection
        money={money}
        guests={[child({ datesDiffer: true })]}
        nonOwnerAdminViewer={false}
      />,
    );
    expect(screen.getByText(/Aug 2026/)).toBeInTheDocument();
  });

  it("lists multiple children each with its own link and status", () => {
    render(
      <NonMemberGuestsSection
        money={money}
        guests={[
          child({ id: "child-1", status: "PENDING" as BookingStatus }),
          child({ id: "child-2", status: "BUMPED" as BookingStatus }),
        ]}
        nonOwnerAdminViewer={false}
      />,
    );
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAttribute("href", "/bookings/child-1");
    expect(links[1]).toHaveAttribute("href", "/bookings/child-2");
    expect(screen.getByText("Pending")).toBeInTheDocument();
    expect(screen.getByText("Bumped")).toBeInTheDocument();
  });

  it("swaps to no-longer-active intro copy when every child is cancelled/bumped", () => {
    render(
      <NonMemberGuestsSection
        money={money}
        guests={[
          child({ id: "child-1", status: "CANCELLED" as BookingStatus }),
          child({ id: "child-2", status: "BUMPED" as BookingStatus }),
        ]}
        nonOwnerAdminViewer={false}
      />,
    );
    expect(
      screen.getByText(
        "The linked provisional booking for your non-member guests is no longer active.",
      ),
    ).toBeInTheDocument();
    // The stale "held ... until confirmed" copy must be gone — it would
    // misinform the member that a cancelled portion is still reserved.
    expect(screen.queryByText(/held in a linked provisional booking/)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/until they are confirmed and paid for/),
    ).not.toBeInTheDocument();
  });

  it("uses the third-person no-longer-active copy for an admin viewer when all children are cancelled", () => {
    render(
      <NonMemberGuestsSection
        money={money}
        guests={[child({ status: "CANCELLED" as BookingStatus })]}
        nonOwnerAdminViewer
      />,
    );
    expect(
      screen.getByText(
        "The linked provisional booking for the member's non-member guests is no longer active.",
      ),
    ).toBeInTheDocument();
  });

  it("keeps the held intro copy when at least one child is still live", () => {
    render(
      <NonMemberGuestsSection
        money={money}
        guests={[
          child({ id: "child-1", status: "CANCELLED" as BookingStatus }),
          child({ id: "child-2", status: "PENDING" as BookingStatus }),
        ]}
        nonOwnerAdminViewer={false}
      />,
    );
    expect(
      screen.getByText(/held in a linked provisional booking/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/no longer active/),
    ).not.toBeInTheDocument();
  });

  it("uses the singular noun for a single guest", () => {
    render(
      <NonMemberGuestsSection
        money={money}
        guests={[child({ guestCount: 1 })]}
        nonOwnerAdminViewer={false}
      />,
    );
    expect(screen.getByRole("link")).toHaveTextContent("1 non-member guest");
    expect(screen.getByRole("link")).not.toHaveTextContent("guests");
  });
});
