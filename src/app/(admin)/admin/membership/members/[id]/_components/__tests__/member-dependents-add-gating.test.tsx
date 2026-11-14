// @vitest-environment jsdom

/**
 * #2282 — "Add Dependent" as the admin actually meets it.
 *
 * What is pinned here, all of it a dead end before:
 *
 *  1. AGE NO LONGER HIDES THE CONTROL. The card used to render the button only
 *     for an ADULT and to explain the absence with "Only adult members can
 *     manage dependents" — copy for a rule the code no longer enforces, on a
 *     member who can now genuinely be a parent.
 *  2. AN INACTIVE, ARCHIVED OR ORGANISATION MEMBER SEES THE CONTROL DISABLED
 *     WITH THE REASON, and the reason is ATTACHED to it by `aria-describedby`
 *     rather than merely printed beside a control that is out of the tab order.
 *  3. THE DEAD END THIS CHANGE CREATED. A parent with no adult in reach who can
 *     receive club email is refused per TAB, because that is where the
 *     endpoints differ: the create tab always inherits and so always fails,
 *     while the link tab fails only for a notification choice that resolves to
 *     nobody. The opener stays enabled precisely because "use their own email"
 *     still works, and that is asserted rather than left implicit.
 *  4. BOTH LINK DIALOGS NAME THE MAILBOX, NOT THE MIDDLEMAN. The picker lists
 *     parents; the write stores whoever the walk lands on.
 *
 * The two "blocks the CREATE/LINK tab" cases at (2) are DEFENCE IN DEPTH, not a
 * screen an admin normally meets: both openers are already disabled for those
 * reasons and the member cannot change while the dialog is open. Do not read
 * them as evidence of admin-visible behaviour. The (3) cases are different —
 * nothing disables the opener there, so those are reachable.
 *
 * Mutation probes (all re-run and confirmed to fail): drop
 * `disabled={Boolean(blockReason)}` from the card or the dialog; drop either
 * tab's no-email-source block; drop the card's `aria-describedby`; make the
 * routing notice ignore the parent/mailbox mismatch; re-add the age condition
 * around the card's button.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@/lib/__tests__/support/club-time-render";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: {
      user: {
        id: "admin-1",
        adminPermissionMatrix: {
          overview: "edit",
          bookings: "edit",
          membership: "edit",
          finance: "edit",
          lodge: "edit",
          content: "edit",
          support: "edit",
        },
      },
    },
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

// The dialog reads club-configurable optional fields over the network; neither
// switch is what this file is about.
vi.mock("@/lib/use-member-fields-settings", () => ({
  useMemberFieldsSettings: () => ({ showTitle: false, showGender: false }),
}));

// The header renders a role-name picker that fetches its options; the fallback
// list it serves until then is fine for these assertions.
vi.mock("@/hooks/use-access-role-options", () => ({
  useAccessRoleOptions: () => [],
}));

import { MemberDependentsCard } from "../member-dependents-card";
import { MemberDependentDialog } from "../member-dependent-dialog";
import { MemberDetailHeader } from "../member-detail-header";
import { MemberParentLinkDialog } from "../member-parent-link-dialog";
import {
  DEPENDENT_PARENT_BLOCK_EXPLANATIONS,
  DEPENDENT_PARENT_CREATE_ERRORS,
  DEPENDENT_PARENT_LINK_ERRORS,
} from "@/lib/dependent-link-eligibility";
import type { MemberDetail } from "../../_types";

function buildMember(overrides: Partial<MemberDetail> = {}): MemberDetail {
  return {
    id: "member-1",
    firstName: "Tui",
    lastName: "Rangi",
    email: "tui@example.org",
    ageTier: "ADULT",
    // #2282 review: the parent-side rule is classified by ROLE, so the fixture
    // has to carry one. `NOT_APPLICABLE` is NOT the marker — age-exempt humans
    // carry that tier too — which is why these three fields exist here and
    // `ageTier` is not what any assertion below turns on.
    role: "USER",
    accessRoles: ["USER"],
    active: true,
    archivedAt: null,
    canLogin: true,
    dependents: [],
    parentLinks: [],
    familyGroups: [],
    inheritEmailFromId: null,
    inheritEmailFrom: null,
    dependentEmailSource: {
      id: "member-1",
      firstName: "Tui",
      lastName: "Rangi",
      email: "tui@example.org",
    },
    ...overrides,
  } as unknown as MemberDetail;
}

function renderCard(member: MemberDetail, onOpen = vi.fn()) {
  render(
    <MemberDependentsCard
      member={member}
      currentMemberPath="/admin/members/member-1"
      unlinkingDependentId={null}
      onOpenDependentDialog={onOpen}
      onUnlinkDependent={vi.fn()}
      canEdit
    />,
  );
  return onOpen;
}

function renderDialog(
  member: MemberDetail,
  mode: "create" | "link",
  overrides: Record<string, unknown> = {},
) {
  const onSubmitCreate = vi.fn();
  const onSubmitLink = vi.fn();
  render(
    <MemberDependentDialog
      open
      onOpenChange={vi.fn()}
      member={member}
      mode={mode}
      onChangeMode={vi.fn()}
      error=""
      saving={false}
      createForm={
        {
          title: "",
          gender: "",
          firstName: "",
          lastName: "",
          email: "",
          dateOfBirth: "",
          phoneCountryCode: "",
          phoneAreaCode: "",
          phoneNumber: "",
          streetAddressLine1: "",
          streetAddressLine2: "",
          streetCity: "",
          streetRegion: "",
          streetPostalCode: "",
          streetCountry: "New Zealand",
          postalAddressLine1: "",
          postalAddressLine2: "",
          postalCity: "",
          postalRegion: "",
          postalPostalCode: "",
          postalCountry: "New Zealand",
        } as never
      }
      createPostalSameAsPhysical={false}
      onChangeCreateForm={vi.fn()}
      onChangeCreatePostalSameAsPhysical={vi.fn()}
      onChangeCreateAddressFields={vi.fn()}
      onSubmitCreate={onSubmitCreate}
      linkSearch=""
      linkSearching={false}
      linkSearchResults={[]}
      linkIneligibleMatches={[]}
      linkSearchMatchedNobody={false}
      linkSelected={
        {
          id: "target-1",
          firstName: "Kea",
          lastName: "Rangi",
          email: "kea@example.org",
          ageTier: "INFANT",
          active: true,
          canLogin: false,
          dateOfBirth: null,
          parentLinks: [],
        } as never
      }
      linkNotificationParentId=""
      linkDisableLogin={false}
      linkFamilyGroupIds={[]}
      onChangeLinkSearch={vi.fn()}
      onSelectLinkCandidate={vi.fn()}
      onClearLinkSelection={vi.fn()}
      onChangeLinkNotificationParentId={vi.fn()}
      onChangeLinkDisableLogin={vi.fn()}
      onToggleLinkFamilyGroup={vi.fn()}
      onSubmitLink={onSubmitLink}
      {...overrides}
    />,
  );
  return { onSubmitCreate, onSubmitLink };
}

/**
 * The link tabs ask the server where the chosen parent's mail actually lands
 * (`GET /api/admin/members/[id]/dependent-email-source`, the same walk the write
 * uses). Stubbed per test; tests that select nobody never reach it.
 */
