import { describe, expect, it } from "vitest";
import {
  MEMBER_SELF_RELATION_COLUMNS,
  describeFamilyLinkDrift,
  diffSelfRelationLinkState,
  memberMergeConfirmationPhrase,
  normalizeConfirmationText,
  partitionKeyedCollisions,
  planPartnerLinkMerge,
  type PartnerLinkRow,
} from "@/lib/member-merge";
import { diffFieldMergePatches, mergeMemberFields } from "@/lib/member-merge-field-rules";
import { MEMBER_MERGE_RELATION_SPECS } from "@/lib/member-merge-relations";
import { MEMBER_MERGE_SNAPSHOT_SCALAR_COLUMNS } from "@/lib/member-merge-snapshot-columns";

function baseMember(overrides: Record<string, unknown> = {}) {
  return {
    id: "m",
    email: "a@b.com",
    firstName: "First",
    lastName: "Last",
    title: null,
    gender: null,
    dateOfBirth: null,
    occupation: null,
    phoneCountryCode: null,
    phoneAreaCode: null,
    phoneNumber: null,
    streetAddressLine1: null,
    streetAddressLine2: null,
    streetCity: null,
    streetRegion: null,
    streetPostalCode: null,
    streetCountry: null,
    postalAddressLine1: null,
    postalAddressLine2: null,
    postalCity: null,
    postalRegion: null,
    postalPostalCode: null,
    postalCountry: null,
    lifeMemberDate: null,
    comments: null,
    familyGroupId: null,
    requiresInduction: false,
    hutLeaderEligible: false,
    hutLeaderEligibleAt: null,
    joinedDate: null,
    ...overrides,
  };
}

