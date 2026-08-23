// @vitest-environment jsdom

/**
 * The "Member of Other Lodge" control on the edit-booking Guests card (Other
 * Lodges epic, follow-up to #2749).
 *
 * The card and the hook are exercised TOGETHER, wired exactly as the panel wires
 * them, because the behaviour worth pinning is the state transition between
 * them: deselecting the lodge has to CLEAR the ticks, not merely grey them out.
 * A card test with hand-held state would pass while the real screen left a set
 * of ticks armed against no lodge — which the server then refuses on save.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { EditGuestsCard } from "@/components/edit-booking/edit-guests-card";
import { useOtherLodgeRate } from "@/components/edit-booking/hooks/use-other-lodge-rate";
import type { BookingData, Guest } from "@/components/edit-booking/types";
import type { AgeTierOption } from "@/lib/use-age-tier-options";

const ageTierOptions: AgeTierOption[] = [
  { tier: "ADULT", label: "Adult", sortOrder: 0 },
  { tier: "CHILD", label: "Child", sortOrder: 1 },
] as AgeTierOption[];

const guests: Guest[] = [
  {
    id: "g-owner",
    firstName: "Ada",
    lastName: "Owner",
    ageTier: "ADULT",
    isMember: true,
    priceCents: 2000,
  },
  {
    id: "g-visitor",
    firstName: "Vic",
    lastName: "Visitor",
    ageTier: "ADULT",
    isMember: false,
    priceCents: 4800,
  },
  {
    id: "g-child",
    firstName: "Kit",
    lastName: "Visitor",
    ageTier: "CHILD",
    isMember: false,
    priceCents: 2400,
  },
];

function makeBooking(overrides: Partial<BookingData> = {}): BookingData {
  return {
    id: "b1",
    checkIn: "2026-08-01",
    checkOut: "2026-08-03",
    guests,
    viewerRole: "ADMIN",
    finalPriceCents: 9200,
    totalPriceCents: 9200,
    discountCents: 0,
    promoAdjustmentCents: 0,
    promo: null,
    canEditNonMemberGuestNames: false,
    canFixNonMemberGuestNameTypos: false,
    editPolicy: {
      mode: "future",
      today: "2026-07-01",
      editableFrom: null,
      checkInEditable: true,
    },
    otherLodges: [
      { id: "lodge-a", name: "Aorangi Lodge" },
      { id: "lodge-b", name: "Bruce Lodge" },
    ],
    otherLodgeId: null,
    // #2978: eligibility now arrives from the server rather than being derived
    // from `isMember` on the client. The default mirrors what the server sends
    // for this fixture - the two non-members - so every pre-existing case keeps
    // its meaning; the widened-rule case overrides it.
    otherLodgeRateEligibleGuestIds: ["g-visitor", "g-child"],
    ...overrides,
  };
}

/** The card wired to the real hook, the way `edit-booking-panel` wires it. */
function Harness({
  booking,
  quotedGuestPriceCents = new Map<string, number>(),
}: {
  booking: BookingData;
  quotedGuestPriceCents?: ReadonlyMap<string, number>;
}) {
  const otherLodgeRate = useOtherLodgeRate(booking);
  const [payload, setPayload] = useState<string>("");
  return (
    <>
      <EditGuestsCard
        booking={booking}
        ageTierOptions={ageTierOptions}
        memberGuestTriggerRef={{ current: null }}
        mode={{
          overrideEnabled: false,
          isInProgressEdit: false,
          minEditableDate: "2026-07-01",
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
          nonMemberGuestNamesEditable: false,
          memberLinkEnabled: false,
        }}
        party={{
          remainingGuests: booking.guests,
          addedGuests: [],
          removedGuestIds: new Set(),
          totalGuestCount: booking.guests.length,
        }}
        memberGuest={{
          finderOpen: false,
          addError: null,
          lastAttempt: null,
          onToggleFinder: vi.fn(),
          onAdd: vi.fn(),
          onCancel: vi.fn(),
        }}
        memberLink={{
          linkFinderGuestId: null,
          linkedGuestMembers: {},
          onStartLink: vi.fn(),
          onLink: vi.fn(),
          onUnlink: vi.fn(),
          onCancelLink: vi.fn(),
        }}
        otherLodge={{
          available: otherLodgeRate.available,
          lodges: otherLodgeRate.lodges,
          enabled: otherLodgeRate.enabled,
          lodgeId: otherLodgeRate.lodgeId,
          flaggedGuestIds: otherLodgeRate.flaggedGuestIds,
          eligibleGuestIds: otherLodgeRate.eligibleGuestIds,
          guestTicksEnabled: otherLodgeRate.guestTicksEnabled,
          quotedGuestPriceCents,
          onEnabledChange: otherLodgeRate.onEnabledChange,
          onLodgeIdChange: otherLodgeRate.onLodgeIdChange,
          onGuestToggle: otherLodgeRate.onGuestToggle,
        }}
        quickAdd={{
          familyMembers: [],
          partnerCandidates: [],
          onAddFamilyMember: vi.fn(),
          onAddPartnerCandidate: vi.fn(),
        }}
        dateModes={{
          canEditPerGuestDates: false,
          perGuestDatesEnabled: false,
          multiDateRangesEnabled: false,
          existingGuestNights: {},
          onPerGuestDatesChange: vi.fn(),
          onMultiDateRangesChange: vi.fn(),
          onToggleNight: vi.fn(),
          getExistingGuestRange: () => ({
            stayStart: booking.checkIn,
            stayEnd: booking.checkOut,
          }),
          onUpdateExistingGuestRange: vi.fn(),
          onUpdateAddedGuestRange: vi.fn(),
        }}
        guestEdits={{
          getGuestNameEdit: (guest) => ({
            firstName: guest.firstName,
            lastName: guest.lastName,
          }),
          onUpdateGuestName: vi.fn(),
          onRemoveGuest: vi.fn(),
          onUndoRemoveGuest: vi.fn(),
          onRemoveAddedGuest: vi.fn(),
        }}
        addForm={{
          open: false,
          firstName: "",
          lastName: "",
          ageTier: "ADULT",
          onOpen: vi.fn(),
          onFirstNameChange: vi.fn(),
          onLastNameChange: vi.fn(),
          onAgeTierChange: vi.fn(),
          onAdd: vi.fn(),
          onCancel: vi.fn(),
        }}
      />
      {/* The two request fields the panel would post, so the test can read what
          the officer's clicks actually propose. */}
      <button
        type="button"
        onClick={() => setPayload(JSON.stringify(otherLodgeRate.payloadFields()))}
      >
        capture payload
      </button>
      <output data-testid="payload">{payload}</output>
      <output data-testid="changed">{String(otherLodgeRate.changed)}</output>
    </>
  );
}