function mockEmailSourceResponse(body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => body,
    })) as unknown as typeof fetch,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MemberDependentsCard — who may be offered a dependant (#2282)", () => {
  it("offers Add Dependent on a YOUTH member", () => {
    const onOpen = renderCard(buildMember({ ageTier: "YOUTH" }));
    const button = screen.getByRole("button", { name: /add dependent/i });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalled();
  });

  it("no longer claims only adults can manage dependents", () => {
    renderCard(buildMember({ ageTier: "YOUTH" }));
    expect(screen.queryByText(/only adult members/i)).not.toBeInTheDocument();
    expect(
      screen.getByText(/no dependents linked to this member yet/i),
    ).toBeInTheDocument();
  });

  it("disables the control WITH the reason for an inactive member", () => {
    const onOpen = renderCard(buildMember({ active: false }));
    expect(screen.getByRole("button", { name: /add dependent/i })).toBeDisabled();
    expect(
      screen.getByText(DEPENDENT_PARENT_BLOCK_EXPLANATIONS.INACTIVE),
    ).toBeInTheDocument();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("says ARCHIVED rather than INACTIVE for an archived member", () => {
    renderCard(
      buildMember({ active: false, archivedAt: "2026-01-01T00:00:00.000Z" }),
    );
    expect(screen.getByRole("button", { name: /add dependent/i })).toBeDisabled();
    expect(
      screen.getByText(DEPENDENT_PARENT_BLOCK_EXPLANATIONS.ARCHIVED),
    ).toBeInTheDocument();
  });

  it("names the adult a dependant's club email would reach", () => {
    renderCard(
      buildMember({
        ageTier: "YOUTH",
        dependentEmailSource: {
          id: "gran-1",
          firstName: "Nan",
          lastName: "Rangi",
          email: "nan@example.org",
        },
      }),
    );
    expect(screen.getByText(/nan@example\.org/i)).toBeInTheDocument();
  });

  it("says so plainly when no adult in the family can receive mail", () => {
    renderCard(
      buildMember({ ageTier: "YOUTH", dependentEmailSource: null }),
    );
    expect(
      screen.getByText(/no adult the club can email is recorded/i),
    ).toBeInTheDocument();
  });

  it("still OFFERS the control when no adult can receive mail", () => {
    // Deliberate, and the reason the block for this case lives on the tabs
    // rather than on the opener: "Link existing" with "Use their own email"
    // records the relationship without needing a contact of record at all, and
    // linking an ADULT dependent does not inherit in the first place. Disabling
    // the opener would remove a route that works.
    const onOpen = renderCard(
      buildMember({ ageTier: "YOUTH", dependentEmailSource: null }),
    );
    const button = screen.getByRole("button", { name: /add dependent/i });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalled();
  });

  it("disables the control for an ORGANISATION account, with the reason", () => {
    // #2282 review: the owner decision was about AGE. Dropping the ADULT clause
    // also dropped the only thing keeping organisation and school accounts out
    // of the parent-candidate search, and a school is not anybody's parent.
    renderCard(
      buildMember({
        role: "SCHOOL",
        accessRoles: ["ORG"],
        ageTier: "NOT_APPLICABLE",
      }),
    );
    expect(screen.getByRole("button", { name: /add dependent/i })).toBeDisabled();
    expect(
      screen.getByText(DEPENDENT_PARENT_BLOCK_EXPLANATIONS.ORGANISATION),
    ).toBeInTheDocument();
  });

  it("keeps the control for an age-exempt HUMAN on the same tier", () => {
    // The other half of the same rule, and the reason it is classified by role:
    // `NOT_APPLICABLE` is the age-EXEMPT tier (#1440, #2106), carried by real
    // people as well as by organisations. A tier-based exclusion would bar them
    // and tell them they are an organisation.
    renderCard(
      buildMember({ ageTier: "NOT_APPLICABLE", role: "USER", accessRoles: [] }),
    );
    expect(screen.getByRole("button", { name: /add dependent/i })).toBeEnabled();
  });

  it("attaches the reason to the button, not merely beside it", () => {
    // A disabled button is out of the tab order and fires no hover event
    // (`disabled:pointer-events-none`), so a nearby paragraph and a `title` are
    // both unreachable. `aria-describedby` is the association that works.
    renderCard(buildMember({ active: false }));
    const button = screen.getByRole("button", { name: /add dependent/i });
    const describedBy = button.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(
      document.getElementById(describedBy as string)?.textContent,
    ).toBe(DEPENDENT_PARENT_BLOCK_EXPLANATIONS.INACTIVE);
  });

  it("stays quiet about routing when the member is their own source", () => {
    // The ordinary case. Saying "email goes to Tui Rangi" on Tui's own page is
    // noise, and noise is how the load-bearing sentence stops being read.
    renderCard(buildMember());
    expect(screen.queryByText(/goes to/i)).not.toBeInTheDocument();
  });
});

describe("MemberDependentDialog — both paths are gated, not one (#2282)", () => {
  it("blocks the CREATE tab with the create-path message", () => {
    const { onSubmitCreate } = renderDialog(
      buildMember({ active: false }),
      "create",
    );
    const submit = screen.getByRole("button", { name: /create dependent/i });
    expect(submit).toBeDisabled();
    expect(
      screen.getByText(DEPENDENT_PARENT_CREATE_ERRORS.INACTIVE),
    ).toBeInTheDocument();
    fireEvent.click(submit);
    expect(onSubmitCreate).not.toHaveBeenCalled();
  });

  it("blocks the LINK tab with the link-path message", () => {
    const { onSubmitLink } = renderDialog(
      buildMember({ active: false }),
      "link",
    );
    const submit = screen.getByRole("button", { name: /link dependent/i });
    expect(submit).toBeDisabled();
    expect(
      screen.getByText(DEPENDENT_PARENT_LINK_ERRORS.INACTIVE),
    ).toBeInTheDocument();
    fireEvent.click(submit);
    expect(onSubmitLink).not.toHaveBeenCalled();
  });

  it("leaves both paths usable on a YOUTH parent whose record is current", () => {
    const { onSubmitCreate } = renderDialog(
      buildMember({ ageTier: "YOUTH" }),
      "create",
    );
    const submit = screen.getByRole("button", { name: /create dependent/i });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    expect(onSubmitCreate).toHaveBeenCalled();
  });

  it("blocks the CREATE tab when no adult in reach can receive club email", async () => {
    // The dead end THIS issue created, and the flagship #2282 case: a YOUTH
    // parent whose own parent is not a member. The tab always inherits, so the
    // create route refuses every time — it used to warn and leave the button
    // live, which is the "offered, then fails on save" shape scope item 4 was
    // written to remove.
    const { onSubmitCreate } = renderDialog(
      buildMember({ ageTier: "YOUTH", dependentEmailSource: null }),
      "create",
    );
    const submit = screen.getByRole("button", { name: /create dependent/i });
    expect(submit).toBeDisabled();
    expect(
      screen.getByText(/no adult the club can email is recorded/i),
    ).toBeInTheDocument();
    // …and it names the route that does work, rather than only refusing.
    // Scoped to the sentence's own emphasis so it cannot pass by matching the
    // tab trigger of the same name.
    expect(
      screen.getByText("Link existing", { selector: "strong" }),
    ).toBeInTheDocument();
    fireEvent.click(submit);
    expect(onSubmitCreate).not.toHaveBeenCalled();
  });

  it("names the real recipient on the LINK tab, not the chosen parent", async () => {
    // The picker lists PARENTS and pre-selects the viewed member; the write
    // walks past a parent who cannot be the contact of record and stores the
    // nearest adult ancestor. The screen said "Tui Rangi (Primary parent)" while
    // the stored contact was Nan Rangi, and nothing said so.
    mockEmailSourceResponse({
      source: {
        id: "gran-1",
        firstName: "Nan",
        lastName: "Rangi",
        email: "nan@example.org",
      },
    });
    renderDialog(buildMember({ ageTier: "YOUTH" }), "link", {
      linkNotificationParentId: "member-1",
    });
    expect(
      await screen.findByText(
        /Club notifications will go to Nan Rangi \(nan@example\.org\), not Tui Rangi/i,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /link dependent/i })).toBeEnabled();
  });

  it("blocks the LINK tab when the chosen parent reaches nobody", async () => {
    mockEmailSourceResponse({ source: null });
    const { onSubmitLink } = renderDialog(
      buildMember({ ageTier: "YOUTH", dependentEmailSource: null }),
      "link",
      { linkNotificationParentId: "member-1" },
    );
    expect(
      await screen.findByText(/cannot be routed through them/i),
    ).toBeInTheDocument();
    const submit = screen.getByRole("button", { name: /link dependent/i });
    expect(submit).toBeDisabled();
    fireEvent.click(submit);
    expect(onSubmitLink).not.toHaveBeenCalled();
  });

  it("leaves the LINK tab usable when the admin routes nowhere", async () => {
    // "Use their own email" needs no contact of record at all, which is why the
    // opener stays enabled for this member — see the card suite above.
    const { onSubmitLink } = renderDialog(
      buildMember({ ageTier: "YOUTH", dependentEmailSource: null }),
      "link",
      { linkNotificationParentId: "" },
    );
    const submit = screen.getByRole("button", { name: /link dependent/i });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    expect(onSubmitLink).toHaveBeenCalled();
  });

  it("tells the admin which mailbox a created dependant will inherit", () => {
    renderDialog(
      buildMember({
        ageTier: "YOUTH",
        dependentEmailSource: {
          id: "gran-1",
          firstName: "Nan",
          lastName: "Rangi",
          email: "nan@example.org",
        },
      }),
      "create",
    );
    expect(
      screen.getByText(/notifications for them go to Nan Rangi/i),
    ).toBeInTheDocument();
  });
});

