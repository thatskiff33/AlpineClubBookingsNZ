// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import type { ComponentProps } from "react";
import { fireEvent, render, screen } from "@/lib/__tests__/support/club-time-render";
import { describe, expect, it, vi } from "vitest";
import { GuestsStep } from "@/app/(authenticated)/book/_components/guests-step";
import { DependantIdentityResolution } from "@/app/(authenticated)/book/_components/dependant-identity-resolution";
import type { FamilyMember } from "@/app/(authenticated)/book/_components/types";
import type { OwnDependantCollision } from "@/lib/booking-dependant-identity";
import type { GuestData } from "@/components/guest-form";

vi.mock("@/components/guest-form", () => ({
  GuestForm: () => <div data-testid="guest-form" />,
}));

/*
  #2721 — the wizard's half of own-dependant identity (`INV-GUEST-019`).

  The rule the wizard is enforcing: a booker's own recorded dependant typed as a
  free-text guest is heading for the non-member path — provisional, bumpable,
  invoiced as the deferred guest portion — and the booker must say which person
  they mean before the party can go any further. The server re-resolves the same
  question; these cases are about the question being ASKED, and asked in a way a
  reordered party cannot corrupt.
*/

const COLLISION: OwnDependantCollision = {
  normalizedName: "sam smith",
  typedFirstName: "Sam",
  typedLastName: "Smith",
  dependants: [{ id: "dep-sam", firstName: "Sam", lastName: "Smith" }],
};

const SAM_AS_FAMILY_MEMBER: FamilyMember = {
  id: "dep-sam",
  firstName: "Sam",
  lastName: "Smith",
  ageTier: "CHILD",
  relationship: "dependent",
  canBeBooked: true,
};

function renderResolution(
  overrides: Partial<ComponentProps<typeof DependantIdentityResolution>> = {},
) {
  const props: ComponentProps<typeof DependantIdentityResolution> = {
    collisions: [COLLISION],
    declaredDependantMemberIds: [],
    familyMembers: [SAM_AS_FAMILY_MEMBER],
    partyMemberIds: [],
    // #2721 review: the default is the tri-state's "we cannot tell yet", which
    // is what the guests step reports until a non-member is in the party.
    holdPolicy: "conditional",
    onBookAsDependant: vi.fn(),
    onDeclareDifferentPerson: vi.fn(),
    onWithdrawDeclaration: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<DependantIdentityResolution {...props} />) };
}

describe("DependantIdentityResolution (#2721)", () => {
  it("renders nothing when no name collides", () => {
    const { container } = renderResolution({ collisions: [] });
    expect(container).toBeEmptyDOMElement();
  });

  it("offers both answers, and says what the guest path would cost the dependant", () => {
    renderResolution({ holdPolicy: "applies" });

    expect(
      screen.getByRole("button", {
        name: /this is my dependant — book them as a member/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: /different person with the same name/i,
      }),
    ).toBeInTheDocument();
    // The consequence is stated, not implied: no bed held, and members first.
    expect(
      screen.getByText(/no bed is reserved for them/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/members have priority if the lodge fills up/i),
    ).toBeInTheDocument();
  });

  /*
    #2721 review — THE CONSEQUENCE IS CONFIGURATION, NOT FACT.

    The provisional hold on a non-member is a per-period, per-deployment
    setting. This panel asserted it unconditionally, which is pressure toward
    the wrong answer in exactly the place the component's own docblock says it
    is designed to avoid: a parent told their child will be bumped picks "this
    is my dependant" whether or not it is true. The conditioned sentence already
    existed one module away, and returns nothing at all when the hold does not
    apply.
  */
  describe("the provisional-hold sentence follows the club's setting", () => {
    it("says nothing about a hold when the hold does not apply to this stay", () => {
      renderResolution({ holdPolicy: "none" });
      expect(screen.queryByText(/no bed is reserved/i)).toBeNull();
      expect(screen.queryByText(/held provisionally/i)).toBeNull();
      // The question itself is unchanged — only the consequence is dropped.
      expect(
        screen.getByText(/we will not guess which person you mean/i),
      ).toBeInTheDocument();
    });

    it("hedges when the quote cannot yet say", () => {
      renderResolution({ holdPolicy: "conditional" });
      expect(
        screen.getByText(/may be held provisionally depending on how far out/i),
      ).toBeInTheDocument();
    });

    it("states it plainly when the hold does apply", () => {
      renderResolution({ holdPolicy: "applies" });
      expect(
        screen.getByText(/they'll be held provisionally/i),
      ).toBeInTheDocument();
    });
  });

  /*
    #2721 review — A DEPENDANT THE PROFILE CANNOT FIX.

    Family-group membership and the parent link are different columns, and
    divergence is the DEFAULT: linking a dependant defaults to no shared group.
    The copy used to send that parent to their profile to "add them to your
    family group", where the options are create a group, request to join one,
    invite an existing member by email, and request a child — which mints a NEW
    member, a duplicate of the child the club already knows. No available "yes",
    so the only way to book was to assert a different person.
  */
  describe("a dependant who is not in the booker's family list", () => {
    it("points at the club, not at a profile screen that cannot do it", () => {
      renderResolution({ familyMembers: [] });
      expect(
        screen.getByText(/ask the club to put them in your family group/i),
      ).toBeInTheDocument();
      expect(screen.queryByText(/Open Family Group in your profile/i)).toBeNull();
    });

    it("still keeps the profile link for a block the profile CAN clear", () => {
      renderResolution({
        familyMembers: [
          { ...SAM_AS_FAMILY_MEMBER, canBeBooked: false, canCurrentUserConfirmDetails: true },
        ],
      });
      expect(
        screen.getByText(/Open Family Group in your profile/i),
      ).toBeInTheDocument();
    });
  });

  it("hands the member path the NORMALISED NAME, never a party index", () => {
    // The whole positional hazard in one assertion. The callback carries the
    // name the collision is about; the party array it applies to is read fresh
    // by the hook, so a row removed between render and click cannot cause this
    // dependant's member link to land on somebody else's row.
    const { props } = renderResolution();
    fireEvent.click(
      screen.getByRole("button", {
        name: /this is my dependant — book them as a member/i,
      }),
    );
    expect(props.onBookAsDependant).toHaveBeenCalledWith(
      "sam smith",
      SAM_AS_FAMILY_MEMBER,
    );
  });

  it("binds the declaration to the dependant it is about", () => {
    const { props } = renderResolution();
    fireEvent.click(
      screen.getByRole("button", {
        name: /different person with the same name/i,
      }),
    );
    expect(props.onDeclareDifferentPerson).toHaveBeenCalledWith(
      COLLISION,
      "dep-sam",
    );
  });

  it("asks once per dependant when two of them share the normalised name", () => {
    renderResolution({
      collisions: [
        {
          ...COLLISION,
          dependants: [
            { id: "dep-sam-1", firstName: "Sam", lastName: "Smith" },
            { id: "dep-sam-2", firstName: "Sam", lastName: "Smith" },
          ],
        },
      ],
      familyMembers: [
        { ...SAM_AS_FAMILY_MEMBER, id: "dep-sam-1" },
        { ...SAM_AS_FAMILY_MEMBER, id: "dep-sam-2" },
      ],
    });

    // Two people, two questions. "This is not Sam" says nothing about the other
    // Sam, so one blanket answer would be the generic override by another name.
    expect(
      screen.getAllByRole("button", {
        name: /different person with the same name/i,
      }),
    ).toHaveLength(2);
  });

  it("shows an answered dependant as settled, and lets it be taken back", () => {
    const { props } = renderResolution({
      declaredDependantMemberIds: ["dep-sam"],
    });

    expect(
      screen.getByText(/you have said this is a different person/i),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /change my answer/i }));
    expect(props.onWithdrawDeclaration).toHaveBeenCalledWith(
      COLLISION,
      "dep-sam",
    );
  });

  describe("when the member path is not open to this dependant", () => {
    it("says what has to happen first instead of offering a dead button", () => {
      // A parent link is recorded independently of family-group membership, so
      // a dependant can be recorded and still not be addable from this screen.
      renderResolution({ familyMembers: [] });

      expect(
        screen.queryByRole("button", { name: /book them as a member/i }),
      ).not.toBeInTheDocument();
      // What has to happen, and who can do it — see the dedicated describe
      // below for why this is the club rather than the member's own profile.
      expect(
        screen.getByText(/ask the club to put them in your family group/i),
      ).toBeInTheDocument();
      // The other answer stays available — the question still has two sides.
      expect(
        screen.getByRole("button", {
          name: /different person with the same name/i,
        }),
      ).toBeInTheDocument();
    });

    it("says so plainly when the dependant is already on the party", () => {
      renderResolution({ partyMemberIds: ["dep-sam"] });

      expect(
        screen.queryByRole("button", { name: /book them as a member/i }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByText(/already on this booking as a member/i),
      ).toBeInTheDocument();
    });
  });
});

