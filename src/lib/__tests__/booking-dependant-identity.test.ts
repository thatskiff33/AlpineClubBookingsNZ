import { describe, expect, it, vi } from "vitest";
import {
  checkOwnDependantIdentity,
  DEPENDANT_IDENTITY_DECLARATION_INVALID_CODE,
  DEPENDANT_IDENTITY_UNRESOLVED_CODE,
  dependantIdentityDeclarationSchema,
  DIFFERENT_PERSON_SAME_NAME,
  findOwnDependantNameCollisions,
  loadBookerDependants,
  type BookerDependant,
  type DependantIdentityDeclaration,
} from "@/lib/booking-dependant-identity";
import { normalizePersonFullName } from "@/lib/person-name-normalization";

/*
  #2721 — own-dependant identity on a booking party (`INV-GUEST-019`).

  The defect, stated once so every case below is anchored to it: a booking party
  row with no `memberId` is a NON-MEMBER guest. Under the club's hold policy that
  row can be provisional — no bed reserved until the booking is confirmed and
  paid nearer the stay — it is bumpable when the lodge fills, and it is invoiced
  as the deferred guest portion. A parent typing their own recorded dependant's
  name used to land there silently, putting a member of this club on the queue
  behind the members.
*/

const DEPENDANTS: BookerDependant[] = [
  { id: "dep-sam", firstName: "Sam", lastName: "Smith" },
  { id: "dep-ana", firstName: "Ana", lastName: "Smith" },
];

function freeTextGuest(firstName: string, lastName: string) {
  return { firstName, lastName };
}

function memberGuest(firstName: string, lastName: string, memberId: string) {
  return { firstName, lastName, memberId };
}

function declaration(
  dependantMemberId: string,
  firstName: string,
  lastName: string,
): DependantIdentityDeclaration {
  return {
    kind: DIFFERENT_PERSON_SAME_NAME,
    dependantMemberId,
    normalizedName: normalizePersonFullName(firstName, lastName),
  };
}

