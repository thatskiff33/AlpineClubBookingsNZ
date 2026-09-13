import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  relativeSource,
  sourceFiles,
} from "@/lib/__tests__/support/booking-guest-night-writer-scan";

/**
 * WHO READS A SCHOOL'S ORGANISATION RECORD — programme #2912, stages 1 and 2.
 *
 * THIS FILE REPLACES `organisation-record-inert-contract.test.ts`, and the
 * replacement is deliberate rather than incidental. Stage 1 (#3366) shipped
 * that file to prove its own claim of inertness: the records exist, are
 * reachable, and NOTHING in the tree reads them. That claim was true for exactly
 * one release. Stage 2 (#3367) is the release where things start to read them,
 * so a test asserting "zero readers" had to go — but deleting it would have
 * traded a real guarantee for nothing.
 *
 * The property worth keeping was never "zero readers". It was **the readers are
 * the ones somebody decided on**, and that survives the change: the allowlist
 * below is now stage 2's deliberate reader set, each entry carrying the part it
 * plays, still asserted with `toEqual` against an exact list. An unplanned
 * reader — stage 3's sweep arriving early, or an unrelated lane reaching for the
 * link — still fails here and still has to be argued for.
 *
 * Three things are pinned, and each answers one of the two issues' criteria.
 *
 *  1. THE RECORDS EXIST AND ARE REACHABLE. `Organisation` and
 *     `OrganisationContact` are in the datamodel, and a booking and a booking
 *     request each carry an OPTIONAL link to an organisation. Optional is the
 *     load-bearing half: a nullable column is what lets the currently deployed
 *     release keep reading these two tables, because its inserts omit the
 *     column and a nullable column with no default accepts that. Stage 2 adds
 *     no column at all, so this section is unchanged and still true.
 *
 *  2. NO EXISTING QUERY CHANGES ITS RESULT. Every scalar column of `Booking`
 *     and `BookingRequest` is pinned against the list the PRE-STAGE schema
 *     declared, in order, read out of a Prisma client generated from
 *     `origin/epic/2725-mad` at `5c9c09882`. Drop stage 1's one added column
 *     and a default-selection read serialises BYTE FOR BYTE as it did before —
 *     asserted on the JSON, not merely on the set, so a column inserted in a
 *     way that reorders its neighbours fails here too.
 *
 *  3. THE READERS ARE EXACTLY THE DECLARED ONES, AND THEY DO THE DECLARED JOB.
 *     Every non-test source file in the tree is scanned for the identifiers this
 *     programme introduced; a hit outside the allowlist fails. And because an
 *     allowlist of readers rots into a list of files that happen to mention a
 *     word, the last section asserts what each declared file actually reads the
 *     link FOR.
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
 * THE READERS, and why this replaced an inertness test rather than deleting it.
 *
 * Stage 1 (#3366) shipped `organisation-record-inert-contract.test.ts`, whose
 * third section proved that NOTHING in the tree read or wrote the organisation
 * link. That claim was true for exactly one release, and #3367 is the release
 * where things start to read it — so the test had to change. Deleting the
 * section would have traded a real guarantee for nothing, because the property
 * worth keeping was never "zero readers": it was **the readers are the ones
 * somebody decided on**.
 *
 * So the section is REPLACED, not removed. The allowlist below is now the set of
 * readers and writers stage 2 deliberately adds, each with the role it plays,
 * and the assertion is still `toEqual` against an exact list. An unplanned
 * reader arriving in stage 3's sweep, or in an unrelated lane, still fails here
 * and still has to be argued for — which is the whole value the stage-1 census
 * had.
 *
 * `npm run test:related` cannot select this file: it reads the tree from disk
 * and has no import edge to what it scans, so like the other censuses in this
 * directory it is CI-caught by design.
 */
