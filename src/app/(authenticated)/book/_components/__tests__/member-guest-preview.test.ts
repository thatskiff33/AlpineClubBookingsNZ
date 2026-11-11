// MG3 (#2308) — the wizard's consent PREVIEW, and the family-scope trap.
//
// The wizard shows a badge before anything is persisted, so what it shows is a
// prediction. The prediction has one non-obvious case that is easy to get wrong:
// D-9 makes any active member resolvable by email, INCLUDING the booker's own
// family, so the finder can perfectly well produce a family-scope add — which is
// consent-free (D-6) and must carry no badge at all.
import { describe, expect, it } from "vitest";

import type { GuestData } from "@/components/guest-form";
import { classifyMemberGuestConsent } from "@/lib/member-guest-consent";
import {
  memberGuestConsentPreviewColumns,
  pendingMemberGuestFirstNames,
  describeMemberGuestWizardHelper,
  predictMemberGuestConsent,
} from "@/components/book/member-guest-preview";

const FAMILY = ["m-self", "m-partner", "m-child"];

describe("predictMemberGuestConsent", () => {
  it("predicts nothing at all for the booker's own family, whatever the policy", () => {
    for (const approvalRequired of [true, false]) {
      for (const memberId of FAMILY) {
        expect(
          predictMemberGuestConsent({
            candidateMemberId: memberId,
            familyMemberIds: FAMILY,
            familyMembersLoaded: true,
            approvalRequired,
            actorKind: "MEMBER",
          }),
        ).toBeUndefined();
      }
    }
  });

  it("predicts an ask for a beyond-family member under the shipped default", () => {
    expect(
      predictMemberGuestConsent({
        candidateMemberId: "m-stranger",
        familyMemberIds: FAMILY,
        familyMembersLoaded: true,
        approvalRequired: true,
        actorKind: "MEMBER",
      }),
    ).toBe("PENDING");
  });

  it("predicts NOTHING at all when the family list never loaded", () => {
    // The guard the correctness review asked for. A failed `/api/members/family`
    // leaves an empty list, which makes every candidate look beyond-family — and
    // the booker is MOST likely to reach for the finder in exactly that state,
    // because the quick-add row is empty too. A missing badge under-informs; a
    // wrong PENDING badge promises an email that is never sent.
    expect(
      predictMemberGuestConsent({
        candidateMemberId: "m-child",
        familyMemberIds: [],
        familyMembersLoaded: false,
        approvalRequired: true,
        actorKind: "MEMBER",
      }),
    ).toBeUndefined();
    expect(
      predictMemberGuestConsent({
        candidateMemberId: "m-stranger",
        familyMemberIds: [],
        familyMembersLoaded: false,
        approvalRequired: true,
        actorKind: "MEMBER",
      }),
    ).toBeUndefined();
  });

  it("predicts a notice for a beyond-family member under the notify-only opt-down", () => {
    expect(
      predictMemberGuestConsent({
        candidateMemberId: "m-stranger",
        familyMemberIds: FAMILY,
        familyMembersLoaded: true,
        approvalRequired: false,
        actorKind: "MEMBER",
      }),
    ).toBe("NOTIFY_ONLY");
  });

  it("predicts the admin-assigned outcome for an OFFICER, whatever the club asked for", () => {
    // MG4 (#2309), and the divergence this parameter exists to close. The
    // server's admin branch runs BEFORE `approvalRequired` is consulted at all
    // (`buildMemberGuestConsentWrite`), so an officer's add is CONFIRMED and
    // consent-free on an ask-first club exactly as on a notify-only one. A
    // prediction that read only the setting told the officer their add was
    // waiting for an answer that was never going to be asked for.
    for (const approvalRequired of [true, false]) {
      expect(
        predictMemberGuestConsent({
          candidateMemberId: "m-stranger",
          familyMemberIds: FAMILY,
          familyMembersLoaded: true,
          approvalRequired,
          actorKind: "ADMIN",
        }),
      ).toBe("ADMIN_ASSIGNED");
    }
  });

  it("still predicts nothing for an officer adding somebody inside the OWNER's family", () => {
    // The family boundary is not an admin-mode exception: a family-scope add is
    // consent-free under D-6 whoever performs it, so an ADMIN_ASSIGNED badge
    // over one would claim a record the server does not write.
    expect(
      predictMemberGuestConsent({
        candidateMemberId: "m-child",
        familyMemberIds: FAMILY,
        familyMembersLoaded: true,
        approvalRequired: true,
        actorKind: "ADMIN",
      }),
    ).toBeUndefined();
  });

  it("still predicts nothing for an officer when the family list never loaded", () => {
    expect(
      predictMemberGuestConsent({
        candidateMemberId: "m-stranger",
        familyMemberIds: [],
        familyMembersLoaded: false,
        approvalRequired: true,
        actorKind: "ADMIN",
      }),
    ).toBeUndefined();
  });
});

