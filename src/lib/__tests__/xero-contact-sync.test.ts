import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prisma: {
    xeroContactCache: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: mocks.prisma,
}));

import {
  buildXeroContactUpdatePayload,
  hasMemberXeroContactChanges,
  shouldRepairXeroContactNameOrder,
} from "@/lib/xero-contact-sync";

const baseContactSnapshot = {
  firstName: "Alice",
  lastName: "Smith",
  email: "alice@example.com",
  dateOfBirth: new Date("1990-01-15T00:00:00.000Z"),
  phoneCountryCode: "64",
  phoneAreaCode: "27",
  phoneNumber: "4224115",
  streetAddressLine1: "1 Test Street",
  streetAddressLine2: null,
  streetCity: "Wellington",
  streetRegion: "WGN",
  streetPostalCode: "6011",
  streetCountry: "NZ",
  postalAddressLine1: "PO Box 42",
  postalAddressLine2: null,
  postalCity: "Wellington",
  postalRegion: "WGN",
  postalPostalCode: "6140",
  postalCountry: "NZ",
};

describe("xero-contact-sync helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds a Xero contact update payload including date of birth", () => {
    expect(buildXeroContactUpdatePayload(baseContactSnapshot)).toEqual({
      firstName: "Alice",
      lastName: "Smith",
      email: "alice@example.com",
      dateOfBirth: new Date("1990-01-15T00:00:00.000Z"),
      phoneCountryCode: "64",
      phoneAreaCode: "27",
      phoneNumber: "4224115",
      streetAddressLine1: "1 Test Street",
      streetAddressLine2: null,
      streetCity: "Wellington",
      streetRegion: "WGN",
      streetPostalCode: "6011",
      streetCountry: "NZ",
      postalAddressLine1: "PO Box 42",
      postalAddressLine2: null,
      postalCity: "Wellington",
      postalRegion: "WGN",
      postalPostalCode: "6140",
      postalCountry: "NZ",
    });
  });

  it("treats whitespace and null-only differences as unchanged", () => {
    expect(
      hasMemberXeroContactChanges(baseContactSnapshot, {
        ...baseContactSnapshot,
        firstName: " Alice ",
        streetAddressLine2: "",
        postalAddressLine2: "",
      })
    ).toBe(false);
  });

  it("ignores name-only changes because Xero names are reviewed through mismatch checks", () => {
    expect(
      hasMemberXeroContactChanges(baseContactSnapshot, {
        ...baseContactSnapshot,
        firstName: "Alicia",
        lastName: "Jones",
      })
    ).toBe(false);
  });

  it("detects a mapped field change", () => {
    expect(
      hasMemberXeroContactChanges(baseContactSnapshot, {
        ...baseContactSnapshot,
        phoneNumber: "9999999",
      })
    ).toBe(true);
  });

  it("repairs cached Xero names that are clearly last-name first", async () => {
    mocks.prisma.xeroContactCache.findUnique.mockResolvedValue({
      name: "Smith, Alice",
      firstName: null,
      lastName: null,
    });

    await expect(
      shouldRepairXeroContactNameOrder({
        ...baseContactSnapshot,
        xeroContactId: "contact_1",
      })
    ).resolves.toBe(true);

    expect(mocks.prisma.xeroContactCache.findUnique).toHaveBeenCalledWith({
      where: { contactId: "contact_1" },
      select: { name: true, firstName: true, lastName: true },
    });
  });

  it("keeps unrelated reviewed Xero names preserved", async () => {
    mocks.prisma.xeroContactCache.findUnique.mockResolvedValue({
      name: "The Smith Family",
      firstName: null,
      lastName: null,
    });

    await expect(
      shouldRepairXeroContactNameOrder({
        ...baseContactSnapshot,
        xeroContactId: "contact_1",
      })
    ).resolves.toBe(false);
  });
});