/**
 * The SECOND entry point. `Add Dependent` sits in the page header toolbar as
 * well as on the Dependents card, and before #2282 both hid on the same
 * condition — so fixing one and not the other would leave the identical dead
 * end one scroll position away.
 */
describe("MemberDetailHeader — the toolbar copy of the same control (#2282)", () => {
  function renderHeader(member: MemberDetail, onOpen = vi.fn()) {
    render(
      <MemberDetailHeader
        member={member}
        backHref="/admin/members"
        backLabel="Members"
        pendingDeleteRequest={undefined}
        xeroConnected={false}
        xeroOrgShortCode={null}
        xeroPushing={false}
        xeroUnlinking={false}
        canEditMembership
        canEditFinance
        onOpenDependentDialog={onOpen}
        onOpenLinkXero={vi.fn()}
        onOpenCreateXero={vi.fn()}
        onUnlinkXero={vi.fn()}
      />,
    );
    return onOpen;
  }

  it("offers Add Dependent on a YOUTH member", () => {
    const onOpen = renderHeader(buildMember({ ageTier: "YOUTH" }));
    const button = screen.getByRole("button", { name: /add dependent/i });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalled();
  });

  it("disables it WITH the reason when the member is inactive", () => {
    renderHeader(buildMember({ active: false }));
    expect(screen.getByRole("button", { name: /add dependent/i })).toBeDisabled();
    expect(
      screen.getByText(DEPENDENT_PARENT_BLOCK_EXPLANATIONS.INACTIVE),
    ).toBeInTheDocument();
  });

  it("disables it WITH the reason when the member is archived", () => {
    renderHeader(
      buildMember({ active: false, archivedAt: "2026-01-01T00:00:00.000Z" }),
    );
    expect(screen.getByRole("button", { name: /add dependent/i })).toBeDisabled();
    expect(
      screen.getByText(DEPENDENT_PARENT_BLOCK_EXPLANATIONS.ARCHIVED),
    ).toBeInTheDocument();
  });
});