const tickFor = (name: string) =>
  screen.getByLabelText(
    `Price ${name} at the other-lodge member rate`,
  ) as HTMLInputElement;

function memberOfOtherLodgeTick() {
  return screen.getByText("Member of Other Lodge").previousSibling as HTMLInputElement;
}

function capturePayload() {
  fireEvent.click(screen.getByRole("button", { name: "capture payload" }));
  return JSON.parse(screen.getByTestId("payload").textContent || "{}");
}

describe("Member of Other Lodge — the card and the hook together", () => {
  it("hides the whole control from a viewer the server sent no lodge registry to", () => {
    // A member's payload carries no `otherLodges` key at all, so their card is
    // exactly what it was before this feature — no tick, no column.
    render(<Harness booking={makeBooking({ otherLodges: undefined })} />);

    expect(screen.queryByText("Member of Other Lodge")).toBeNull();
    expect(
      screen.queryByLabelText("Price Vic Visitor at the other-lodge member rate"),
    ).toBeNull();
  });

  it("reveals the lodge picker only once the header tick is on", () => {
    render(<Harness booking={makeBooking()} />);

    expect(screen.queryByLabelText("Other Lodge Name")).toBeNull();
    fireEvent.click(memberOfOtherLodgeTick());
    expect(screen.queryByLabelText("Other Lodge Name")).not.toBeNull();
  });

  it("shows no tick column at all until the header tick is on", () => {
    render(<Harness booking={makeBooking()} />);

    expect(
      screen.queryByLabelText("Price Vic Visitor at the other-lodge member rate"),
    ).toBeNull();

    fireEvent.click(memberOfOtherLodgeTick());
    expect(
      screen.queryByLabelText("Price Vic Visitor at the other-lodge member rate"),
    ).not.toBeNull();
  });

  it("offers a tick to every non-member and to no member", () => {
    render(<Harness booking={makeBooking()} />);
    fireEvent.click(memberOfOtherLodgeTick());

    expect(tickFor("Vic Visitor").type).toBe("checkbox");
    expect(tickFor("Kit Visitor").type).toBe("checkbox");
    // The club's own member prices at their own membership rate.
    expect(
      screen.queryByLabelText("Price Ada Owner at the other-lodge member rate"),
    ).toBeNull();
  });

  /**
   * #2978. The tick follows the RATE, and the rate is a server answer: the
   * client cannot see membership types or subscription standing, so it is told
   * who is eligible rather than guessing from `isMember`.
   *
   * The case that matters is a guest flagged `isMember` who nonetheless prices
   * at the non-member rate - a non-member contact re-added through the
   * member-guest finder, which is how the gap was reported.
   */
  it("offers a tick to a member-flagged guest the server judged eligible", () => {
    render(
      <Harness
        booking={makeBooking({
          // Ada is `isMember`, and the server says she is on the non-member
          // rate, so she is exactly who the reciprocal rate is for.
          otherLodgeRateEligibleGuestIds: ["g-owner", "g-visitor", "g-child"],
        })}
      />,
    );
    fireEvent.click(memberOfOtherLodgeTick());

    expect(tickFor("Ada Owner").type).toBe("checkbox");
  });

  it("offers no tick to anybody the server left out, whatever their isMember flag", () => {
    render(
      <Harness
        booking={makeBooking({
          // The server withheld Kit - e.g. a lapsed member the subscription
          // lockout has already repriced, who must not be re-rated back up.
          otherLodgeRateEligibleGuestIds: ["g-visitor"],
        })}
      />,
    );
    fireEvent.click(memberOfOtherLodgeTick());

    expect(tickFor("Vic Visitor").type).toBe("checkbox");
    expect(
      screen.queryByLabelText("Price Kit Visitor at the other-lodge member rate"),
    ).toBeNull();
  });

  /**
   * #2978 review: eligibility is judged NOW; the stored flag was written
   * EARLIER. A ticked guest whose membership type changes, or whose subscription
   * lapses, drops out of the eligible set — and without this the box vanished
   * while the hook went on submitting their id in the complete set. The quote
   * and the save both refused, and the only escape was to retract the whole
   * election: the lodge and every other guest with it. The booking became
   * uneditable through this control.
   */
  it("still shows the box for a STORED tick the server would no longer offer", () => {
    render(
      <Harness
        booking={makeBooking({
          otherLodgeId: "lodge-a",
          guests: guests.map((guest) =>
            guest.id === "g-child" ? { ...guest, otherLodgeMember: true } : guest,
          ),
          // Kit carries the flag but is no longer eligible.
          otherLodgeRateEligibleGuestIds: ["g-visitor"],
        })}
      />,
    );

    const stale = tickFor("Kit Visitor");
    expect(stale.type).toBe("checkbox");
    expect(stale.checked).toBe(true);
  });

  it("lets that stale tick be cleared, which is the whole point of showing it", () => {
    render(
      <Harness
        booking={makeBooking({
          otherLodgeId: "lodge-a",
          guests: guests.map((guest) =>
            guest.id === "g-child" ? { ...guest, otherLodgeMember: true } : guest,
          ),
          otherLodgeRateEligibleGuestIds: ["g-visitor"],
        })}
      />,
    );

    fireEvent.click(tickFor("Kit Visitor"));

    // Cleared, and the submitted set no longer names them — so the save that
    // would have been refused now succeeds. The box goes away with the flag,
    // because an ineligible guest with no stored tick has nothing to offer.
    expect(
      screen.queryByLabelText("Price Kit Visitor at the other-lodge member rate"),
    ).toBeNull();
    expect(capturePayload()).toEqual({
      otherLodgeId: "lodge-a",
      otherLodgeMemberGuestIds: [],
    });
  });

  it("offers no tick at all when the server sent no eligibility list", () => {
    // A non-admin viewer is shipped neither the registry nor the list. Belt and
    // braces: even with the registry present, an absent list offers nothing,
    // so the screen can never propose what the save would refuse.
    render(
      <Harness
        booking={makeBooking({ otherLodgeRateEligibleGuestIds: undefined })}
      />,
    );
    fireEvent.click(memberOfOtherLodgeTick());

    expect(
      screen.queryByLabelText("Price Vic Visitor at the other-lodge member rate"),
    ).toBeNull();
  });

  it("keeps the guest ticks disabled until a lodge is named, then enables them", () => {
    render(<Harness booking={makeBooking()} />);
    fireEvent.click(memberOfOtherLodgeTick());

    expect(tickFor("Vic Visitor").disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Other Lodge Name"), {
      target: { value: "lodge-a" },
    });
    expect(tickFor("Vic Visitor").disabled).toBe(false);
  });

  it("proposes the lodge and the ticked guests, as a complete set", () => {
    render(<Harness booking={makeBooking()} />);
    fireEvent.click(memberOfOtherLodgeTick());
    fireEvent.change(screen.getByLabelText("Other Lodge Name"), {
      target: { value: "lodge-a" },
    });
    fireEvent.click(tickFor("Vic Visitor"));
    fireEvent.click(tickFor("Kit Visitor"));

    expect(capturePayload()).toEqual({
      otherLodgeId: "lodge-a",
      otherLodgeMemberGuestIds: ["g-visitor", "g-child"],
    });
  });

  it("deselecting the lodge CLEARS the ticks and disables them again", () => {
    render(<Harness booking={makeBooking()} />);
    fireEvent.click(memberOfOtherLodgeTick());
    fireEvent.change(screen.getByLabelText("Other Lodge Name"), {
      target: { value: "lodge-a" },
    });
    fireEvent.click(tickFor("Vic Visitor"));
    expect(tickFor("Vic Visitor").checked).toBe(true);

    fireEvent.change(screen.getByLabelText("Other Lodge Name"), {
      target: { value: "" },
    });

    // Cleared, not merely greyed: a tick left armed against no lodge is refused
    // by the server on save, so the screen must not keep showing one.
    expect(tickFor("Vic Visitor").checked).toBe(false);
    expect(tickFor("Vic Visitor").disabled).toBe(true);
    expect(screen.getByTestId("changed").textContent).toBe("false");
  });

  it("unticking the header retracts the whole election", () => {
    render(
      <Harness
        booking={makeBooking({
          otherLodgeId: "lodge-a",
          guests: guests.map((guest) =>
            guest.id === "g-visitor" ? { ...guest, otherLodgeMember: true } : guest,
          ),
        })}
      />,
    );

    // A booking that already carries an election opens with it shown.
    expect(tickFor("Vic Visitor").checked).toBe(true);

    fireEvent.click(memberOfOtherLodgeTick());

    // Picker gone, column gone, and the election retracted rather than merely
    // hidden — a hidden-but-live tick would be saved.
    expect(screen.queryByLabelText("Other Lodge Name")).toBeNull();
    expect(
      screen.queryByLabelText("Price Vic Visitor at the other-lodge member rate"),
    ).toBeNull();
    expect(capturePayload()).toEqual({
      otherLodgeId: null,
      otherLodgeMemberGuestIds: [],
    });
  });

  it("proposes nothing while the officer has changed nothing", () => {
    render(<Harness booking={makeBooking()} />);
    fireEvent.click(memberOfOtherLodgeTick());

    // Ticking the header alone is not a change — no lodge, nobody ticked — so
    // an ordinary save must not carry the fields at all.
    expect(capturePayload()).toEqual({});
    expect(screen.getByTestId("changed").textContent).toBe("false");
  });

  it("shows the recalculated fee beside the old one", () => {
    render(
      <Harness
        booking={makeBooking()}
        quotedGuestPriceCents={new Map([["g-visitor", 1500]])}
      />,
    );

    // The quote's figure, with the booked figure struck through beside it.
    expect(screen.queryByText("$15.00")).not.toBeNull();
    const struck = screen.getByText("$48.00");
    expect(struck.className).toContain("line-through");
  });
});