describe("mergeMemberFields", () => {
  it("fills a blank master field from the loser", () => {
    const { patch, diff } = mergeMemberFields(
      baseMember({ occupation: null }),
      baseMember({ occupation: "Engineer" }),
    );
    expect(patch.occupation).toBe("Engineer");
    expect(diff.find((r) => r.field === "occupation")?.source).toBe("loser");
  });

  it("never fills postLoginLanding from the loser (#2090 — dropped on merge)", () => {
    const { patch, diff } = mergeMemberFields(
      baseMember({ postLoginLanding: null }),
      baseMember({ postLoginLanding: "ADMIN_DASHBOARD" }),
    );
    // A per-account UI preference is not shared personal data: the master keeps
    // its own (null = role default) and the loser's is dropped, not filled in.
    expect(patch.postLoginLanding).toBeUndefined();
    expect(diff.find((r) => r.field === "postLoginLanding")).toBeUndefined();
  });

  it("keeps a populated master field (master wins)", () => {
    const { patch, diff } = mergeMemberFields(
      baseMember({ occupation: "Doctor" }),
      baseMember({ occupation: "Engineer" }),
    );
    expect(patch.occupation).toBeUndefined();
    expect(diff.find((r) => r.field === "occupation")?.result).toBe("Doctor");
  });

  it("treats whitespace-only master strings as blank", () => {
    const { patch } = mergeMemberFields(
      baseMember({ comments: "   " }),
      baseMember({ comments: "real note" }),
    );
    expect(patch.comments).toBe("real note");
  });

  it("fills the whole phone group from the loser only when master's number is blank", () => {
    const { patch } = mergeMemberFields(
      baseMember({ phoneNumber: null }),
      baseMember({ phoneCountryCode: "64", phoneAreaCode: "27", phoneNumber: "123" }),
    );
    expect(patch.phoneCountryCode).toBe("64");
    expect(patch.phoneAreaCode).toBe("27");
    expect(patch.phoneNumber).toBe("123");
  });

  it("never Frankensteins the phone group when master already has a number", () => {
    const { patch } = mergeMemberFields(
      baseMember({ phoneCountryCode: "64", phoneNumber: "999" }),
      baseMember({ phoneCountryCode: "1", phoneAreaCode: "555", phoneNumber: "123" }),
    );
    expect(patch.phoneCountryCode).toBeUndefined();
    expect(patch.phoneAreaCode).toBeUndefined();
    expect(patch.phoneNumber).toBeUndefined();
  });

  it("keeps the master's photo when it has one (photo master-wins, MP1)", () => {
    const { patch } = mergeMemberFields(
      baseMember({
        photoImageId: "master-img",
        photoUpdatedAt: new Date("2026-01-01T00:00:00Z"),
        photoUpdatedByMemberId: "m",
      }),
      baseMember({
        photoImageId: "loser-img",
        photoUpdatedAt: new Date("2026-02-01T00:00:00Z"),
        photoUpdatedByMemberId: "l",
      }),
    );
    // Master already has a photo: none of the photo group is overwritten.
    expect(patch.photoImageId).toBeUndefined();
    expect(patch.photoUpdatedAt).toBeUndefined();
    expect(patch.photoUpdatedByMemberId).toBeUndefined();
  });

  it("absorbs the loser's whole photo group only when the master has none (MP1)", () => {
    const loserUpdatedAt = new Date("2026-02-01T00:00:00Z");
    const { patch } = mergeMemberFields(
      baseMember({ photoImageId: null, photoUpdatedAt: null, photoUpdatedByMemberId: null }),
      baseMember({
        photoImageId: "loser-img",
        photoUpdatedAt: loserUpdatedAt,
        photoUpdatedByMemberId: "l",
      }),
    );
    expect(patch.photoImageId).toBe("loser-img");
    expect(patch.photoUpdatedAt).toBe(loserUpdatedAt);
    expect(patch.photoUpdatedByMemberId).toBe("l");
  });

  it("never Frankensteins the photo group when master already has a photo (MP1)", () => {
    const { patch } = mergeMemberFields(
      baseMember({ photoImageId: "master-img", photoUpdatedAt: null, photoUpdatedByMemberId: null }),
      baseMember({
        photoImageId: "loser-img",
        photoUpdatedAt: new Date("2026-02-01T00:00:00Z"),
        photoUpdatedByMemberId: "l",
      }),
    );
    // The key (photoImageId) is set on the master, so the whole group stays the
    // master's — the loser's photoUpdatedAt/By never leak in.
    expect(patch.photoImageId).toBeUndefined();
    expect(patch.photoUpdatedAt).toBeUndefined();
    expect(patch.photoUpdatedByMemberId).toBeUndefined();
  });

  it("ORs requiresInduction and hutLeaderEligible", () => {
    const { patch } = mergeMemberFields(
      baseMember({ requiresInduction: false, hutLeaderEligible: false }),
      baseMember({ requiresInduction: true, hutLeaderEligible: true }),
    );
    expect(patch.requiresInduction).toBe(true);
    expect(patch.hutLeaderEligible).toBe(true);
  });

  it("sets hutLeaderEligibleAt to the earliest when either is eligible", () => {
    const early = new Date("2020-01-01");
    const late = new Date("2023-01-01");
    const { patch } = mergeMemberFields(
      baseMember({ hutLeaderEligible: false, hutLeaderEligibleAt: late }),
      baseMember({ hutLeaderEligible: true, hutLeaderEligibleAt: early }),
    );
    expect((patch.hutLeaderEligibleAt as Date).getTime()).toBe(early.getTime());
  });

  it("takes the earliest joinedDate", () => {
    const early = new Date("2015-06-01");
    const late = new Date("2019-06-01");
    const { patch } = mergeMemberFields(
      baseMember({ joinedDate: late }),
      baseMember({ joinedDate: early }),
    );
    expect((patch.joinedDate as Date).getTime()).toBe(early.getTime());
  });

  it("keeps master's joinedDate when it is already the earliest", () => {
    const early = new Date("2015-06-01");
    const late = new Date("2019-06-01");
    const { patch } = mergeMemberFields(
      baseMember({ joinedDate: early }),
      baseMember({ joinedDate: late }),
    );
    expect(patch.joinedDate).toBeUndefined();
  });

  it("never merges auth/identity fields (email, passwordHash, 2FA, xeroContactId, role)", () => {
    const { patch } = mergeMemberFields(
      baseMember({ email: "master@x.com" }),
      baseMember({
        email: "loser@x.com",
        passwordHash: "loserhash",
        xeroContactId: "xero-loser",
        role: "ADMIN",
        canLogin: true,
        emailVerified: true,
        twoFactorEnabled: true,
        totpSecret: "secret",
      }),
    );
    for (const forbidden of [
      "email",
      "passwordHash",
      "xeroContactId",
      "role",
      "canLogin",
      "emailVerified",
      "twoFactorEnabled",
      "totpSecret",
    ]) {
      expect(patch[forbidden]).toBeUndefined();
    }
  });
});

