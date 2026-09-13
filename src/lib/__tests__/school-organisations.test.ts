import { beforeEach, describe, expect, it, vi } from "vitest";
import { OrganisationKind } from "@prisma/client";

import {
  isSameOrganisationName,
  MAX_ORGANISATION_NAME_LENGTH,
  normaliseOrganisationName,
  resolveOrCreateSchoolOrganisation,
} from "@/lib/school-organisations";
import { normalizeXeroContactMatchValue } from "@/lib/xero-contact-name-match";

/**
 * #3367: which school is this?
 *
 * The matching rule has to be the same everywhere or the club ends up with two
 * records for one school and two Xero customers behind them — so it lives in one
 * module, and this file pins what it does AND what it deliberately refuses to do.
 * The refusals matter as much as the matches: #2912's binding classification
 * rule forbids a fuzzy merge, and a resolver that quietly decided "Tokoroa
 * Primary" and "Tokoroa Primary School" were the same school would be that
 * forbidden merge happening at runtime instead of in a reviewed census.
 */
const tx = {
  organisation: {
    findFirst: vi.fn(),
    create: vi.fn(),
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  tx.organisation.findFirst.mockResolvedValue(null);
  tx.organisation.create.mockImplementation(
    async (args: { data: { name: string } }) => ({
      id: "org-new",
      name: args.data.name,
    }),
  );
});

const call = (input: {
  name: string;
  email?: string | null;
  phone?: string | null;
}) =>
  resolveOrCreateSchoolOrganisation(
    tx as unknown as Parameters<typeof resolveOrCreateSchoolOrganisation>[0],
    input,
  );

describe("normaliseOrganisationName", () => {
  it("trims and collapses whitespace, and does nothing else", () => {
    expect(normaliseOrganisationName("  Tokoroa   Primary  ")).toBe(
      "Tokoroa Primary",
    );
    // Case is NOT normalised in the stored value: the club's own spelling is
    // what appears on its invoices. Case-insensitivity lives in the match.
    expect(normaliseOrganisationName("TOKOROA PRIMARY")).toBe("TOKOROA PRIMARY");
  });
});

describe("resolveOrCreateSchoolOrganisation", () => {
  it("creates the school on first sight, with its recorded contact details", async () => {
    await expect(
      call({
        name: "  New Plymouth  Primary School ",
        email: " office@school.test ",
        phone: " 021 555 0000 ",
      }),
    ).resolves.toEqual({
      id: "org-new",
      name: "New Plymouth Primary School",
      created: true,
    });

    expect(tx.organisation.create).toHaveBeenCalledWith({
      data: {
        kind: OrganisationKind.SCHOOL,
        name: "New Plymouth Primary School",
        email: "office@school.test",
        phone: "021 555 0000",
      },
      select: { id: true, name: true },
    });
  });

  it("records no contact details rather than inventing empty ones", async () => {
    await call({ name: "A School", email: "   ", phone: null });
    expect(tx.organisation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ email: null, phone: null }),
      }),
    );
  });

  it("matches an existing school ignoring case and spacing, and creates nothing", async () => {
    tx.organisation.findFirst.mockResolvedValue({
      id: "org-existing",
      name: "New Plymouth Primary School",
    });

    await expect(call({ name: "new plymouth   primary school" })).resolves.toEqual(
      {
        id: "org-existing",
        name: "New Plymouth Primary School",
        created: false,
      },
    );
    expect(tx.organisation.create).not.toHaveBeenCalled();
    expect(tx.organisation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          kind: OrganisationKind.SCHOOL,
          name: {
            equals: "new plymouth primary school",
            mode: "insensitive",
          },
        },
      }),
    );
  });

  it("NEVER renames or re-stamps the school it matched", async () => {
    tx.organisation.findFirst.mockResolvedValue({
      id: "org-existing",
      name: "New Plymouth Primary School",
    });

    // The club's own record of a school outranks whatever one booking request
    // happened to type, and silently rewriting the email would change who the
    // next invoice reaches.
    await call({
      name: "NEW PLYMOUTH PRIMARY SCHOOL",
      email: "someone-else@elsewhere.test",
    });
    expect(tx.organisation.create).not.toHaveBeenCalled();
    expect(
      (tx.organisation as unknown as { update?: unknown }).update,
    ).toBeUndefined();
  });

  it("prefers a live record over an archived one, deterministically", async () => {
    tx.organisation.findFirst.mockResolvedValue({
      id: "org-live",
      name: "A School",
    });
    await call({ name: "A School" });

    // An archived school is still the same school and still has the right Xero
    // customer, so it matches — un-archiving stays an officer's decision. The
    // ordering is what stops the answer depending on insertion order.
    expect(tx.organisation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [
          { archivedAt: { sort: "asc", nulls: "first" } },
          { createdAt: "asc" },
        ],
      }),
    );
  });

  it("does NOT treat a near-miss as the same school", async () => {
    // The runtime half of #2912's no-fuzzy-merge rule. Two names that a person
    // would probably merge are two schools here, and an officer merges them
    // deliberately rather than having it guessed.
    tx.organisation.findFirst.mockResolvedValue(null);
    await expect(call({ name: "Tokoroa Primary" })).resolves.toMatchObject({
      created: true,
    });
    expect(tx.organisation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          name: { equals: "Tokoroa Primary", mode: "insensitive" },
        }),
      }),
    );
  });

  it("truncates rather than refusing an over-long name", async () => {
    const long = `${"A".repeat(MAX_ORGANISATION_NAME_LENGTH + 40)}`;
    await call({ name: long });
    const written = tx.organisation.create.mock.calls[0][0].data.name;
    expect(written).toHaveLength(MAX_ORGANISATION_NAME_LENGTH);
  });

  it("refuses an empty name rather than creating a nameless school", async () => {
    await expect(call({ name: "   " })).rejects.toThrow(/empty name/);
    expect(tx.organisation.create).not.toHaveBeenCalled();
  });
});

