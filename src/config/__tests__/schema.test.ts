import { describe, expect, it } from "vitest";
import { clubConfigSchema, featureFlagsSchema } from "@/config/schema";

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
    { id: "INFANT", label: "Infant", minAge: 0, maxAge: 4, subscriptionRequiredForBooking: false },
    { id: "ADULT", label: "Adult", minAge: 18, maxAge: null, subscriptionRequiredForBooking: true },
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
    const result = clubConfigSchema.safeParse({ ...validClub, publicUrl: "tokoroa.org.nz" });
    expect(result.success).toBe(false);
  });

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
        { id: "WEIRD", label: "Weird", minAge: 10, maxAge: 5, subscriptionRequiredForBooking: false },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects duplicate age tier ids", () => {
    const result = clubConfigSchema.safeParse({
      ...validClub,
      ageTiers: [
        { id: "ADULT", label: "A", minAge: 18, maxAge: null, subscriptionRequiredForBooking: true },
        { id: "ADULT", label: "B", minAge: 20, maxAge: null, subscriptionRequiredForBooking: true },
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
        { id: "ADULT", label: "Adult", minAge: 18, maxAge: null, subscriptionRequiredForBooking: true },
      ],
    });
    expect(result.success).toBe(true);
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
    });
    expect(result.success).toBe(false);
  });
});