describe("patch derivation from a snapshot versus a fresh read (#2243)", () => {
  // The merge derives its field patch twice: once from the transaction-opening
  // snapshot (what the preview token pins) and once from a read taken just
  // before the write. These prove the two derivations really do diverge when a
  // writer outside the member-lifecycle lock moves the loser mid-transaction,
  // and that the divergence is reported field by field.

  it("names a stale FK value: the snapshot patch writes a deleted blob, the fresh one does not", () => {
    // `Member.photoImageId` is a real FK. An on-behalf photo upload for the
    // loser deletes blob L1 and repoints the loser to L2, so a patch derived
    // from the snapshot names a row that no longer exists — Postgres 23503 /
    // Prisma P2003, rolling the whole merge back.
    const master = baseMember({ id: "master", photoImageId: null });
    const snapshotLoser = baseMember({ id: "loser", photoImageId: "L1" });
    const freshLoser = baseMember({ id: "loser", photoImageId: "L2" });

    const fromSnapshot = mergeMemberFields(master, snapshotLoser).patch;
    const fromFresh = mergeMemberFields(master, freshLoser).patch;

    expect(fromSnapshot.photoImageId).toBe("L1");
    expect(fromFresh.photoImageId).toBe("L2");
    expect(diffFieldMergePatches(fromSnapshot, fromFresh)).toEqual(["photoImageId"]);
  });

  it("names a stale familyGroupId — the patch's OTHER real FK", () => {
    // The same class, not a photo quirk: a club admin can delete the group
    // (SetNull) without taking the member-lifecycle lock, so the snapshot's
    // group id can name a deleted FamilyGroup row by write time.
    const master = baseMember({ id: "master", familyGroupId: null });
    const snapshotLoser = baseMember({ id: "loser", familyGroupId: "fg-old" });
    const freshLoser = baseMember({ id: "loser", familyGroupId: null });

    expect(
      diffFieldMergePatches(
        mergeMemberFields(master, snapshotLoser).patch,
        mergeMemberFields(master, freshLoser).patch,
      ),
    ).toEqual(["familyGroupId"]);
  });

  it("treats a field written as null differently from a field not written at all", () => {
    const master = baseMember({ id: "master", photoImageId: null });
    // Group fills carry the whole group, so the absorbed photo group writes
    // photoUpdatedAt/photoUpdatedByMemberId as null alongside the id.
    const withPhoto = baseMember({
      id: "loser",
      photoImageId: "L1",
      photoUpdatedAt: null,
      photoUpdatedByMemberId: null,
    });
    const withoutPhoto = baseMember({ id: "loser", photoImageId: null });

    expect(
      diffFieldMergePatches(
        mergeMemberFields(master, withPhoto).patch,
        mergeMemberFields(master, withoutPhoto).patch,
      ),
    ).toEqual(["photoImageId", "photoUpdatedAt", "photoUpdatedByMemberId"]);
  });

  it("reports nothing when the two reads agree, even across separate Date objects", () => {
    // Two reads of the same row produce equal-but-distinct Dates; comparing by
    // identity would report drift on every single merge that fills a date.
    const master = baseMember({ id: "master", joinedDate: new Date("2024-01-01T00:00:00Z") });
    const snapshotLoser = baseMember({
      id: "loser",
      joinedDate: new Date("2020-06-01T00:00:00Z"),
    });
    const freshLoser = baseMember({
      id: "loser",
      joinedDate: new Date("2020-06-01T00:00:00Z"),
    });

    const fromSnapshot = mergeMemberFields(master, snapshotLoser).patch;
    const fromFresh = mergeMemberFields(master, freshLoser).patch;

    expect(fromSnapshot.joinedDate).toBeInstanceOf(Date);
    expect(fromSnapshot.joinedDate).not.toBe(fromFresh.joinedDate);
    expect(diffFieldMergePatches(fromSnapshot, fromFresh)).toEqual([]);
  });

  it("reports a date whose instant really did move", () => {
    const master = baseMember({ id: "master", joinedDate: new Date("2024-01-01T00:00:00Z") });
    const snapshotLoser = baseMember({
      id: "loser",
      joinedDate: new Date("2020-06-01T00:00:00Z"),
    });
    const freshLoser = baseMember({
      id: "loser",
      joinedDate: new Date("2019-02-03T00:00:00Z"),
    });

    expect(
      diffFieldMergePatches(
        mergeMemberFields(master, snapshotLoser).patch,
        mergeMemberFields(master, freshLoser).patch,
      ),
    ).toEqual(["joinedDate"]);
  });

  it("covers every patch-carried field: each one is copied from the loser and drifts with it", () => {
    // The staleness class is not photo-specific — the patch carries ONLY values
    // read off the loser, so each of them can be stale in exactly the same way.
    // This walks the whole patch surface rather than trusting a spot check.
    const master = baseMember({ id: "master" });
    const populated = {
      title: "MR",
      gender: "MALE",
      dateOfBirth: new Date("1980-05-05T00:00:00Z"),
      occupation: "Engineer",
      lifeMemberDate: new Date("2001-01-01T00:00:00Z"),
      comments: "note",
      familyGroupId: "fg-1",
      phoneCountryCode: "64",
      phoneAreaCode: "27",
      phoneNumber: "4224115",
      photoImageId: "L1",
      photoUpdatedAt: new Date("2026-01-01T00:00:00Z"),
      photoUpdatedByMemberId: "someone",
      streetAddressLine1: "1 Road",
      streetAddressLine2: "Flat 2",
      streetCity: "Town",
      streetRegion: "Region",
      streetPostalCode: "1234",
      streetCountry: "NZ",
      postalAddressLine1: "PO Box 1",
      postalAddressLine2: "c/o",
      postalCity: "Town",
      postalRegion: "Region",
      postalPostalCode: "1234",
      postalCountry: "NZ",
      requiresInduction: true,
      hutLeaderEligible: true,
      hutLeaderEligibleAt: new Date("2022-02-02T00:00:00Z"),
      joinedDate: new Date("2005-03-03T00:00:00Z"),
    };
    const snapshotLoser = baseMember({ id: "loser", ...populated });
    // The whole loser row is wiped by a concurrent writer: nothing survives to
    // be filled from, so every field the patch carried disappears from it.
    const freshLoser = baseMember({ id: "loser" });

    const fromSnapshot = mergeMemberFields(master, snapshotLoser).patch;
    const fromFresh = mergeMemberFields(master, freshLoser).patch;

    expect(Object.keys(fromSnapshot).sort()).toEqual(Object.keys(populated).sort());
    expect(fromFresh).toEqual({});
    expect(diffFieldMergePatches(fromSnapshot, fromFresh)).toEqual(
      Object.keys(populated).sort(),
    );
  });
});