const DECLARED_FILES: Record<string, string> = {
  // ---- carried forward from stage 1, unchanged -------------------------
  "src/lib/member-merge-relations.ts":
    "the required merge classification of OrganisationContact.member (resolve)",
  "src/lib/member-merge.ts":
    "the generic keep-master resolver entry the classification above names",
  // ---- added by stage 2 (#3367) ---------------------------------------
  "src/lib/school-organisations.ts":
    "the ONE home for resolving a school's Organisation from its name",
  "src/lib/school-booking-request.ts":
    "approval: resolves or creates the Organisation under the approval " +
    "transaction's global lock, links it from the booking and the request, and " +
    "records each teacher as an OrganisationContact",
  "src/lib/organisation-xero-contacts.ts":
    "the organisation-keyed Xero contact resolve, and the decision that an " +
    "Organisation-linked booking is invoiced as the Organisation",
  "src/lib/organisation-xero-contact-persons.ts":
    "its other half: derives the people named on that contact from the " +
    "organisation's contact rows, and keeps them honest",
  "src/lib/xero-contact-home.ts":
    "INV-INT-018: the two-homes refusal, which reads the Organisation holding " +
    "a Xero contact id so a member cannot claim it as well, and the ONE " +
    "transfer that lets a school take the contact its own invented member holds",
};

/**
 * Identifiers this programme introduced. Every one of them was measured at ZERO
 * occurrences in the tree immediately before stage 1, which is what makes the
 * census exact rather than approximate. The delegate and select forms are
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
 * gaps worth more regex: a bracket delegate, a delegate resolved through a
 * variable, a raw `$queryRaw` naming the table (the bare token is deliberately
 * unscanned, for the collision reason above — though raw SQL naming the COLUMN
 * is caught, because pattern 1 is a bare substring), and a property read on an
 * already-fetched row. The last of those is only reachable AFTER one of the
 * caught forms fetched the data.
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

describe("#3367: the organisation link is read by EXACTLY the declared files", () => {
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
    it(`finds ${label} only in the declared files`, () => {
      const hits = scanned
        .filter(({ code }) => pattern.test(code))
        .map(({ path }) => path)
        .filter((path) => !(path in DECLARED_FILES));

      expect(
        hits,
        "A file outside the declared set reads or writes the organisation " +
          "link. Stage 2 (#3367) deliberately keeps the reader set small and " +
          "argued-for: the one-home accessor that replaces the 510 direct " +
          "member reads is stage 3 (#3368), and making the member link " +
          "optional is stage 4 (#3369). If this file really must name it, add " +
          "it to DECLARED_FILES with the role it plays.",
      ).toEqual([]);
    });
  }

  it("FAILS when an undeclared file starts reading the link (fixture proof)", () => {
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

  it("FAILS on an ALIASED delegate, not only on a dotted one (fixture proof)", () => {
    // The walker this census borrows counts aliased delegates with a syntax
    // tree because the shape is real here, so the regex is anchored on a word
    // boundary rather than on a leading dot. Both forms must be caught, and a
    // near-miss that is NOT a delegate reach must not be.
    const delegate = NEW_IDENTIFIERS.find(({ label }) =>
      label.includes("Prisma delegate"),
    )!.pattern;

    expect(
      delegate.test("const { organisation } = prisma;\norganisation.findMany();"),
    ).toBe(true);
    expect(delegate.test("await prisma.organisation.findUnique({ where });")).toBe(
      true,
    );
    expect(delegate.test("await prisma.organisationContact.create({ data });")).toBe(
      true,
    );
    // The boundary really is a boundary: a longer identifier that merely ENDS
    // in the word is not a delegate reach for this record.
    expect(delegate.test("const rows = await suborganisation.findMany();")).toBe(
      false,
    );
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

/**
 * The declared files do the JOB they are declared for.
 *
 * Without this, the allowlist above degrades into a list of files that happen to
 * mention a word: stage 1's census could afford that, because its answer was
 * "nobody", but an allowlist of READERS has to say what each one reads FOR or it
 * stops being a contract and becomes an exemption list.
 */
