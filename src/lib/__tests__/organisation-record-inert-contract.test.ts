import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  relativeSource,
  sourceFiles,
} from "@/lib/__tests__/support/booking-guest-night-writer-scan";

/**
 * #3366 (stage 1 of programme #2912): the organisation records exist, are
 * reachable from a booking and a booking request, and NOTHING READS THEM.
 *
 * This stage is deliberately inert, and "inert" is a claim that has to be
 * checkable or it is only a sentence in a pull request. Three things are pinned
 * here, and each answers one of the issue's acceptance criteria.
 *
 *  1. THE RECORDS EXIST AND ARE REACHABLE. `Organisation` and
 *     `OrganisationContact` are in the datamodel, and a booking and a booking
 *     request each carry an OPTIONAL link to an organisation. Optional is the
 *     load-bearing half: a nullable column is what lets the currently deployed
 *     release keep reading these two tables, because its inserts omit the
 *     column and a nullable column with no default accepts that.
 *
 *  2. NO EXISTING QUERY CHANGES ITS RESULT. Every scalar column of `Booking`
 *     and `BookingRequest` is pinned against the list the PRE-STAGE schema
 *     declared, in order, read out of a Prisma client generated from
 *     `origin/epic/2725-mad` at `5c9c09882`. Drop this stage's one added column
 *     and a default-selection read serialises BYTE FOR BYTE as it did before —
 *     asserted on the JSON, not merely on the set, so a column inserted in a
 *     way that reorders its neighbours fails here too. An existing query naming
 *     its columns is unaffected by construction; one taking the default
 *     selection gains exactly one key, and that key is always `null` because
 *     (3) proves nothing writes it.
 *
 *  3. NOTHING READS OR WRITES THE NEW LINKS. Every non-test source file in the
 *     tree is scanned for the identifiers this stage introduced. Before it,
 *     every one of them appeared ZERO times anywhere in the tree — measured,
 *     which is what makes a census on them exact rather than approximate — so
 *     any hit outside the two declared files is a reader or a writer arriving
 *     early, and stage 2 (#3367) is where those belong.
 *
 * `npm run test:related` cannot select this file: it reads the tree from disk
 * and has no import edge to what it scans, so like the other censuses in this
 * directory it is CI-caught by design.
 */

const REPO = process.cwd();
const SCHEMA = readFileSync(join(REPO, "prisma", "schema.prisma"), "utf8");

/** The column this stage adds to each of the two existing tables. */
const ADDED_COLUMN = "organisationId";

/**
 * `Booking`'s scalar columns as the PRE-STAGE schema declared them, in order.
 *
 * Not hand-typed: read out of `Prisma.dmmf` of a client generated from
 * `origin/epic/2725-mad` at `5c9c09882` — the epic's branch point, which is
 * also the pre-epic release, because the epic branch carried no migration of
 * its own when this stage was built.
 */
const PRE_STAGE_BOOKING_COLUMNS: readonly string[] = [
  "id",
  "memberId",
  "checkIn",
  "checkOut",
  "status",
  "totalPriceCents",
  "discountCents",
  "promoAdjustmentCents",
  "finalPriceCents",
  "hasNonMembers",
  "cancelIfGuestsBumped",
  "nonMemberHoldUntil",
  "parentBookingId",
  "organiserSettled",
  "draftExpiresAt",
  "notes",
  "expectedArrivalTime",
  "requestedRoomId",
  "preArrivalReminderSentAt",
  "createdById",
  "requiresAdminReview",
  "adminReviewReason",
  "memberReviewJustification",
  "adminReviewStatus",
  "adminReviewNotes",
  "adminReviewedById",
  "adminReviewedAt",
  "adultMemberHostingReview",
  "adultMemberHostingReviewStatus",
  "adultMemberHostingReviewReason",
  "adultMemberHostingReviewedById",
  "adultMemberHostingReviewedAt",
  "waitlistPosition",
  "waitlistOfferedAt",
  "waitlistOfferExpiresAt",
  "waitlistOfferedLodgeId",
  "waitlistOfferedPriceCents",
  "deletedAt",
  "deletedById",
  "deletedReason",
  "lodgeId",
  "adminCapacityHoldAt",
  "adminCapacityHoldByMemberId",
  "capacityOverriddenAt",
  "capacityOverriddenByMemberId",
  "wholeLodgeHold",
  "wholeLodgeHoldAt",
  "wholeLodgeHoldByMemberId",
  "noEmails",
  "noEmailsAt",
  "noEmailsByMemberId",
  "creditElectionCents",
  "otherLodgeId",
  "createdAt",
  "updatedAt",
];