describe("family-link drift under the lock (#2437, diffSelfRelationLinkState)", () => {
  // The five self-relation columns are written by admin paths that take no
  // member-lifecycle lock, so a family link can land mid-merge. #2445 keeps the
  // master's own row out of the moves (no self-parent); this differ closes the
  // remaining arm — the SILENT LOSS of a concurrently-saved link, which the
  // loser's hard-delete would otherwise null via onDelete: SetNull with no
  // error and no audit. Expected values mirror the merge's OWN rewrites (step 1
  // nulls a master self-cycle; step 3 re-points non-master rows), so an
  // uncontended merge reads clean and every outside interleaving is drift.
  const M = "master-id";
  const L = "loser-id";

  function links(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      parentMemberId: null,
      secondaryParentId: null,
      inheritEmailFromId: null,
      detailsConfirmedByMemberId: null,
      ...overrides,
    };
  }

  function drift(
    overrides: Partial<Parameters<typeof diffSelfRelationLinkState>[0]> = {},
  ) {
    return diffSelfRelationLinkState({
      masterId: M,
      loserId: L,
      masterSnapshot: links(),
      loserSnapshot: links(),
      masterAtWrite: links(),
      loserAtWrite: links(),
      inboundAtWrite: [],
      ...overrides,
    });
  }

  it("covers exactly the five self-relation columns, derived from the spec table", () => {
    expect([...MEMBER_SELF_RELATION_COLUMNS]).toEqual([
      "parentMemberId",
      "secondaryParentId",
      "inheritEmailFromId",
      // #2716 added the fifth: the CHOICE behind the shared email address. It
      // moves with the pointer rather than after it, because a merge that
      // carried one and not the other would leave the surviving member with a
      // mailbox whose decision names a row that no longer exists.
      "inheritEmailChoiceId",
      "detailsConfirmedByMemberId",
    ]);
  });

  it("reports nothing when the under-lock state matches the snapshot", () => {
    expect(drift()).toEqual([]);
    // Links to uninvolved third members are carried through unchanged.
    expect(
      drift({
        masterSnapshot: links({ parentMemberId: "p-1" }),
        masterAtWrite: links({ parentMemberId: "p-1" }),
        loserSnapshot: links({ inheritEmailFromId: "p-2" }),
        loserAtWrite: links({ inheritEmailFromId: "p-2" }),
      }),
    ).toEqual([]);
  });

  it("treats an absent column like a null one (narrow selects, mock rows)", () => {
    expect(
      drift({
        masterSnapshot: {},
        loserSnapshot: {},
        masterAtWrite: links(),
        loserAtWrite: links(),
      }),
    ).toEqual([]);
  });

  it.each([...MEMBER_SELF_RELATION_COLUMNS])(
    "flags the silent-loss shape on %s: the master gains a link to the duplicate mid-merge",
    (column) => {
      // applyMoves rightly leaves the master's own row alone (#2445), so
      // without this the hard-delete's SET NULL would quietly erase the link.
      expect(drift({ masterAtWrite: links({ [column]: L }) })).toEqual([
        { column, where: "master" },
      ]);
    },
  );

  it("recognises step 1's own nulling as expected, not as drift", () => {
    // A snapshot self-cycle (master -> loser) is nulled by
    // nullSelfRelationCycles; the fresh read returning null is the merge's own
    // write and must not refuse the merge.
    expect(
      drift({
        masterSnapshot: links({ inheritEmailFromId: L }),
        masterAtWrite: links({ inheritEmailFromId: null }),
      }),
    ).toEqual([]);
    // A pointer STILL set at write time cannot arise from a writer in
    // production: step 1's null is VALUE-CONDITIONAL, so a pointer that moved
    // 409s at step 1 itself (see the execute suite's flip test), and a
    // successful null holds the master's row lock to commit. The differ still
    // fails CLOSED on the state rather than assuming it away: reading the
    // pointer back would mean step 1 was skipped or its locking broken, and
    // silently accepting it would mask exactly that.
    expect(
      drift({
        masterSnapshot: links({ inheritEmailFromId: L }),
        masterAtWrite: links({ inheritEmailFromId: L }),
      }),
    ).toEqual([{ column: "inheritEmailFromId", where: "master" }]);
  });

  it("refuses a directly-written self-link (the merge never CREATES one; it does not police pre-existing ones)", () => {
    // A writer sets master.parentMemberId = the master itself mid-merge.
    // Nothing in the merge writes that value, so it can only be drift — and
    // refusing it is what keeps the merge unable to CREATE a self-link under
    // any interleaving: the moves exclude the master's row (#2445), the
    // re-pointed inbound rows can only gain the MASTER's id (never their own),
    // and every mid-merge divergence on the two locked rows lands here.
    expect(drift({ masterAtWrite: links({ parentMemberId: M }) })).toEqual([
      { column: "parentMemberId", where: "master" },
    ]);
  });

  it("preserves a pre-existing self-confirmation untouched — a legitimate state, not drift", () => {
    // detailsConfirmedByMemberId === the member's own id is the REQUIRED
    // details-confirmed state for a login-capable member
    // (member-profile-completeness.ts), written by onboarding confirm and
    // nomination approval, and it gates canBeBookedAsMember. A merge must
    // carry it through unchanged: step 1 only nulls pointers at the LOSER,
    // the moves exclude the master's row, and an unchanged snapshot value is
    // not drift. (The invariant is "a merge never CREATES a self-link", not
    // "no committed merge carries one".)
    expect(
      drift({
        masterSnapshot: links({ detailsConfirmedByMemberId: M }),
        masterAtWrite: links({ detailsConfirmedByMemberId: M }),
      }),
    ).toEqual([]);
  });

  it("flags a link moved between two third members (what was previewed is what is applied)", () => {
    expect(
      drift({
        masterSnapshot: links({ secondaryParentId: "p-1" }),
        masterAtWrite: links({ secondaryParentId: "p-2" }),
      }),
    ).toEqual([{ column: "secondaryParentId", where: "master" }]);
  });

  it("covers the duplicate's own outgoing links, including step 3's degenerate re-point", () => {
    // A link saved ON the duplicate mid-merge would otherwise be discarded
    // with the row, unseen by the operator who previewed without it.
    expect(
      drift({ loserAtWrite: links({ detailsConfirmedByMemberId: "p-9" }) }),
    ).toEqual([{ column: "detailsConfirmedByMemberId", where: "duplicate" }]);
    // A (pre-existing, corrupt) self-pointing duplicate row is re-pointed to
    // the master by applyMoves — the merge's own write, not drift.
    expect(
      drift({
        loserSnapshot: links({ parentMemberId: L }),
        loserAtWrite: links({ parentMemberId: M }),
      }),
    ).toEqual([]);
  });

  it.each([...MEMBER_SELF_RELATION_COLUMNS])(
    "flags an inbound %s still pointing at the duplicate after the moves",
    (column) => {
      expect(
        drift({ inboundAtWrite: [links({ id: "third-1", [column]: L })] }),
      ).toEqual([{ column, where: "inbound" }]);
    },
  );

  it("ignores inbound rows that reference someone else", () => {
    expect(
      drift({ inboundAtWrite: [links({ id: "third-1", parentMemberId: "p-1" })] }),
    ).toEqual([]);
  });

  it("names each drift for the 409 in the admin's vocabulary, never as a raw DB column", () => {
    // The merge page renders the message verbatim and never reads `details`,
    // so this string is what a club administrator uses to work out — with the
    // other admin — what changed before retrying an irreversible merge.
    expect(
      describeFamilyLinkDrift({ column: "parentMemberId", where: "master" }),
    ).toBe("parent (on the surviving member)");
    expect(
      describeFamilyLinkDrift({ column: "inheritEmailFromId", where: "duplicate" }),
    ).toBe("shared email address (on the duplicate)");
    expect(
      describeFamilyLinkDrift({ column: "secondaryParentId", where: "inbound" }),
    ).toBe("second parent (another member now links to the duplicate)");
    expect(
      describeFamilyLinkDrift({ column: "detailsConfirmedByMemberId", where: "master" }),
    ).toBe("details confirmed by (on the surviving member)");
    // A future fifth column falls back to its name rather than hiding.
    expect(
      describeFamilyLinkDrift({ column: "guardianMemberId", where: "inbound" }),
    ).toBe("guardianMemberId (another member now links to the duplicate)");
  });
});