describe("loadBookerDependants: the candidate set is parent links and nothing wider", () => {
  it("asks only for ACTIVE members whose primary or secondary parent is the booker", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    await loadBookerDependants(
      { member: { findMany } } as never,
      "booker-1",
    );

    expect(findMany).toHaveBeenCalledTimes(1);
    const args = findMany.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
      select: Record<string, unknown>;
    };

    // The privacy boundary is the WHERE clause, so it is asserted as a whole
    // rather than by picking at one key: an extra `OR` arm on a family group or
    // a `contains` on a name would each be the leak this issue exists to
    // prevent, and each would change this object.
    expect(args.where).toEqual({
      active: true,
      OR: [{ parentMemberId: "booker-1" }, { secondaryParentId: "booker-1" }],
    });
    // Only the three fields the collision question needs. No email, no address,
    // no date of birth leaves the database for this.
    expect(args.select).toEqual({ id: true, firstName: true, lastName: true });
  });

  it("asks nothing at all when there is no booker to ask about", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    await loadBookerDependants({ member: { findMany } } as never, "   ");
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe("findOwnDependantNameCollisions: exact, on the normalised name", () => {
  it("matches through case and surrounding whitespace", () => {
    const collisions = findOwnDependantNameCollisions(
      [freeTextGuest("  sAm ", "SMITH  ")],
      DEPENDANTS,
    );

    expect(collisions).toHaveLength(1);
    expect(collisions[0]?.normalizedName).toBe("sam smith");
    expect(collisions[0]?.dependants.map((d) => d.id)).toEqual(["dep-sam"]);
    // The typed spelling is carried for the wizard's wording only; matching
    // never touches it.
    expect(collisions[0]?.typedFirstName).toBe("  sAm ");
  });

  it("does NOT match a near miss — no fuzzy, phonetic or partial matching", () => {
    // Each of these is one or two edits from "Sam Smith", which is exactly the
    // distance the POST-PAYMENT typo guard would accept as the same person.
    // This guard must not: a false collision is the app asking a parent about a
    // name they never mentioned, and repeated across a club it starts answering
    // "is this a member?" about arbitrary spellings.
    for (const [first, last] of [
      ["Samm", "Smith"],
      ["Sam", "Smyth"],
      ["Sammy", "Smith"],
      ["Sam", "Smithson"],
      ["S", "Smith"],
    ]) {
      expect(
        findOwnDependantNameCollisions(
          [freeTextGuest(first as string, last as string)],
          DEPENDANTS,
        ),
      ).toEqual([]);
    }
  });

  it("skips a row that is already on the member path", () => {
    expect(
      findOwnDependantNameCollisions(
        [memberGuest("Sam", "Smith", "dep-sam")],
        DEPENDANTS,
      ),
    ).toEqual([]);
  });

  it("skips a half-typed name, which would otherwise collide with everyone", () => {
    expect(
      findOwnDependantNameCollisions(
        [freeTextGuest("Sam", "   "), freeTextGuest("", "Smith")],
        [{ id: "dep-blank", firstName: "", lastName: "" }],
      ),
    ).toEqual([]);
  });

  it("reports ONE collision per name however many rows carry it", () => {
    const collisions = findOwnDependantNameCollisions(
      [freeTextGuest("Sam", "Smith"), freeTextGuest("SAM", "smith")],
      DEPENDANTS,
    );
    expect(collisions).toHaveLength(1);
  });

  it("reports EVERY dependant sharing the normalised name", () => {
    const twoSams: BookerDependant[] = [
      { id: "dep-sam-1", firstName: "Sam", lastName: "Smith" },
      { id: "dep-sam-2", firstName: " sam", lastName: "smith " },
    ];
    const collisions = findOwnDependantNameCollisions(
      [freeTextGuest("Sam", "Smith")],
      twoSams,
    );
    expect(collisions[0]?.dependants.map((d) => d.id)).toEqual([
      "dep-sam-1",
      "dep-sam-2",
    ]);
  });

  it("finds nothing for a booker with no recorded dependants", () => {
    expect(
      findOwnDependantNameCollisions([freeTextGuest("Sam", "Smith")], []),
    ).toEqual([]);
  });
});

describe("the declaration shape: no generic override is expressible", () => {
  it("accepts the one kind bound to a dependant and a collision", () => {
    expect(
      dependantIdentityDeclarationSchema.safeParse({
        kind: DIFFERENT_PERSON_SAME_NAME,
        dependantMemberId: "dep-sam",
        normalizedName: "sam smith",
      }).success,
    ).toBe(true);
  });

  it("refuses a reflexive boolean, a bare override and an unbound kind", () => {
    for (const forged of [
      true,
      { override: true },
      { kind: "override" },
      { kind: DIFFERENT_PERSON_SAME_NAME },
      { kind: DIFFERENT_PERSON_SAME_NAME, dependantMemberId: "dep-sam" },
      { kind: DIFFERENT_PERSON_SAME_NAME, normalizedName: "sam smith" },
      {
        kind: DIFFERENT_PERSON_SAME_NAME,
        dependantMemberId: "",
        normalizedName: "sam smith",
      },
    ]) {
      expect(dependantIdentityDeclarationSchema.safeParse(forged).success).toBe(
        false,
      );
    }
  });
});

describe("checkOwnDependantIdentity", () => {
  it("lets an ordinary non-member guest through untouched", () => {
    expect(
      checkOwnDependantIdentity({
        party: [freeTextGuest("Kiri", "Ngata")],
        dependants: DEPENDANTS,
      }),
    ).toBeNull();
  });

  it("REFUSES the original defect: an own dependant typed as free text", () => {
    const refusal = checkOwnDependantIdentity({
      party: [
        memberGuest("Pat", "Smith", "booker-1"),
        freeTextGuest("Sam", "Smith"),
      ],
      dependants: DEPENDANTS,
    });

    expect(refusal?.code).toBe(DEPENDANT_IDENTITY_UNRESOLVED_CODE);
    expect(refusal?.status).toBe(409);
    expect(refusal?.collisions[0]?.dependants.map((d) => d.id)).toEqual([
      "dep-sam",
    ]);
  });

  it("allows the guest path once the booker names the dependant it is not", () => {
    expect(
      checkOwnDependantIdentity({
        party: [freeTextGuest("Sam", "Smith")],
        dependants: DEPENDANTS,
        declarations: [declaration("dep-sam", "Sam", "Smith")],
      }),
    ).toBeNull();
  });

  it("still refuses when only ONE of two identically-named dependants is answered for", () => {
    const twoSams: BookerDependant[] = [
      { id: "dep-sam-1", firstName: "Sam", lastName: "Smith" },
      { id: "dep-sam-2", firstName: "Sam", lastName: "Smith" },
    ];
    const refusal = checkOwnDependantIdentity({
      party: [freeTextGuest("Sam", "Smith")],
      dependants: twoSams,
      declarations: [declaration("dep-sam-1", "Sam", "Smith")],
    });

    expect(refusal?.code).toBe(DEPENDANT_IDENTITY_UNRESOLVED_CODE);
    expect(
      checkOwnDependantIdentity({
        party: [freeTextGuest("Sam", "Smith")],
        dependants: twoSams,
        declarations: [
          declaration("dep-sam-1", "Sam", "Smith"),
          declaration("dep-sam-2", "Sam", "Smith"),
        ],
      }),
    ).toBeNull();
  });

  describe("tampering", () => {
    it("refuses a fabricated dependant id", () => {
      const refusal = checkOwnDependantIdentity({
        party: [freeTextGuest("Sam", "Smith")],
        dependants: DEPENDANTS,
        declarations: [declaration("dep-does-not-exist", "Sam", "Smith")],
      });
      expect(refusal?.code).toBe(DEPENDANT_IDENTITY_DECLARATION_INVALID_CODE);
      expect(refusal?.status).toBe(400);
      // A tampering refusal echoes nothing back.
      expect(refusal?.collisions).toEqual([]);
    });

    it("refuses a real dependant of somebody ELSE", () => {
      // `dependants` is the booker's own set, so another family's dependant is
      // simply not in it — which is the same shape as a fabricated id, and
      // deliberately gets the same answer rather than a distinguishable one.
      const refusal = checkOwnDependantIdentity({
        party: [freeTextGuest("Sam", "Smith")],
        dependants: DEPENDANTS,
        declarations: [declaration("another-familys-child", "Sam", "Smith")],
      });
      expect(refusal?.code).toBe(DEPENDANT_IDENTITY_DECLARATION_INVALID_CODE);
    });

    it("refuses an UNRELATED own dependant — one this collision was never about", () => {
      const refusal = checkOwnDependantIdentity({
        party: [freeTextGuest("Sam", "Smith")],
        dependants: DEPENDANTS,
        // Ana really is the booker's dependant. She is not the person the
        // collision is about, so waiving her says nothing about Sam.
        declarations: [declaration("dep-ana", "Sam", "Smith")],
      });
      expect(refusal?.code).toBe(DEPENDANT_IDENTITY_DECLARATION_INVALID_CODE);
    });

    it("refuses a STALE declaration whose guest name has since changed", () => {
      const refusal = checkOwnDependantIdentity({
        party: [freeTextGuest("Kiri", "Ngata")],
        dependants: DEPENDANTS,
        declarations: [declaration("dep-sam", "Sam", "Smith")],
      });
      expect(refusal?.code).toBe(DEPENDANT_IDENTITY_DECLARATION_INVALID_CODE);
    });

    it("refuses a STALE declaration whose dependant has since been renamed", () => {
      // The declaration was minted against "Sam Smith"; the club has since
      // recorded the dependant as "Sam Smith-Ngata", so the collision the
      // booker answered no longer exists.
      const refusal = checkOwnDependantIdentity({
        party: [freeTextGuest("Sam", "Smith")],
        dependants: [
          { id: "dep-sam", firstName: "Sam", lastName: "Smith-Ngata" },
        ],
        declarations: [declaration("dep-sam", "Sam", "Smith")],
      });
      expect(refusal?.code).toBe(DEPENDANT_IDENTITY_DECLARATION_INVALID_CODE);
    });

    it("refuses a declaration parked on a party with no collision at all", () => {
      // A caller cannot leave a forged answer lying in the payload waiting for
      // the day it silently covers a real collision.
      const refusal = checkOwnDependantIdentity({
        party: [memberGuest("Pat", "Smith", "booker-1")],
        dependants: DEPENDANTS,
        declarations: [declaration("dep-sam", "Sam", "Smith")],
      });
      expect(refusal?.code).toBe(DEPENDANT_IDENTITY_DECLARATION_INVALID_CODE);
    });

    it("refuses a tampered declaration even when the party is otherwise clean", () => {
      const refusal = checkOwnDependantIdentity({
        party: [
          freeTextGuest("Sam", "Smith"),
          freeTextGuest("Kiri", "Ngata"),
        ],
        dependants: DEPENDANTS,
        declarations: [
          declaration("dep-sam", "Sam", "Smith"),
          declaration("dep-ana", "Kiri", "Ngata"),
        ],
      });
      expect(refusal?.code).toBe(DEPENDANT_IDENTITY_DECLARATION_INVALID_CODE);
    });
  });
});