/**
 * The MIRROR dialog. "Link Parent" adds a parent ABOVE the viewed member, and it
 * has the same notification-recipient picker with the same problem: the options
 * name parents, the write stores whoever the walk lands on, and the two differ
 * routinely now that a parent may be any age.
 */
describe("MemberParentLinkDialog — the same picker, the same truth (#2282)", () => {
  const candidate = {
    id: "tui",
    firstName: "Tui",
    lastName: "Rangi",
    email: "tui@example.org",
    ageTier: "YOUTH",
    active: true,
    canLogin: false,
    dateOfBirth: null,
    familyGroups: [],
  };

  function renderParentDialog(overrides: Record<string, unknown> = {}) {
    const onSubmit = vi.fn();
    render(
      <MemberParentLinkDialog
        open
        onOpenChange={vi.fn()}
        member={buildMember({ ageTier: "CHILD" })}
        search=""
        searching={false}
        searchResults={[]}
        selected={candidate as never}
        notificationParentId="tui"
        disableLogin={false}
        familyGroupIds={[]}
        saving={false}
        error=""
        onChangeSearch={vi.fn()}
        onSelectCandidate={vi.fn()}
        onClearSelection={vi.fn()}
        onChangeNotificationParentId={vi.fn()}
        onChangeDisableLogin={vi.fn()}
        onToggleFamilyGroup={vi.fn()}
        onSubmit={onSubmit}
        {...overrides}
      />,
    );
    return onSubmit;
  }

  it("names the adult the mail reaches, not the parent that was picked", async () => {
    mockEmailSourceResponse({
      source: {
        id: "gran-1",
        firstName: "Nan",
        lastName: "Rangi",
        email: "nan@example.org",
      },
    });
    renderParentDialog();
    expect(
      await screen.findByText(
        /Club notifications will go to Nan Rangi \(nan@example\.org\), not Tui Rangi/i,
      ),
    ).toBeInTheDocument();
  });

  it("refuses the save when the chosen parent reaches nobody", async () => {
    mockEmailSourceResponse({ source: null });
    const onSubmit = renderParentDialog();
    expect(
      await screen.findByText(/cannot be routed through them/i),
    ).toBeInTheDocument();
    const submit = screen.getByRole("button", { name: /link parent/i });
    expect(submit).toBeDisabled();
    fireEvent.click(submit);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("states the limit of 'any age' so it cannot be read as covering orgs", () => {
    // The copy said "an active member of any age" with nothing else, which read
    // as though offering a school account were intended.
    renderParentDialog({ notificationParentId: "" });
    expect(
      screen.getByText(/organisation and school accounts are not people/i),
    ).toBeInTheDocument();
  });
});