/** `BookingRequest`'s scalar columns at the same ref, on the same footing. */
const PRE_STAGE_BOOKING_REQUEST_COLUMNS: readonly string[] = [
  "id",
  "type",
  "status",
  "contactFirstName",
  "contactLastName",
  "contactEmail",
  "contactPhone",
  "checkIn",
  "checkOut",
  "guests",
  "message",
  "exclusivityRequested",
  "requestedByMemberId",
  "schoolName",
  "teachers",
  "cateringPreference",
  "linkedGuestMembers",
  "lodgeId",
  "otherLodgeId",
  "indicativePriceCents",
  "priceCents",
  "verificationTokenHash",
  "verificationTokenExpiresAt",
  "verifiedAt",
  "attendeeConfirmationTokenHash",
  "attendeeConfirmationTokenExpiresAt",
  "attendeeConfirmationLastSentAt",
  "attendeesConfirmedAt",
  "pricedByMemberId",
  "pricedAt",
  "reviewedByMemberId",
  "reviewedAt",
  "declineReason",
  "convertedBookingId",
  "convertedMemberId",
  "heldBookingId",
  "acceptedQuoteId",
  "acceptedQuoteOptionId",
  "acceptedQuoteSnapshot",
  "acceptedPriceCents",
  "acceptedAt",
  "responseMessage",
  "responseMessageAt",
  "createdAt",
  "updatedAt",
  "version",
];

type DmmfField = {
  name: string;
  kind: string;
  type: string;
  relationName?: string;
};
type DmmfModel = { name: string; fields: DmmfField[] };

const MODELS = Prisma.dmmf.datamodel.models as unknown as DmmfModel[];

function model(name: string): DmmfModel {
  const found = MODELS.find((m) => m.name === name);
  if (!found) throw new Error(`#3366: the datamodel has no model ${name}.`);
  return found;
}

/** Scalar and enum columns, in declaration order — what a default read returns. */
function columns(name: string): string[] {
  return model(name)
    .fields.filter((f) => !f.relationName)
    .map((f) => f.name);
}

/** The text of one model block, for what the trimmed runtime DMMF cannot answer. */
function modelBlock(name: string): string {
  const start = SCHEMA.indexOf(`\nmodel ${name} {`);
  if (start < 0) {
    throw new Error(`#3366: prisma/schema.prisma has no model ${name}.`);
  }
  const end = SCHEMA.indexOf("\n}\n", start);
  return SCHEMA.slice(start, end);
}

/**
 * The declared type token of one field: `String`, `String?`, `Organisation?`.
 * The runtime DMMF is trimmed to name/kind/type, so optionality is read off the
 * schema itself rather than assumed.
 */
function declaredType(modelName: string, field: string): string {
  for (const line of modelBlock(modelName).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(`${field} `)) continue;
    const token = trimmed.slice(field.length).trim().split(/[\s@]/)[0];
    if (token) return token;
  }
  throw new Error(`#3366: ${modelName}.${field} is not declared in the schema.`);
}

/** The values of one enum, read from the schema text. */
function enumValues(name: string): string[] {
  const start = SCHEMA.indexOf(`\nenum ${name} {`);
  if (start < 0) {
    throw new Error(`#3366: prisma/schema.prisma has no enum ${name}.`);
  }
  const end = SCHEMA.indexOf("\n}\n", start);
  return SCHEMA.slice(start, end)
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => /^[A-Z][A-Z0-9_]*$/.test(line));
}

/**
 * A representative default-selection row: one deterministic placeholder per
 * column, in the order a client returns them. Comparing two of these compares
 * the bytes a read serialises to, key order included.
 */
function representativeRow(cols: readonly string[]): string {
  const row: Record<string, string> = {};
  for (const c of cols) row[c] = `<${c}>`;
  return JSON.stringify(row);
}

