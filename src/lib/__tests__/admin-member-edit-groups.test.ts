import { describe, expect, it } from "vitest"
import {
  buildAccessRolePatch,
  buildAccountEditForm,
  buildAccountPayload,
  buildContactEditForm,
  buildContactPayload,
} from "@/lib/admin-member-edit-groups"

const CONTACT_KEYS = [
  "title",
  "firstName",
  "lastName",
  "gender",
  "email",
  "phoneCountryCode",
  "phoneAreaCode",
  "phoneNumber",
  "dateOfBirth",
  "joinedDate",
  "occupation",
  "comments",
  "ageTier",
  "streetAddressLine1",
  "streetAddressLine2",
  "streetCity",
  "streetRegion",
  "streetPostalCode",
  "streetCountry",
  "postalAddressLine1",
  "postalAddressLine2",
  "postalCity",
  "postalRegion",
  "postalPostalCode",
  "postalCountry",
  "postalSameAsPhysical",
].sort()

const ACCOUNT_KEYS = [
  "canLogin",
  "active",
  "forcePasswordChange",
  "requiresInduction",
  "inheritEmailFromId",
  "accessRoles",
  "role",
  "financeAccessLevel",
].sort()

function contactSource() {
  return {
    title: null,
    firstName: "Alice",
    lastName: "Smith",
    gender: null,
    email: "alice@example.com",
    phoneCountryCode: "64",
    phoneAreaCode: null,
    phoneNumber: "5551234",
    dateOfBirth: "1990-01-15T00:00:00.000Z",
    joinedDate: null,
    occupation: null,
    comments: "note",
    ageTier: "ADULT",
    streetAddressLine1: "1 Main Road",
    streetAddressLine2: null,
    streetCity: "Example",
    streetRegion: "Waikato",
    streetPostalCode: "3420",
    streetCountry: "New Zealand",
    postalAddressLine1: "1 Main Road",
    postalAddressLine2: null,
    postalCity: "Example",
    postalRegion: "Waikato",
    postalPostalCode: "3420",
    postalCountry: "New Zealand",
  }
}

function accountSource() {
  return {
    canLogin: true,
    active: true,
    forcePasswordChange: false,
    requiresInduction: false,
    inheritEmailFromId: null,
    accessRoles: ["USER"],
    role: "USER" as const,
    financeAccessLevel: "NONE" as const,
  }
}

describe("admin-member-edit-groups", () => {
  describe("buildContactPayload", () => {
    it("emits exactly the contact group's keys — no access/auth fields, no lifeMemberDate", () => {
      const payload = buildContactPayload(buildContactEditForm(contactSource()))
      expect(Object.keys(payload).sort()).toEqual(CONTACT_KEYS)
      expect(payload).not.toHaveProperty("lifeMemberDate")
      expect(payload).not.toHaveProperty("accessRoles")
      expect(payload).not.toHaveProperty("canLogin")
      expect(payload).not.toHaveProperty("active")
    })

    it("coerces empty strings to null and preserves values", () => {
      const form = buildContactEditForm(contactSource())
      const payload = buildContactPayload(form)
      expect(payload.title).toBeNull()
      expect(payload.gender).toBeNull()
      expect(payload.phoneAreaCode).toBeNull()
      expect(payload.joinedDate).toBeNull()
      expect(payload.occupation).toBeNull()
      expect(payload.streetAddressLine2).toBeNull()
      expect(payload.firstName).toBe("Alice")
      expect(payload.email).toBe("alice@example.com")
      expect(payload.dateOfBirth).toBe("1990-01-15")
      expect(payload.comments).toBe("note")
      expect(payload.postalSameAsPhysical).toBe(true)
    })

    it("keeps a distinct postal address when it differs from physical", () => {
      const form = buildContactEditForm({
        ...contactSource(),
        postalAddressLine1: "PO Box 5",
      })
      expect(form.postalSameAsPhysical).toBe(false)
      expect(buildContactPayload(form).postalAddressLine1).toBe("PO Box 5")
    })
  })

  // #2941: the dietary field is sent only when the admin changed it, so an
  // unrelated Contact save cannot revert a newer member edit (lost update).
  describe("buildContactPayload dietary/allergy field", () => {
    it("sends nothing when the detail response carried no key", () => {
      expect(buildContactPayload(buildContactEditForm(contactSource()))).not.toHaveProperty(
        "dietaryRequirements",
      )
    })

    it("sends nothing on an unrelated save, even with whitespace-only churn", () => {
      const form = buildContactEditForm({
        ...contactSource(),
        dietaryRequirements: "Vegetarian",
      })
      expect(buildContactPayload(form)).not.toHaveProperty("dietaryRequirements")
      expect(
        buildContactPayload({ ...form, dietaryRequirements: "  Vegetarian  " }),
      ).not.toHaveProperty("dietaryRequirements")
    })

    it("sends the value the admin changed, and a clear as null", () => {
      const form = buildContactEditForm({
        ...contactSource(),
        dietaryRequirements: "Vegetarian",
      })
      expect(
        buildContactPayload({ ...form, dietaryRequirements: "Vegan" }).dietaryRequirements,
      ).toBe("Vegan")
      expect(
        buildContactPayload({ ...form, dietaryRequirements: "" }).dietaryRequirements,
      ).toBeNull()
    })
  })

  describe("buildAccountPayload", () => {
    it("emits exactly the account group's keys — no contact fields", () => {
      const payload = buildAccountPayload(buildAccountEditForm(accountSource()))
      expect(Object.keys(payload).sort()).toEqual(ACCOUNT_KEYS)
      expect(payload).not.toHaveProperty("email")
      expect(payload).not.toHaveProperty("firstName")
      expect(payload).not.toHaveProperty("lifeMemberDate")
    })

    it("coerces an empty inheritEmailFromId to null", () => {
      const payload = buildAccountPayload({
        ...buildAccountEditForm(accountSource()),
        inheritEmailFromId: "",
      })
      expect(payload.inheritEmailFromId).toBeNull()
    })
  })

  describe("buildAccessRolePatch", () => {
    it("derives the legacy role and finance level from tokens (dialog parity)", () => {
      const patch = buildAccessRolePatch(["USER"], [])
      expect(patch.accessRoles).toEqual(["USER"])
      expect(patch.role).toBe("USER")
      expect(patch).toHaveProperty("financeAccessLevel")
    })

    it("maps an admin token to the ADMIN legacy role", () => {
      const patch = buildAccessRolePatch(["ADMIN"], [])
      expect(patch.role).toBe("ADMIN")
    })
  })
})