describe("planPartnerLinkMerge", () => {
  const M = "master";
  const L = "loser";

  function link(id: string, a: string, b: string, status = "PENDING"): PartnerLinkRow {
    const [memberAId, memberBId] = a < b ? [a, b] : [b, a];
    return { id, memberAId, memberBId, status };
  }

  it("deletes a loser<->master self-pair", () => {
    const plan = planPartnerLinkMerge([link("1", L, M)], [], M, L);
    expect(plan.deleteIds).toEqual(["1"]);
    expect(plan.updates).toEqual([]);
  });

  it("re-points a loser link to another member with canonical A<B ordering", () => {
    const other = "aaa"; // sorts before master
    const plan = planPartnerLinkMerge([link("1", L, other)], [], M, L);
    expect(plan.updates).toHaveLength(1);
    const u = plan.updates[0];
    expect([u.memberAId, u.memberBId].sort()).toEqual([other, M].sort());
    expect(u.memberAId < u.memberBId).toBe(true);
  });

  it("drops a loser duplicate when master already links the same partner", () => {
    const other = "zzz";
    const plan = planPartnerLinkMerge(
      [link("L1", L, other)],
      [link("M1", M, other)],
      M,
      L,
    );
    expect(plan.deleteIds).toEqual(["L1"]);
    expect(plan.updates).toEqual([]);
  });

  it("keeps master's confirmed partner and drops loser's confirmed link (with warning)", () => {
    const plan = planPartnerLinkMerge(
      [link("L1", L, "other1", "CONFIRMED")],
      [link("M1", M, "other2", "CONFIRMED")],
      M,
      L,
    );
    expect(plan.deleteIds).toEqual(["L1"]);
    expect(plan.warnings.length).toBeGreaterThan(0);
  });

  it("promotes loser's confirmed link when master has no confirmed partner", () => {
    const plan = planPartnerLinkMerge(
      [link("L1", L, "other1", "CONFIRMED")],
      [],
      M,
      L,
    );
    expect(plan.updates).toHaveLength(1);
    expect(plan.deleteIds).toEqual([]);
  });

  it("a CONFIRMED master<->loser link (deleted as self-pair) does not block re-pointing loser's genuine CONFIRMED link to a third member", () => {
    const selfPair = link("ML", M, L, "CONFIRMED");
    const toThird = link("LC", L, "third", "CONFIRMED");
    const plan = planPartnerLinkMerge([selfPair, toThird], [selfPair], M, L);
    // The master<->loser pair is deleted, NOT treated as master's confirmed
    // partner, so the loser's confirmed link to `third` is re-pointed.
    expect(plan.deleteIds).toEqual(["ML"]);
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].id).toBe("LC");
    expect([plan.updates[0].memberAId, plan.updates[0].memberBId].sort()).toEqual(
      [M, "third"].sort(),
    );
  });
});

