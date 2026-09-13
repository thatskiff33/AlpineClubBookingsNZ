/**
 * #2936 — the read-only half of "which school is this?".
 *
 * Two properties matter here and nothing else does. The preview must ask
 * Postgres the SAME question the approval's resolve asks, or an officer
 * confirms one answer and gets another; and the acknowledgement must refuse
 * anything but an exact match, because the failure it prevents — a school
 * quietly joining another school's Xero customer — is not one anybody finds
 * afterwards.
 */
import { describe, expect, it, vi } from "vitest";
import { OrganisationContactRole } from "@prisma/client";

import {
  assertSchoolRecordOutcomeAcknowledged,
  EmptySchoolNameError,
  normaliseSchoolNameForStorage,
  previewSchoolRecordForName,
  SchoolRecordAcknowledgementError,
  type SchoolRecordPreview,
} from "@/lib/school-organisation-preview";
import { schoolOrganisationNameClaim } from "@/lib/school-organisations";

type Reader = Parameters<typeof previewSchoolRecordForName>[0];

function reader(row: unknown) {
  const findFirst = vi.fn().mockResolvedValue(row);
  return {
    db: { organisation: { findFirst } } as unknown as Reader,
    findFirst,
  };
}

describe("normalising the name the club would store", () => {
  it("trims and collapses whitespace, exactly as the resolve does", () => {
    expect(normaliseSchoolNameForStorage("  Tokoroa   Primary  School ")).toBe(
      "Tokoroa Primary School",
    );
  });

  it("caps at the column's length rather than refusing a long name", () => {
    expect(normaliseSchoolNameForStorage("A".repeat(260))).toHaveLength(200);
  });

  it("refuses a name that is nothing once normalised", () => {
    expect(() => normaliseSchoolNameForStorage("   ")).toThrow(EmptySchoolNameError);
  });
});

describe("previewing the record a name claims", () => {
  it("asks Postgres through the ONE claim filter, not a comparison of its own", async () => {
    const { db, findFirst } = reader(null);
    await previewSchoolRecordForName(db, "  Tokoroa Primary School ");
    expect(findFirst.mock.calls[0][0].where).toEqual(
      schoolOrganisationNameClaim("Tokoroa Primary School"),
    );
  });

  it("picks the same row the resolve would: a live record first, then the oldest", async () => {
    const { db, findFirst } = reader(null);
    await previewSchoolRecordForName(db, "Tokoroa Primary School");
    expect(findFirst.mock.calls[0][0].orderBy).toEqual([
      { archivedAt: { sort: "asc", nulls: "first" } },
      { createdAt: "asc" },
    ]);
  });

  it("reads only the TEACHER contacts, which are the set approval replaces", async () => {
    const { db, findFirst } = reader(null);
    await previewSchoolRecordForName(db, "Tokoroa Primary School");
    expect(findFirst.mock.calls[0][0].select.contacts.where).toEqual({
      role: OrganisationContactRole.TEACHER,
    });
  });

  it("reports a name the club has never heard of as a new school", async () => {
    const { db } = reader(null);
    const preview = await previewSchoolRecordForName(db, "Brand New School");
    expect(preview).toEqual({
      normalisedName: "Brand New School",
      known: false,
      schoolRecordId: null,
      schoolRecordName: null,
      schoolRecordArchived: false,
      schoolRecordHasXeroCustomer: false,
      currentContactNames: [],
      currentContactNamesTruncated: false,
    });
  });

  it("reports the record's OWN spelling, its Xero customer and its people", async () => {
    const { db } = reader({
      id: "org-7",
      name: "Tokoroa Primary School",
      archivedAt: new Date("2026-01-01T00:00:00.000Z"),
      xeroContactId: "xero-7",
      contacts: [
        { member: { firstName: "Bill", lastName: "Carter", email: null } },
        { member: { firstName: "Dana", lastName: "Ellis", email: null } },
      ],
    });
    const preview = await previewSchoolRecordForName(db, "tokoroa primary school");
    expect(preview.known).toBe(true);
    expect(preview.schoolRecordId).toBe("org-7");
    // A match never renames the record, so the officer is shown the club's own
    // spelling beside what they typed.
    expect(preview.schoolRecordName).toBe("Tokoroa Primary School");
    // Archived still matches: "stop offering it" is not "a different school".
    expect(preview.schoolRecordArchived).toBe(true);
    expect(preview.schoolRecordHasXeroCustomer).toBe(true);
    expect(preview.currentContactNames).toEqual(["Bill Carter", "Dana Ellis"]);
    expect(preview.currentContactNamesTruncated).toBe(false);
  });

  it("says there are more people rather than implying it listed them all", async () => {
    const { db } = reader({
      id: "org-7",
      name: "Big School",
      archivedAt: null,
      xeroContactId: null,
      contacts: Array.from({ length: 11 }, (_, index) => ({
        member: {
          firstName: "Teacher",
          lastName: String(index + 1),
          email: null,
        },
      })),
    });
    const preview = await previewSchoolRecordForName(db, "Big School");
    // The PROVIDER's cap, not one of this module's own: these are the people an
    // officer would actually see on the school's accounting contact.
    expect(preview.currentContactNames).toHaveLength(5);
    expect(preview.currentContactNamesTruncated).toBe(true);
  });

  it("names the people the accounting contact really shows, newest first", async () => {
    // The defect this pins: the preview used to ask for the OLDEST ten while
    // the provider takes the NEWEST five. So the officer was shown precisely
    // the associations the cap had already dropped — told that approving would
    // displace people the treasurer has never seen, and not told about the ones
    // it actually would.
    const { db, findFirst } = reader({
      id: "org-7",
      name: "Big School",
      archivedAt: null,
      xeroContactId: null,
      contacts: [
        { member: { firstName: "New", lastName: "Teacher", email: null } },
        { member: { firstName: "Old", lastName: "Teacher", email: null } },
      ],
    });
    const preview = await previewSchoolRecordForName(db, "Big School");
    expect(findFirst.mock.calls[0][0].select.contacts.orderBy).toEqual([
      { createdAt: "desc" },
      { id: "desc" },
    ]);
    expect(preview.currentContactNames).toEqual(["New Teacher", "Old Teacher"]);
  });

  it("collapses one human recorded twice, as the provider does", async () => {
    // A returning teacher is minted as a fresh Member on every approval, so the
    // same person appearing two or three times is an ordinary state. Counting
    // them separately would spend the cap on one human and claim the school has
    // more contacts than it has.
    const { db } = reader({
      id: "org-7",
      name: "Big School",
      archivedAt: null,
      xeroContactId: null,
      contacts: [
        { member: { firstName: "Ann", lastName: "Baker", email: "A@x.test" } },
        { member: { firstName: " ann ", lastName: "baker", email: "a@x.test" } },
        { member: { firstName: "Bea", lastName: "Cole", email: null } },
      ],
    });
    const preview = await previewSchoolRecordForName(db, "Big School");
    expect(preview.currentContactNames).toEqual(["Ann Baker", "Bea Cole"]);
    expect(preview.currentContactNamesTruncated).toBe(false);
  });
});

