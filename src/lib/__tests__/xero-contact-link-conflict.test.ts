/**
 * #3058 — "may this member take this Xero contact?", answered in one place.
 *
 * The invariant (`INV-INT-018`) never broke: `commitManualXeroContactLink`
 * refuses a second home downstream, symmetrically, under the contact-home lock.
 * What the manual-link screen owned was the FRIENDLY half — the 409 that tells
 * an officer who has the contact — and it answered it itself, with a
 * `member.findFirst` on `xeroContactId` over the member table alone. Since
 * #3366 an `Organisation` can hold a contact too, so an officer linking a
 * member to a school's own Xero customer passed that refusal, paid for a
 * `getContact` round trip on a link that could never be made, and then met the
 * raw two-homes error from the commit.
 *
 * `findXeroContactLinkConflict` is that question composed from the rules that
 * own it, in the module that owns them. It raises the refusal's OWN message
 * rather than a second copy, so the early explanation and the enforced one
 * cannot drift.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = {
  member: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
  organisation: { findFirst: vi.fn(), findMany: vi.fn() },
};

import { findXeroContactLinkConflict } from "@/lib/xero-contact-home";

describe("findXeroContactLinkConflict (#3058, INV-INT-018)", () => {
  beforeEach(() => {
    for (const delegate of Object.values(db)) {
      for (const stub of Object.values(delegate)) stub.mockReset();
    }
    db.member.findFirst.mockResolvedValue(null);
    db.member.findMany.mockResolvedValue([]);
    db.member.findUnique.mockResolvedValue(null);
    db.organisation.findFirst.mockResolvedValue(null);
    db.organisation.findMany.mockResolvedValue([]);
  });

  it("refuses a contact an ORGANISATION holds, naming the school", async () => {
    // The case the member-only check could not see at all.
    db.organisation.findFirst.mockResolvedValue({
      id: "org-1",
      name: "St Peter's College",
    });

    const conflict = await findXeroContactLinkConflict(db as never, {
      xeroContactId: "contact-9",
      claimingMemberId: "member-1",
    });

    expect(conflict?.message).toContain("St Peter's College");
    expect(conflict?.message).toContain("INV-INT-018");
    // Answered from the organisation half alone — the ownership read is never
    // reached, so a school's contact costs one query to refuse.
    expect(db.member.findMany).not.toHaveBeenCalled();
  });

  it("refuses a contact another MEMBER holds, naming them", async () => {
    db.member.findMany.mockResolvedValue([
      { id: "member-2", xeroContactId: "contact-9" },
    ]);
    db.member.findUnique.mockResolvedValue({
      firstName: "Ada",
      lastName: "Lovelace",
    });

    const conflict = await findXeroContactLinkConflict(db as never, {
      xeroContactId: "contact-9",
      claimingMemberId: "member-1",
    });

    expect(conflict?.message).toContain("Ada Lovelace");
  });

  it("allows a member to re-link the contact they already hold", async () => {
    // A no-op repair, not a conflict. The member-only check expressed this as
    // `id: { not: id }`; the ownership accessor answers "held" either way, so
    // the exclusion has to be made against the claimant.
    db.member.findMany.mockResolvedValue([
      { id: "member-1", xeroContactId: "contact-9" },
    ]);

    expect(
      await findXeroContactLinkConflict(db as never, {
        xeroContactId: "contact-9",
        claimingMemberId: "member-1",
      }),
    ).toBeNull();
  });

  it("allows a contact nothing local holds", async () => {
    expect(
      await findXeroContactLinkConflict(db as never, {
        xeroContactId: "contact-9",
        claimingMemberId: "member-1",
      }),
    ).toBeNull();
  });

  it("names the holder generically rather than failing when their row is gone", async () => {
    // The ownership read and the name read are two statements, so the row can
    // vanish between them. A refusal that throws there would be worse than one
    // that is vague.
    db.member.findMany.mockResolvedValue([
      { id: "member-2", xeroContactId: "contact-9" },
    ]);
    db.member.findUnique.mockResolvedValue(null);

    const conflict = await findXeroContactLinkConflict(db as never, {
      xeroContactId: "contact-9",
      claimingMemberId: "member-1",
    });

    expect(conflict?.message).toContain("another member");
  });

  it("lets a real failure through instead of reading it as 'no conflict'", async () => {
    // Fail closed: a database error while asking whether the contact is free
    // must not be swallowed into a `null` that reads as permission.
    db.organisation.findFirst.mockRejectedValue(new Error("database is down"));

    await expect(
      findXeroContactLinkConflict(db as never, {
        xeroContactId: "contact-9",
        claimingMemberId: "member-1",
      }),
    ).rejects.toThrow("database is down");
  });
});