describe("partitionKeyedCollisions (collision matrix)", () => {
  it("single-key: drops loser rows colliding on the key, moves the rest", () => {
    // CommitteeAssignment-style: key = committeeRoleId (member column excluded).
    const loser = [
      { id: "L1", committeeRoleId: "r1" }, // both-have -> drop
      { id: "L2", committeeRoleId: "r2" }, // loser-only -> move
    ];
    const master = [{ id: "M1", committeeRoleId: "r1" }];
    const { dropIds, moveIds } = partitionKeyedCollisions(loser, master, [["committeeRoleId"]]);
    expect(dropIds).toEqual(["L1"]);
    expect(moveIds).toEqual(["L2"]);
  });

  it("neither-have: everything moves when master has no rows", () => {
    const loser = [{ id: "L1", seasonYear: 2025 }];
    const { dropIds, moveIds } = partitionKeyedCollisions(loser, [], [["seasonYear"]]);
    expect(dropIds).toEqual([]);
    expect(moveIds).toEqual(["L1"]);
  });

  it("multi-unique: a collision on EITHER unique drops the loser row", () => {
    // PromoRedemptionAllocation-style: two uniques.
    const loser = [
      { id: "L1", promoRedemptionId: "pr1", promoCodeId: "pc9", bookingId: "b9" }, // collides on unique #1
      { id: "L2", promoRedemptionId: "prX", promoCodeId: "pc1", bookingId: "b1" }, // collides on unique #2
      { id: "L3", promoRedemptionId: "prZ", promoCodeId: "pcZ", bookingId: "bZ" }, // no collision -> move
    ];
    const master = [
      { id: "M1", promoRedemptionId: "pr1", promoCodeId: "pcM", bookingId: "bM" },
      { id: "M2", promoRedemptionId: "prM", promoCodeId: "pc1", bookingId: "b1" },
    ];
    const { dropIds, moveIds } = partitionKeyedCollisions(loser, master, [
      ["promoRedemptionId"],
      ["promoCodeId", "bookingId"],
    ]);
    expect(new Set(dropIds)).toEqual(new Set(["L1", "L2"]));
    expect(moveIds).toEqual(["L3"]);
  });

  it("NULL-distinct: two custom access roles (role=null) never collide (MemberAccessRole)", () => {
    // Both rows are custom-role rows with role=null but different roleDefinitionId.
    const loser = [{ id: "L1", role: null, roleDefinitionId: "defX" }];
    const master = [{ id: "M1", role: null, roleDefinitionId: "defY" }];
    const { dropIds, moveIds } = partitionKeyedCollisions(loser, master, [
      ["role"],
      ["roleDefinitionId"],
    ]);
    // role=null must NOT collide; roleDefinitionId differs -> move, not drop.
    expect(dropIds).toEqual([]);
    expect(moveIds).toEqual(["L1"]);
  });

  it("NULL-distinct: same non-null roleDefinitionId still collides", () => {
    const loser = [{ id: "L1", role: null, roleDefinitionId: "defX" }];
    const master = [{ id: "M1", role: null, roleDefinitionId: "defX" }];
    const { dropIds } = partitionKeyedCollisions(loser, master, [
      ["role"],
      ["roleDefinitionId"],
    ]);
    expect(dropIds).toEqual(["L1"]);
  });

  it("1-1 (empty key spec): a single master row collides with the loser's", () => {
    // NotificationPreference-style: unique on memberId alone -> key = [] (constant).
    const { dropIds, moveIds } = partitionKeyedCollisions(
      [{ id: "L1" }],
      [{ id: "M1" }],
      [[]],
    );
    expect(dropIds).toEqual(["L1"]);
    expect(moveIds).toEqual([]);
  });
});