describe("#3366: the organisation records exist and are reachable", () => {
  it("declares both new models", () => {
    expect(model("Organisation").name).toBe("Organisation");
    expect(model("OrganisationContact").name).toBe("OrganisationContact");
  });

  it("gives the organisation its OWN durable Xero customer link", () => {
    expect(columns("Organisation")).toContain("xeroContactId");
    expect(declaredType("Organisation", "xeroContactId")).toBe("String?");
    expect(modelBlock("Organisation")).toContain("@unique");
  });

  it("joins people to an organisation without overloading Member.role", () => {
    const contact = model("OrganisationContact");
    expect(contact.fields.find((f) => f.name === "memberId")?.kind).toBe("scalar");
    expect(contact.fields.find((f) => f.name === "role")?.type).toBe(
      "OrganisationContactRole",
    );

    // The two existing role vocabularies are untouched by this stage. Retiring
    // the school-as-person path is stage 4 (#3369), and an enum value can only
    // be REMOVED in a release after the epic merges, because nothing drains
    // inside one deploy — so both values must still be here. Read from the
    // SCHEMA TEXT rather than the runtime DMMF, and the reason is measured:
    // the DMMF this client ships is trimmed and reports `datamodel.enums` as
    // an EMPTY list. A `toContain` over it would therefore FAIL loudly, not
    // pass vacuously — only a `.some()`-shaped assertion would pass vacuously
    // — but either way that DMMF cannot answer the question. The same trimming
    // is why `declaredType()` above reads optionality off the schema: the
    // shipped field shape carries no `isRequired` and no `isList` either.
    expect(enumValues("Role")).toContain("SCHOOL");
    expect(enumValues("AccessRole")).toContain("ORG");
  });

  it("reaches an organisation from a booking and from a booking request, optionally", () => {
    for (const owner of ["Booking", "BookingRequest"]) {
      expect(model(owner).fields.find((f) => f.name === "organisation")?.type).toBe(
        "Organisation",
      );
      // OPTIONAL is the whole compatibility argument: the draining colour's
      // inserts omit this column, and a nullable column with no default takes
      // that without complaint.
      expect(declaredType(owner, "organisation")).toBe("Organisation?");
      expect(declaredType(owner, ADDED_COLUMN)).toBe("String?");
    }
  });

  it("leaves Booking.memberId REQUIRED — making it optional is stage 4 (#3369)", () => {
    expect(declaredType("Booking", "memberId")).toBe("String");
  });
});

describe("#3366: no existing query changes its result", () => {
  it("adds exactly one column to Booking and one to BookingRequest", () => {
    expect(
      columns("Booking").filter((c) => !PRE_STAGE_BOOKING_COLUMNS.includes(c)),
    ).toEqual([ADDED_COLUMN]);
    expect(
      columns("BookingRequest").filter(
        (c) => !PRE_STAGE_BOOKING_REQUEST_COLUMNS.includes(c),
      ),
    ).toEqual([ADDED_COLUMN]);
  });

  it("leaves every pre-stage Booking column present, in the same order", () => {
    expect(columns("Booking").filter((c) => c !== ADDED_COLUMN)).toEqual(
      PRE_STAGE_BOOKING_COLUMNS,
    );
  });

  it("leaves every pre-stage BookingRequest column present, in the same order", () => {
    expect(columns("BookingRequest").filter((c) => c !== ADDED_COLUMN)).toEqual(
      PRE_STAGE_BOOKING_REQUEST_COLUMNS,
    );
  });

  it("serialises a booking read BYTE FOR BYTE as before, once the new column is dropped", () => {
    expect(
      representativeRow(columns("Booking").filter((c) => c !== ADDED_COLUMN)),
    ).toBe(representativeRow(PRE_STAGE_BOOKING_COLUMNS));
    expect(
      representativeRow(columns("BookingRequest").filter((c) => c !== ADDED_COLUMN)),
    ).toBe(representativeRow(PRE_STAGE_BOOKING_REQUEST_COLUMNS));
  });

  it("FAILS when a column moves rather than being appended (fixture proof)", () => {
    // The byte comparison above is only worth running because key ORDER can
    // move. Moving one column must not compare equal, or that assertion would
    // pass for any placement at all.
    const shuffled = [...PRE_STAGE_BOOKING_COLUMNS];
    shuffled.unshift(...shuffled.splice(3, 1));
    expect(representativeRow(shuffled)).not.toBe(
      representativeRow(PRE_STAGE_BOOKING_COLUMNS),
    );
  });
});

/**
 * Files allowed to name one of the new identifiers, each with the reason.
 *
 * The member merge is not a READER of the organisation link: it is the
 * classification the DMMF/schema completeness test (`member-merge-dmmf.test.ts`)
 * fails CI without, which is exactly what stops a new Member relation escaping
 * merge handling. It arrives with the relation rather than a release behind it,
 * and it runs over an empty table until stage 2 creates rows.
 */
const DECLARED_FILES: Record<string, string> = {
  "src/lib/member-merge-relations.ts":
    "the required merge classification of OrganisationContact.member (resolve)",
  "src/lib/member-merge.ts":
    "the generic keep-master resolver entry the classification above names",
};

/**
 * Identifiers this stage introduced. Every one of them was measured at ZERO
 * occurrences in the tree immediately before this stage, which is what makes
 * the census exact rather than approximate. The delegate and select forms are
 * written narrowly on purpose: a bare `organisation` token would collide with
 * the long-standing `UserType` value of that name (`src/lib/access-roles.ts`)
 * and with the Xero ORGANISATION the finance code talks to, and neither of
 * those is this record.
 *
 * WHAT THE DELEGATE PATTERN DOES AND DOES NOT REACH. It is anchored on a word
 * boundary, not on a leading dot, so it catches the ALIASED DESTRUCTURE
 * (`const { organisation } = prisma` and then `organisation.findMany()`) as
 * well as `prisma.organisation.findMany()`. That shape is called out because
 * the very file this census borrows its walker from
 * (`support/booking-guest-night-writer-scan.ts`) counts aliased delegates with
 * a syntax tree precisely because the shape occurs in this repository.
 *
 * Four forms remain out of reach, and all four are STATED LIMITS rather than
 * gaps worth more regex: a bracket delegate (`prisma["organisation"]`), a
 * delegate resolved through a variable, a raw `$queryRaw` naming the table (the
 * bare token is deliberately unscanned, for the collision reason above — though
 * raw SQL naming the COLUMN is caught, because pattern 1 is a bare substring),
 * and a property read on an already-fetched row (`booking.organisation?.name`).
 * The last of those is only reachable AFTER one of the caught forms fetched the
 * data, and none of them is the real compatibility guarantee: that is the
 * nullable column plus Prisma naming its columns explicitly, which this census
 * supports rather than replaces.
 */