describe("#3367: each declared reader still plays its declared part", () => {
  const read = (path: string) => readFileSync(join(REPO, path), "utf8");

  it("approval resolves the school and links it from the booking and the request", () => {
    const source = read("src/lib/school-booking-request.ts");
    expect(source).toContain("resolveOrCreateSchoolOrganisation(tx, {");
    // SEVEN sites, and the count is the point: a school approval that took the
    // held-conversion branch and silently lost its organisation would be
    // invisible without it. Measured on the tree — the fresh-create booking,
    // the held-conversion booking update, the teacher association's `where` and
    // its `create`, the converted booking request, and — added in #3367's fix
    // round — the teacher RECONCILE and the audit row that records a removal.
    // A number that moves means a site was added or lost, and either way
    // somebody has to look.
    expect(
      [...source.matchAll(/organisationId: organisation\.id/g)].length,
      "the fresh booking, the held conversion, both halves of the teacher " +
        "association, the booking request, the teacher reconcile and its " +
        "audit row must all carry the school",
    ).toBe(7);
    // The reconcile is not optional: appending teacher rows without removing
    // the ones no longer named is what froze a school's Xero contact on people
    // who had left.
    expect(source).toContain("reconcileOrganisationTeachers(tx, {");
    expect(source).toContain("OrganisationContactRole.TEACHER");
  });

  it("the school resolve is called ONLY inside the locked approval transaction", () => {
    // Its unique-name claim is the global lock the approval transaction already
    // holds; calling it anywhere else reintroduces the race it relies on.
    const callers = sourceFiles()
      .map((file) => ({
        path: relativeSource(file),
        code: readFileSync(file, "utf8"),
      }))
      .filter(
        ({ path, code }) =>
          path !== "src/lib/school-organisations.ts" &&
          /resolveOrCreateSchoolOrganisation\s*\(/.test(code),
      )
      .map(({ path }) => path);
    expect(callers).toEqual(["src/lib/school-booking-request.ts"]);
  });

  it("derives the named people from the organisation's own contact rows", () => {
    // The reason the split half is declared: it is the reader of
    // `OrganisationContact`, and what it reads is what reaches Xero.
    const source = read("src/lib/organisation-xero-contact-persons.ts");
    expect(source).toContain("db.organisation.findUnique(");
    expect(source).toContain("contacts: {");
    // Derived on every resolve, never from a snapshot taken at create time —
    // that is what makes "the next approval refreshes it" true.
    expect(source).toContain("contactPersonsFingerprint");
  });

  it("the organisation is the invoiced party, and the member is the fallback", () => {
    const source = read("src/lib/organisation-xero-contacts.ts");
    const start = source.indexOf(
      "export async function findOrCreateXeroContactForInvoicedParty(",
    );
    expect(start, "the invoiced-party resolver must still exist").toBeGreaterThan(
      -1,
    );
    const rest = source.slice(start);
    const body = rest.slice(0, rest.indexOf("\n}\n"));
    expect(body.length, "its body must be bounded, not empty").toBeGreaterThan(150);
    expect(body).toContain("booking.organisationId");
    expect(body).toContain("findOrCreateXeroContactForOrganisation(");
    // The fallback is today's behaviour to the letter, so a booking with no
    // organisation is unchanged.
    expect(body).toContain("findOrCreateXeroContact(booking.memberId");
  });

  it("repairs a stale contact reference against the INVOICED party", () => {
    // `retryXeroWriteWithContactRepair` is keyed on a member and its DEFAULT
    // repair searches Xero by email — which on a school booking finds the
    // teacher whose address the school recorded and re-sends the school's
    // invoice against that person. The invoice path must therefore hand it the
    // invoiced-party repair rather than take the default.
    const source = read("src/lib/xero-booking-invoices.ts");
    expect(source).toContain("repairContactLink: invoicedPartyContactRepair(");
  });

  it("the two-homes refusal reads the organisation side, from every linker", () => {
    const source = read("src/lib/xero-contact-home.ts");
    expect(source).toContain("tx.organisation.findFirst({");
    expect(source).toContain("XeroContactTwoHomesError");
    for (const caller of [
      "src/lib/xero-contacts.ts",
      "src/lib/xero-manual-contact-link.ts",
      "src/lib/organisation-xero-contacts.ts",
    ]) {
      expect(read(caller), `${caller} must take the refusal`).toContain(
        "assertXeroContactHasNoOtherHome(",
      );
      expect(read(caller), `${caller} must take the contact-home lock`).toContain(
        "lockXeroContactHome(",
      );
    }
  });

  it("the transfer establishes the school's own member from the DATABASE", () => {
    // The one exception to the refusal, and the thing that keeps it narrow. A
    // caller-supplied member id would make it fire on whatever a mistaken call
    // site passed, so all four legs are reads inside the locked transaction.
    const source = read("src/lib/xero-contact-home.ts");
    const start = source.indexOf(
      "export async function takeXeroContactFromSchoolsOwnMember(",
    );
    expect(start, "the transfer must still exist").toBeGreaterThan(-1);
    const body = source.slice(start);
    // Legs 1 and 2 read BOTH generations of the tie, and the request half is
    // the load-bearing one: `Booking.organisationId` is written only from this
    // release, so a returning school's earlier booking carries NULL and a
    // booking-only leg 1 would answer "no" for every school that has booked
    // before — the transfer would never fire for the case it exists for.
    expect(body).toContain("tx.booking.findMany({");
    expect(body).toContain("tx.bookingRequest.findMany({");
    expect(body).toContain("convertedMemberId: holder.id");
    expect(body).toContain("schoolName: true");
    // And the name comparison goes through the ONE matching rule, never a
    // second spelling of it (INV-SSOT) — the rule that is the SAME folding
    // Xero's own name search applies, because a proof stricter than the match
    // that produced the candidate refuses the rows the search accepted.
    expect(body).toContain("isSameOrganisationName(");
    expect(source).toContain('from "@/lib/school-organisations"');
    expect(
      read("src/lib/school-organisations.ts"),
      "the predicate must fold what the contact search folds, from its one home",
    ).toContain(
      'import { normalizeXeroContactMatchValue } from "@/lib/xero-contact-name-match"',
    );
    // Leg 2 refuses on EVIDENCE: another organisation id, or free text that
    // positively resolves to another school. A name nothing answers to is
    // ambiguous and must not out-vote history that positively resolves.
    expect(body).toContain("findOtherSchoolOrganisationsNamed(tx, {");
    // Leg 3 and leg 4: it cannot sign in, and it is not a named teacher.
    expect(body).toContain("if (holder.canLogin) return null;");
    expect(body).toContain("tx.organisationContact.findUnique({");
    // The hand-over: the column, its ledger row, and the audit, all on `tx`.
    expect(body).toContain("data: { xeroContactId: null }");
    expect(body).toContain("tx.xeroObjectLink.updateMany({");
    expect(body).toContain('action: "xero.contact.moved_to_organisation"');
    expect(body).toContain('category: "xero"');
  });

  it("the organisation resolve still refuses AFTER it transfers", () => {
    // Order is the whole safety argument: the transfer removes a legitimate
    // holder and the refusal decides every other case, so a transfer that
    // declines to fire can only ever produce a refusal.
    const source = read("src/lib/organisation-xero-contacts.ts");
    const transfer = source.indexOf("takeXeroContactFromSchoolsOwnMember(tx, {");
    const refusal = source.indexOf("assertXeroContactHasNoOtherHome(tx, {");
    expect(transfer).toBeGreaterThan(-1);
    expect(refusal).toBeGreaterThan(transfer);
    // And the retired fallback stays retired: an Organisation-linked booking is
    // invoiced as the Organisation or not at all.
    expect(source).not.toContain("OrganisationXeroContactHeldByMemberError");
  });
});
