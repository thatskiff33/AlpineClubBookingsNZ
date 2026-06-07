import { describe, expect, it } from "vitest";
import { clubConfigSchema, featureFlagsSchema } from "@/config/schema";

const nightlyRates = {
  winter: { memberCents: 4500, nonMemberCents: 6500 },
  summer: { memberCents: 3500, nonMemberCents: 5000 },
};

const validClub = {
  name: "Example Mountain Club",
  shortName: "EMC",
  supportEmail: "support@example.org",
  contactEmail: "bookings@example.org",
  publicUrl: "https://example.org",
  emailFromName: "Example Mountain Club - Online Booking System",
  beds: [
    { id: "lodge", name: "Main Lodge", capacity: 20, type: "dormitory" as const },
  ],
  ageTiers: [
    { id: "INFANT", label: "Infant", minAge: 0, maxAge: 4, subscriptionRequiredForBooking: false, familyGroupRequestCreateMemberAllowed: true, nightlyRates },
    { id: "ADULT", label: "Adult", minAge: 18, maxAge: null, subscriptionRequiredForBooking: true, familyGroupRequestCreateMemberAllowed: false, nightlyRates },
  ],
};

describe("clubConfigSchema", () => {
  it("accepts a valid config", () => {
    expect(clubConfigSchema.parse(validClub)).toEqual(validClub);
  });

  it("treats contactEmail and shortName as optional", () => {
    const rest: Record<string, unknown> = { ...validClub };
    delete rest.contactEmail;
    delete rest.shortName;
    expect(() => clubConfigSchema.parse(rest)).not.toThrow();
  });

  it("rejects a missing required field with a useful error", () => {
    const broken: Record<string, unknown> = { ...validClub };
    delete broken.name;
    const result = clubConfigSchema.safeParse(broken);
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join(".") === "name");
      expect(issue).toBeDefined();
    }
  });

  it("rejects an invalid email", () => {
    const result = clubConfigSchema.safeParse({ ...validClub, supportEmail: "not-an-email" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join(".") === "supportEmail")).toBe(true);
    }
  });

  it("rejects publicUrl with a trailing slash", () => {
    const result = clubConfigSchema.safeParse({ ...validClub, publicUrl: "https://example.org/" });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join(".") === "publicUrl");
      expect(issue?.message).toMatch(/trailing slash/);
    }
  });

  it("rejects publicUrl that is not a URL", () => {
    const result = clubConfigSchema.safeParse({ ...validClub, publicUrl: "example.org" });
    expect(result.success).toBe(false);
  });

  it.each(["javascript:alert(1)", "data:text/html,hello", "ftp://example.org"])(
    "rejects publicUrl schemes that are not http(s): %s",
    (publicUrl) => {
      const result = clubConfigSchema.safeParse({ ...validClub, publicUrl });
      expect(result.success).toBe(false);
    },
  );

  it("rejects unknown keys (strict mode)", () => {
    const result = clubConfigSchema.safeParse({ ...validClub, unexpectedKey: "boom" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.toLowerCase().includes("unrecognized"))).toBe(true);
    }
  });

  it("rejects beds with zero or negative capacity", () => {
    const result = clubConfigSchema.safeParse({
      ...validClub,
      beds: [{ id: "lodge", name: "Lodge", capacity: 0, type: "dormitory" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects beds with an unknown type", () => {
    const result = clubConfigSchema.safeParse({
      ...validClub,
      beds: [{ id: "lodge", name: "Lodge", capacity: 5, type: "yurt" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty beds array", () => {
    const result = clubConfigSchema.safeParse({ ...validClub, beds: [] });
    expect(result.success).toBe(false);
  });

  it("rejects duplicate bed ids", () => {
    const result = clubConfigSchema.safeParse({
      ...validClub,
      beds: [
        { id: "lodge", name: "A", capacity: 10, type: "dormitory" },
        { id: "lodge", name: "B", capacity: 5, type: "shared" },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes('duplicate bed id "lodge"'))).toBe(true);
    }
  });

  it("rejects an age tier with maxAge < minAge", () => {
    const result = clubConfigSchema.safeParse({
      ...validClub,
      ageTiers: [
        { id: "WEIRD", label: "Weird", minAge: 10, maxAge: 5, subscriptionRequiredForBooking: false, familyGroupRequestCreateMemberAllowed: false, nightlyRates },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects duplicate age tier ids", () => {
    const result = clubConfigSchema.safeParse({
      ...validClub,
      ageTiers: [
        { id: "ADULT", label: "A", minAge: 18, maxAge: null, subscriptionRequiredForBooking: true, familyGroupRequestCreateMemberAllowed: false, nightlyRates },
        { id: "ADULT", label: "B", minAge: 20, maxAge: null, subscriptionRequiredForBooking: true, familyGroupRequestCreateMemberAllowed: false, nightlyRates },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes('duplicate age tier id "ADULT"'))).toBe(true);
    }
  });

  it("allows null maxAge for an open-ended top tier", () => {
    const result = clubConfigSchema.safeParse({
      ...validClub,
      ageTiers: [
        { id: "ADULT", label: "Adult", minAge: 18, maxAge: null, subscriptionRequiredForBooking: true, familyGroupRequestCreateMemberAllowed: false, nightlyRates },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects age tier pricing below zero", () => {
    const result = clubConfigSchema.safeParse({
      ...validClub,
      ageTiers: [
        {
          id: "ADULT",
          label: "Adult",
          minAge: 18,
          maxAge: null,
          subscriptionRequiredForBooking: true,
          familyGroupRequestCreateMemberAllowed: false,
          nightlyRates: {
            ...nightlyRates,
            winter: { memberCents: -1, nonMemberCents: 6500 },
          },
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe("featureFlagsSchema", () => {
  it("accepts all booleans", () => {
    expect(
      featureFlagsSchema.parse({
        kiosk: true,
        chores: false,
        financeDashboard: true,
        waitlist: false,
        xeroIntegration: true,
        bedAllocation: true,
        internetBankingPayments: false,
      }),
    ).toBeDefined();
  });

  it("rejects unknown flags (strict mode)", () => {
    const result = featureFlagsSchema.safeParse({
      kiosk: true,
      chores: false,
      financeDashboard: false,
      waitlist: false,
      xeroIntegration: false,
      bedAllocation: false,
      internetBankingPayments: false,
      mystery: true,
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-boolean values", () => {
    const result = featureFlagsSchema.safeParse({
      kiosk: "true",
      chores: false,
      financeDashboard: false,
      waitlist: false,
      xeroIntegration: false,
      bedAllocation: false,
      internetBankingPayments: false,
    });
    expect(result.success).toBe(false);
  });
});
