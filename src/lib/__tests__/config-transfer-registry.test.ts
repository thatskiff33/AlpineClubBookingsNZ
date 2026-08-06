import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  assertDescriptorValid,
  isForbiddenField,
  isSensitiveOptInField,
  getRegisteredEntities,
  type EntityDescriptor,
} from "@/lib/config-transfer/registry";
// Importing the category modules registers their descriptors as a side effect
// (and runs assertDescriptorValid at load). ALL seven modules are imported so
// the forbidden-field sweep below covers every category's allowlist — not just
// site-content's.
import "@/lib/config-transfer/categories/site-content";
import "@/lib/config-transfer/categories/club-settings";
import "@/lib/config-transfer/categories/lodge-config";
import "@/lib/config-transfer/categories/bed-allocation-settings";
import "@/lib/config-transfer/categories/booking-policies";
import "@/lib/config-transfer/categories/lodge-ops";
import "@/lib/config-transfer/categories/committee";
import "@/lib/config-transfer/categories/induction";
import "@/lib/config-transfer/categories/membership-fees";
import "@/lib/config-transfer/categories/age-tier";
import "@/lib/config-transfer/categories/xero-config";

function descriptor(overrides: Partial<EntityDescriptor> = {}): EntityDescriptor {
  return {
    entity: "lodge",
    category: "lodge-config",
    tier: "key-strong",
    format: "csv",
    file: "lodge-config/lodges.csv",
    naturalKey: ["slug"],
    singleton: false,
    fields: ["slug", "name", "active"],
    ...overrides,
  };
}

describe("config-transfer registry — forbidden field guard", () => {
  it("flags secrets, tokens, and member coupling", () => {
    expect(isForbiddenField("passwordHash")).toBe(true);
    expect(isForbiddenField("stripeSecretKey")).toBe(true);
    expect(isForbiddenField("resetToken")).toBe(true);
    expect(isForbiddenField("apiKey")).toBe(true);
    expect(isForbiddenField("updatedByMemberId")).toBe(true);
    expect(isForbiddenField("memberId")).toBe(true);
    expect(isForbiddenField("twoFactorSecret")).toBe(true);
  });

  it("does not flag ordinary config fields", () => {
    for (const f of ["slug", "name", "capacity", "sortOrder", "contentHtml"]) {
      expect(isForbiddenField(f)).toBe(false);
    }
  });

  // #2200: the password-POLICY length bound is portable (an integer rule), but
  // every credential-bearing password field stays blocked.
  it("allows the password-length policy bound but still blocks credential material", () => {
    expect(isForbiddenField("minPasswordLength")).toBe(false);
    expect(isForbiddenField("maxPasswordLength")).toBe(false);
    expect(isForbiddenField("password")).toBe(true);
    expect(isForbiddenField("passwordHash")).toBe(true);
    expect(isForbiddenField("newPassword")).toBe(true);
    expect(isForbiddenField("forcePasswordChange")).toBe(true);
  });

  it("treats door codes as sensitive opt-in, not forbidden", () => {
    expect(isSensitiveOptInField("doorCode")).toBe(true);
    expect(isForbiddenField("doorCode")).toBe(false);
  });

  // #2079: encrypted integration credentials must never be exportable.
  it("flags integration-credential ciphertext/auth-tag fields as forbidden", () => {
    expect(isForbiddenField("ciphertext")).toBe(true);
    expect(isForbiddenField("authTag")).toBe(true);
    // labelVersion / secretSource are metadata, but `secret`-containing names
    // are caught by the generic secret pattern.
    expect(isForbiddenField("secretSource")).toBe(true);
  });

  it("registers NO IntegrationCredential entity (excluded from config transfer)", () => {
    const entities = getRegisteredEntities();
    for (const descriptor of entities) {
      expect(descriptor.entity).not.toMatch(/integration.?credential/i);
      expect(descriptor.file).not.toMatch(/integration.?credential/i);
      // Even the un-patternable `iv` field can never ride along, because the
      // entity is simply never registered for export.
      expect(descriptor.fields).not.toContain("iv");
      expect(descriptor.fields).not.toContain("ciphertext");
      expect(descriptor.fields).not.toContain("authTag");
    }
  });
});

describe("config-transfer registry — assertDescriptorValid", () => {
  it("accepts a well-formed descriptor", () => {
    expect(() => assertDescriptorValid(descriptor())).not.toThrow();
  });

  it("rejects a forbidden field in the allowlist", () => {
    expect(() =>
      assertDescriptorValid(descriptor({ fields: ["slug", "updatedByMemberId"] })),
    ).toThrow(/forbidden field/i);
  });

  it("rejects a non-singleton with no natural key", () => {
    expect(() =>
      assertDescriptorValid(descriptor({ naturalKey: [] })),
    ).toThrow(/no natural key/i);
  });

  it("allows a singleton with no natural key", () => {
    expect(() =>
      assertDescriptorValid(
        descriptor({
          entity: "club-module-settings",
          category: "club-settings",
          format: "json",
          singleton: true,
          naturalKey: [],
          fields: ["bedAllocation", "twoFactor"],
        }),
      ),
    ).not.toThrow();
  });

  it("requires a sensitive field to be declared as opt-in", () => {
    expect(() =>
      assertDescriptorValid(
        descriptor({ fields: ["slug", "name", "doorCode"] }),
      ),
    ).toThrow(/must be declared in optInFields/i);

    expect(() =>
      assertDescriptorValid(
        descriptor({
          fields: ["slug", "name", "doorCode"],
          optInFields: ["doorCode"],
        }),
      ),
    ).not.toThrow();
  });

  it("rejects an optInField that is not in fields", () => {
    expect(() =>
      assertDescriptorValid(descriptor({ optInFields: ["doorCode"] })),
    ).toThrow(/optInField not in fields/i);
  });
});

describe("config-transfer registry — registered descriptors", () => {
  it("every category's descriptors are registered and pass the security sweep", () => {
    const entities = getRegisteredEntities();
    // One representative entity per category module proves each registered.
    expect(entities.map((e) => e.entity)).toEqual(
      expect.arrayContaining([
        "page-content",
        "site-content",
        "club-theme",
        "minimum-stay-policy",
        "club-module-settings",
        "email-message-setting",
        "lodge",
        "lodge-room",
        "lodge-bed",
        "lodge-bed-allocation-settings",
        "season",
        "season-rate",
        "lodge-instruction",
        "chore-template",
        "committee-role",
        "induction-template",
        "joining-fee",
        "annual-fee",
        "annual-fee-component",
        "xero-account-mapping",
        "xero-item-code-mapping",
      ]),
    );
    // Every registered descriptor must satisfy the security/shape rules.
    for (const descriptor of entities) {
      expect(() => assertDescriptorValid(descriptor)).not.toThrow();
      for (const field of descriptor.fields) {
        expect(isForbiddenField(field)).toBe(false);
      }
    }
  });
});