describe("GuestsStep does not draw two controls for one decision (#2721)", () => {
  const guests: GuestData[] = [
    { firstName: "Sam", lastName: "Smith", ageTier: "CHILD", isMember: false },
  ];

  function renderStep(
    overrides: Partial<ComponentProps<typeof GuestsStep>> = {},
  ) {
    return render(
      <GuestsStep
        checkIn="2026-08-01"
        checkOut="2026-08-03"
        nights={2}
        familyMembers={[SAM_AS_FAMILY_MEMBER]}
        guests={guests}
        lodgeCapacity={8}
        capacityShortNights={[]}
        capacityShortMessage={null}
        addFamilyMemberAsGuest={vi.fn()}
        showInviteFamilyGroupMembersLink={false}
        handleGuestsChange={vi.fn()}
        perGuestDatesEnabled={false}
        handlePerGuestDatesEnabledChange={vi.fn()}
        multiDateRangesEnabled={false}
        handleMultiDateRangesEnabledChange={vi.fn()}
        priceQuote={null}
        groupBookingsEnabled={false}
        groupTrip={false}
        setGroupTrip={vi.fn()}
        groupPaymentMode="EACH_PAYS_OWN"
        setGroupPaymentMode={vi.fn()}
        setStep={vi.fn()}
        handleGuestsDone={vi.fn()}
        priceLoading={false}
        memberGuestEnabled={false}
        memberGuestOpenSearchEnabled={false}
        addMemberGuest={vi.fn()}
        memberGuestAddError={null}
        dependantIdentityCollisions={[]}
        declaredDependantMemberIds={[]}
        bookCollidingGuestAsDependant={vi.fn()}
        declareDependantDifferentPerson={vi.fn()}
        withdrawDependantDeclaration={vi.fn()}
        {...overrides}
      />,
    );
  }

  it("keeps the softer #1942 family suggestion when no dependant collision covers the name", () => {
    renderStep();
    expect(
      screen.getByText(/add these as member guests instead\?/i),
    ).toBeInTheDocument();
  });

  it("suppresses it for a name the hard question already covers", () => {
    // Otherwise the same name draws a dismissable "add them instead" beside a
    // block saying the booking cannot continue until it is resolved, and a
    // member can believe they answered when they only dismissed.
    renderStep({ dependantIdentityCollisions: [COLLISION] });

    expect(
      screen.queryByText(/add these as member guests instead\?/i),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/is this your own family member\?/i),
    ).toBeInTheDocument();
  });
});