const NEW_IDENTIFIERS: readonly { label: string; pattern: RegExp }[] = [
  { label: "the organisationId column", pattern: /organisationId/ },
  {
    label: "the OrganisationContact model or delegate",
    pattern: /[Oo]rganisationContact/,
  },
  { label: "the OrganisationKind enum", pattern: /OrganisationKind/ },
  {
    label: "a Prisma delegate reach for an organisation record",
    pattern:
      /\borganisation[A-Za-z]*\s*\.\s*(?:findUnique|findUniqueOrThrow|findFirst|findFirstOrThrow|findMany|create|createMany|update|updateMany|upsert|delete|deleteMany|count|aggregate|groupBy)\b/,
  },
  {
    label: "an organisation relation in a select, include or nested write",
    pattern: /organisation:\s*(?:true|\{)/,
  },
];

describe("#3366: nothing reads or writes the new links yet", () => {
  const scanned = sourceFiles().map((file) => ({
    path: relativeSource(file),
    code: readFileSync(file, "utf8"),
  }));

  it("scans a meaningful number of source files", () => {
    // A walker that silently found nothing would make every assertion below
    // vacuous, which is how a census fails without failing.
    expect(scanned.length).toBeGreaterThan(500);
  });

  for (const { label, pattern } of NEW_IDENTIFIERS) {
    it(`finds ${label} only in the files that declare it`, () => {
      const hits = scanned
        .filter(({ code }) => pattern.test(code))
        .map(({ path }) => path)
        .filter((path) => !(path in DECLARED_FILES));

      expect(
        hits,
        "#3366 is stage 1 and is deliberately INERT: nothing may read or write " +
          "the organisation link yet. A reader belongs in stage 2 (#3367), the " +
          "ownership accessor in stage 3 (#3368). If a file really must name it, " +
          "add it to DECLARED_FILES with the reason.",
      ).toEqual([]);
    });
  }

  it("FAILS when a source file starts reading the link (fixture proof)", () => {
    const injected = [
      {
        path: "src/lib/some-new-reader.ts",
        code: "const owner = booking.organisationId;",
      },
    ];
    const hits = injected
      .filter(({ code }) => NEW_IDENTIFIERS[0].pattern.test(code))
      .map(({ path }) => path)
      .filter((path) => !(path in DECLARED_FILES));

    expect(hits).toEqual(["src/lib/some-new-reader.ts"]);
  });

  it("FAILS on an ALIASED delegate, not only on `prisma.organisation.…` (fixture proof)", () => {
    // The walker this census borrows counts aliased delegates with a syntax
    // tree because the shape is real here, so the regex is anchored on a word
    // boundary rather than on a leading dot. Both forms must be caught, and a
    // near-miss that is NOT a delegate reach must not be.
    const delegate = NEW_IDENTIFIERS.find(({ label }) =>
      label.includes("Prisma delegate"),
    )!.pattern;

    expect(delegate.test("const { organisation } = prisma;\norganisation.findMany();")).toBe(true);
    expect(delegate.test("await prisma.organisation.findUnique({ where });")).toBe(true);
    expect(delegate.test("await prisma.organisationContact.create({ data });")).toBe(true);
    // The boundary really is a boundary: a longer identifier that merely ENDS
    // in the word is not a delegate reach for this record.
    expect(delegate.test("const rows = await suborganisation.findMany();")).toBe(false);
  });

  it("keeps the declared files genuinely declared", () => {
    // A stale allowlist entry is a censused file nobody is watching any more.
    // Each declared file must still name at least one of the identifiers.
    for (const path of Object.keys(DECLARED_FILES)) {
      const file = scanned.find((s) => s.path === path);
      expect(
        file,
        `${path} is declared in DECLARED_FILES but was not scanned`,
      ).toBeDefined();
      expect(
        NEW_IDENTIFIERS.some(({ pattern }) => pattern.test(file?.code ?? "")),
        `${path} no longer names any organisation identifier — drop its DECLARED_FILES entry`,
      ).toBe(true);
    }
  });
});