// #2520 removed `maxFamilyRole` and its unit tests. It ranked two values of the
// retired FamilyGroupMember.role column so a merge could promote the surviving
// membership row to "ADMIN" — a write nothing read (#2284). The merge behaviour
// that DOES matter (drop the colliding loser row, re-point family billing, move
// the rest) is proven in member-merge-execute.test.ts.

describe("confirmation phrase", () => {
  it("collapses internal whitespace and trims", () => {
    expect(normalizeConfirmationText("  Jane   Doe  ")).toBe("Jane Doe");
  });
  it("builds the MERGE <name> phrase", () => {
    expect(memberMergeConfirmationPhrase("Jane   Doe")).toBe("MERGE Jane Doe");
  });
});

describe("spec bucket integrity", () => {
  it("every spec is exactly one of move/resolve/cascade", () => {
    for (const s of MEMBER_MERGE_RELATION_SPECS) {
      expect(["move", "resolve", "cascade"]).toContain(s.bucket);
    }
  });
  it("only move specs may be self-relations", () => {
    for (const s of MEMBER_MERGE_RELATION_SPECS) {
      if (s.selfRelation) expect(s.bucket).toBe("move");
    }
  });
  it("cascade specs are the auth-identity / token models only", () => {
    const cascadeModels = MEMBER_MERGE_RELATION_SPECS.filter(
      (s) => s.bucket === "cascade",
    ).map((s) => s.model);
    expect(new Set(cascadeModels)).toEqual(
      new Set([
        "PasswordResetToken",
        "MagicLinkToken",
        "EmailVerificationToken",
        "EmailChangeToken",
        "TwoFactorEmailCode",
        "TwoFactorRecoveryCode",
        "TwoFactorSessionChallenge",
        "PartnerInviteToken",
      ]),
    );
  });
  it("documents FK-less snapshot scalar columns", () => {
    expect(MEMBER_MERGE_SNAPSHOT_SCALAR_COLUMNS).toContain(
      "MemberLifecycleActionRequest.memberId",
    );
    expect(MEMBER_MERGE_SNAPSHOT_SCALAR_COLUMNS).toContain(
      "BookingModification.memberId",
    );
  });
  it("no documented snapshot scalar column is silently classified in a move/resolve/cascade bucket", () => {
    // The completeness test already guarantees the spec table covers EXACTLY
    // the @relation(fields:) owner keys, so an FK-less scalar is structurally
    // excluded; this asserts the documented list and the spec table never
    // overlap on a Model.column.
    const specColumns = new Set(
      MEMBER_MERGE_RELATION_SPECS.map((s) => `${s.model}.${s.column}`),
    );
    for (const col of MEMBER_MERGE_SNAPSHOT_SCALAR_COLUMNS) {
      expect(specColumns.has(col), `${col} is classified AND documented as snapshot`).toBe(false);
    }
  });
});
