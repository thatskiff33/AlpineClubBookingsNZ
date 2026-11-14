import { describe, expect, it, vi } from "vitest";

// Importing xero-contacts pulls in prisma/xero-node/xero-sync at module load;
// this is a pure-function parity test, so stub the heavy singletons. We do NOT
// override buildXeroIdempotencyKey here (unused) and we keep everything else
// real — only the create-gate helper is exercised.
vi.mock("@/lib/prisma", () => ({ prisma: { member: {}, $transaction: vi.fn() } }));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { getMissingFieldsForXeroContactCreate } from "@/lib/xero-contacts";
import {
  emptyForm,
  getBlankOptionalXeroFields,
  getMissingFieldsForXeroCreate,
} from "@/app/(admin)/admin/membership/members/_utils";
import type { MemberForm } from "@/app/(admin)/admin/membership/members/_types";

// A member/form that is complete for the OLD strict gate — used to prove the
// new gate no longer flags any optional field.
const completeForm: MemberForm = {
  ...emptyForm,
  firstName: "Alice",
  lastName: "Smith",
  email: "alice@example.com",
  phoneCountryCode: "64",
  phoneAreaCode: "27",
  phoneNumber: "1234567",
  dateOfBirth: "1990-01-15",
  joinedDate: "2024-05-01",
  streetAddressLine1: "1 Main Rd",
  streetCity: "Wellington",
  streetRegion: "Wellington",
  streetPostalCode: "6011",
  streetCountry: "New Zealand",
  postalAddressLine1: "1 Main Rd",
  postalCity: "Wellington",
  postalRegion: "Wellington",
  postalPostalCode: "6011",
  postalCountry: "New Zealand",
};

// Only name + email — every optional field blank.
const nameEmailOnlyForm: MemberForm = {
  ...emptyForm,
  firstName: "Bob",
  lastName: "Jones",
  email: "bob@example.com",
};

describe("client create gate getMissingFieldsForXeroCreate (#2089)", () => {
  it("requires only first name, last name, and email", () => {
    expect(getMissingFieldsForXeroCreate(completeForm)).toEqual([]);
    expect(getMissingFieldsForXeroCreate(nameEmailOnlyForm)).toEqual([]);
  });

  it("never flags optional fields (phone / DOB / joined date / addresses)", () => {
    // A member with only name + email has all optional fields blank yet passes.
    expect(getMissingFieldsForXeroCreate(nameEmailOnlyForm)).toEqual([]);
  });

  it("flags a missing first name", () => {
    expect(
      getMissingFieldsForXeroCreate({ ...completeForm, firstName: "  " })
    ).toEqual(["First Name"]);
  });

  it("flags a missing last name", () => {
    expect(
      getMissingFieldsForXeroCreate({ ...completeForm, lastName: "" })
    ).toEqual(["Last Name"]);
  });

  it("flags a missing email (still required for invoice delivery/matching)", () => {
    expect(
      getMissingFieldsForXeroCreate({ ...completeForm, email: "" })
    ).toEqual(["Email"]);
  });

  it("flags all three when name and email are blank", () => {
    expect(
      getMissingFieldsForXeroCreate({
        ...emptyForm,
        firstName: "",
        lastName: "",
        email: "",
      })
    ).toEqual(["First Name", "Last Name", "Email"]);
  });
});

describe("getBlankOptionalXeroFields (#2089 info note)", () => {
  it("returns nothing when the profile is complete", () => {
    expect(getBlankOptionalXeroFields(completeForm)).toEqual([]);
  });

  it("lists every blank optional field for a name+email-only member", () => {
    expect(getBlankOptionalXeroFields(nameEmailOnlyForm)).toEqual([
      "phone",
      "date of birth",
      "joined date",
      "physical address",
      "postal address",
    ]);
  });

  it("lists exactly the blank fields (e.g. postal address + joined date)", () => {
    const form: MemberForm = {
      ...completeForm,
      joinedDate: "",
      postalAddressLine1: "",
    };
    expect(getBlankOptionalXeroFields(form)).toEqual([
      "joined date",
      "postal address",
    ]);
  });

  it("treats a phone as blank when any single part is missing", () => {
    expect(
      getBlankOptionalXeroFields({ ...completeForm, phoneAreaCode: "" })
    ).toEqual(["phone"]);
  });
});

describe("client/server create-gate parity (#2089)", () => {
  // The client operates on MemberForm (string fields); the server on a member
  // record (nullable). Feed equivalent inputs and assert identical required
  // sets so the two gates can never drift.
  const cases: Array<{
    name: string;
    firstName: string;
    lastName: string;
    email: string;
  }> = [
    { name: "complete", firstName: "A", lastName: "B", email: "a@b.com" },
    { name: "missing first", firstName: "", lastName: "B", email: "a@b.com" },
    { name: "missing last", firstName: "A", lastName: "", email: "a@b.com" },
    { name: "missing email", firstName: "A", lastName: "B", email: "" },
    { name: "whitespace only", firstName: " ", lastName: " ", email: " " },
    { name: "all blank", firstName: "", lastName: "", email: "" },
  ];

  it.each(cases)(
    "produces the same required set for '$name'",
    ({ firstName, lastName, email }) => {
      const clientResult = getMissingFieldsForXeroCreate({
        ...emptyForm,
        firstName,
        lastName,
        email,
        // Every optional field left blank — must not affect either gate.
      });
      const serverResult = getMissingFieldsForXeroContactCreate({
        firstName: firstName || null,
        lastName: lastName || null,
        email: email || null,
      });
      expect(clientResult).toEqual(serverResult);
    }
  );
});