/**
 * A PROOF MAY NEVER BE STRICTER THAN THE MATCH THAT PRODUCED ITS CANDIDATE.
 *
 * `isSameOrganisationName` is what the Xero contact transfer uses to decide
 * whether a school's own history names the school a contact was matched FOR, and
 * the provider matched that contact under `normalizeXeroContactMatchValue`. So
 * anything the search calls one name, this predicate must call one school. The
 * property test below is the guard: it fails for any future re-spelling of the
 * rule that refuses a pair the search accepts.
 */
describe("isSameOrganisationName", () => {
  const SAME_SCHOOL_PAIRS: readonly [string, string][] = [
    ["St. Peter's College", "St Peter's College"],
    ["Te Kura o Whangarei", "Te Kura o Whangārei"],
    ["Hawera Intermediate", "hawera-intermediate"],
    ["New Plymouth   Primary School", "New Plymouth Primary School"],
    ["TOKOROA PRIMARY", "Tokoroa Primary"],
  ];

  it.each(SAME_SCHOOL_PAIRS)(
    "calls %s and %s the same school, because Xero's name search does",
    (left, right) => {
      // The premise, stated rather than assumed: the provider really would hand
      // back one contact for these two spellings.
      expect(normalizeXeroContactMatchValue(left)).toBe(
        normalizeXeroContactMatchValue(right),
      );
      expect(isSameOrganisationName(left, right)).toBe(true);
    },
  );

  it("is never stricter than the contact search, whatever it is re-spelt as", () => {
    // The rule, not the examples. Any pair the search folds together must
    // satisfy the proof; a comparison of its own here would strand a returning
    // school whose name was typed with different punctuation.
    for (const [left, right] of SAME_SCHOOL_PAIRS) {
      if (
        normalizeXeroContactMatchValue(left) ===
        normalizeXeroContactMatchValue(right)
      ) {
        expect(
          isSameOrganisationName(left, right),
          `${left} / ${right}: the search matched these, so the proof must too`,
        ).toBe(true);
      }
    }
  });

  it("is a FOLDING, not a fuzzy match", () => {
    // #2912 forbids a near-miss merge, and the coarser rule does not smuggle
    // one in: an extra word is still another school.
    expect(isSameOrganisationName("Tokoroa Primary", "Tokoroa Primary School")).toBe(
      false,
    );
    expect(isSameOrganisationName("Hawera Intermediate", "Hawera High")).toBe(
      false,
    );
  });

  it("never matches on an absent or punctuation-only name", () => {
    // An absent name is not evidence of anything, and a name that folds away to
    // nothing is absent by the same test.
    expect(isSameOrganisationName(null, "A School")).toBe(false);
    expect(isSameOrganisationName("   ", "A School")).toBe(false);
    expect(isSameOrganisationName("---", "...")).toBe(false);
  });
});