describe("the acknowledgement is checked against the record, not the tick", () => {
  const known: SchoolRecordPreview = {
    normalisedName: "Tokoroa Primary School",
    known: true,
    schoolRecordId: "org-7",
    schoolRecordName: "Tokoroa Primary School",
    schoolRecordArchived: false,
    schoolRecordHasXeroCustomer: true,
    currentContactNames: [],
    currentContactNamesTruncated: false,
  };
  const unknown: SchoolRecordPreview = {
    ...known,
    known: false,
    schoolRecordId: null,
    schoolRecordName: null,
    schoolRecordHasXeroCustomer: false,
  };

  it("accepts the existing record the name actually claims", () => {
    expect(() =>
      assertSchoolRecordOutcomeAcknowledged(known, {
        outcome: "existing",
        schoolRecordId: "org-7",
      }),
    ).not.toThrow();
  });

  it("accepts a new school when the club really has none", () => {
    expect(() =>
      assertSchoolRecordOutcomeAcknowledged(unknown, { outcome: "new" }),
    ).not.toThrow();
  });

  it("refuses 'new' over a record that exists, and names its Xero customer", () => {
    expect(() =>
      assertSchoolRecordOutcomeAcknowledged(known, { outcome: "new" }),
    ).toThrow(SchoolRecordAcknowledgementError);
    expect(() =>
      assertSchoolRecordOutcomeAcknowledged(known, { outcome: "new" }),
    ).toThrow(/with its own Xero customer/);
  });

  it("refuses the RIGHT outcome pointed at the WRONG record", () => {
    // The race the write-time re-read exists for: the officer accepted one
    // school and another approval moved what the name resolves to.
    expect(() =>
      assertSchoolRecordOutcomeAcknowledged(known, {
        outcome: "existing",
        schoolRecordId: "org-other",
      }),
    ).toThrow(SchoolRecordAcknowledgementError);
  });

  it("refuses 'existing' when the club has no such school", () => {
    expect(() =>
      assertSchoolRecordOutcomeAcknowledged(unknown, {
        outcome: "existing",
        schoolRecordId: "org-7",
      }),
    ).toThrow(/no school on record/);
  });

  it("refuses 'new' that still carries a record id, rather than ignoring it", () => {
    expect(() =>
      assertSchoolRecordOutcomeAcknowledged(unknown, {
        outcome: "new",
        schoolRecordId: "org-7",
      }),
    ).toThrow(SchoolRecordAcknowledgementError);
  });
});