describe("memberGuestConsentPreviewColumns", () => {
  it("builds shapes that are LEGAL sub-states, not approximations", () => {
    const pending = memberGuestConsentPreviewColumns({
      memberGuestConsentPreview: "PENDING",
    })!;
    // The PENDING branch of the badge function does not classify, so a null
    // expiry here is safe — and it is what stops an invented deadline reaching
    // the screen. What must NOT happen is a shape that classifies as something
    // else entirely.
    expect(pending.consentStatus).toBe("PENDING");
    expect(pending.consentExpiresAt).toBeNull();

    const notifyOnly = memberGuestConsentPreviewColumns({
      memberGuestConsentPreview: "NOTIFY_ONLY",
    })!;
    expect(classifyMemberGuestConsent(notifyOnly, "m-stranger")).toBe(
      "NOTIFY_ONLY_AUTO_CONFIRMED",
    );

    // MG4 (#2309): an officer's add. It must classify as ADMIN_ASSIGNED and NOT
    // as NOTIFY_ONLY_AUTO_CONFIRMED — the two differ only by the presence of a
    // responder, and collapsing them would draw "Told, not asked" over a row the
    // club itself placed.
    const adminAssigned = memberGuestConsentPreviewColumns({
      memberGuestConsentPreview: "ADMIN_ASSIGNED",
    })!;
    expect(classifyMemberGuestConsent(adminAssigned, "m-stranger")).toBe(
      "ADMIN_ASSIGNED",
    );
    // The two non-null columns are sentinels, never rendered by the only
    // audience a preview reaches. The epoch date is the point: a plausible
    // timestamp is the one that survives into a surface that does render it.
    expect(adminAssigned.consentRespondedAt?.getTime()).toBe(0);
    expect(adminAssigned.consentExpiresAt).toBeNull();
  });

  it("gives every other guest row no columns at all, so it renders exactly as before", () => {
    expect(memberGuestConsentPreviewColumns({})).toBeNull();
    expect(
      memberGuestConsentPreviewColumns({ memberGuestConsentPreview: undefined }),
    ).toBeNull();
  });
});

describe("pendingMemberGuestFirstNames", () => {
  it("names only the guests whose answer is genuinely still awaited", () => {
    const guests = [
      { firstName: "Jordan", memberGuestConsentPreview: undefined },
      { firstName: "Sam", memberGuestConsentPreview: "PENDING" },
      { firstName: "Daniel", memberGuestConsentPreview: "NOTIFY_ONLY" },
      { firstName: "Anna", memberGuestConsentPreview: "PENDING" },
    ] as GuestData[];
    expect(pendingMemberGuestFirstNames(guests)).toEqual(["Sam", "Anna"]);
  });

  it("is empty for an ordinary family booking, so the explainer never renders", () => {
    const guests = [
      { firstName: "Jordan" },
      { firstName: "Mia" },
    ] as GuestData[];
    expect(pendingMemberGuestFirstNames(guests)).toEqual([]);
  });
});

describe("describeMemberGuestWizardHelper", () => {
  it("replaces the family sentence for somebody who is emphatically not family", () => {
    // `GuestForm`'s default sentence — "Linked family members keep their member
    // details and member pricing." — is printed for every row carrying a
    // memberId, which until MG3 could only ever BE family. A PENDING Sam
    // Whittaker was being told he was the booker's linked family member.
    expect(
      describeMemberGuestWizardHelper({
        firstName: "Sam",
        memberGuestConsentPreview: "PENDING",
      }),
    ).toBe(
      "Sam will be emailed when you confirm this booking, and their bed is held until they answer.",
    );
  });

  it("does not claim an email has already been sent, because none has", () => {
    // Declared divergence from mockup panel 11, recorded there with a dated
    // note: in the wizard no booking exists yet, so nothing has been sent and no
    // bed is held until the booker confirms.
    const helper = describeMemberGuestWizardHelper({
      firstName: "Sam",
      memberGuestConsentPreview: "PENDING",
    });
    expect(helper).not.toContain("has been emailed");
  });

  it("describes the notify-only world in the club's terms", () => {
    expect(
      describeMemberGuestWizardHelper({
        firstName: "Daniel",
        memberGuestConsentPreview: "NOTIFY_ONLY",
      }),
    ).toBe("Your club adds member guests straight away and emails them to say so.");
  });

  it("leaves every other row's sentence exactly where it was", () => {
    expect(
      describeMemberGuestWizardHelper({
        firstName: "Mia",
        memberGuestConsentPreview: undefined,
      }),
    ).toBeNull();
  });
});
