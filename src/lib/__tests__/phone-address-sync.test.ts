import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { formatMemberPhone, parsePhoneString } from "@/lib/member-phone";

// ── Mocks ──

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
    booking: { findMany: vi.fn(), aggregate: vi.fn() },
    auditLog: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/age-tier", () => ({
  computeAgeTier: vi.fn().mockResolvedValue("ADULT"),
  getSeasonStartDate: vi.fn().mockReturnValue(new Date("2026-04-01")),
}));
vi.mock("@/lib/xero", () => ({
  isXeroConnected: vi.fn().mockResolvedValue(false),
  updateXeroContact: vi.fn(),
  findOrCreateXeroContact: vi.fn(),
}));
vi.mock("@/lib/utils", () => ({
  getSeasonYear: vi.fn().mockReturnValue(2026),
}));
vi.mock("@/lib/email", () => ({
  sendWelcomeEmail: vi.fn().mockResolvedValue(undefined),
  sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/verification-tokens", () => ({
  createEmailVerificationToken: vi.fn().mockResolvedValue("token123"),
}));
vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: vi.fn().mockReturnValue(null),
  rateLimiters: { register: {} },
}));
vi.mock("bcryptjs", () => ({
  default: { hash: vi.fn().mockResolvedValue("hashedpw") },
}));

import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { isXeroConnected, updateXeroContact, findOrCreateXeroContact } from "@/lib/xero";
import { PUT as updateProfile } from "@/app/api/profile/route";
import { PUT as updateMember } from "@/app/api/admin/members/[id]/route";
import { POST as register } from "@/app/api/auth/register/route";

const adminSession = { user: { id: "admin1", role: "ADMIN" } } as any;
const memberSession = { user: { id: "m1", role: "MEMBER" } } as any;

const baseMember = {
  id: "m1", firstName: "Alice", lastName: "Smith", email: "alice@test.com",
  phoneCountryCode: "64", phoneAreaCode: "27", phoneNumber: "4224115",
  dateOfBirth: new Date("1990-01-15"), role: "MEMBER", ageTier: "ADULT",
  active: true, forcePasswordChange: false, xeroContactId: null,
  joinedDate: null, createdAt: new Date("2025-01-01"), canLogin: true,
  streetAddressLine1: null, streetAddressLine2: null, streetCity: null,
  streetRegion: null, streetPostalCode: null, streetCountry: null,
  postalAddressLine1: null, postalAddressLine2: null, postalCity: null,
  postalRegion: null, postalPostalCode: null, postalCountry: null,
};

// ──────────────────────────────────────────────────────────────
// formatMemberPhone
// ──────────────────────────────────────────────────────────────

describe("formatMemberPhone", () => {
  it("formats all 3 fields correctly", () => {
    expect(formatMemberPhone({
      phoneCountryCode: "64", phoneAreaCode: "27", phoneNumber: "4224115",
    })).toBe("+64 27 4224115");
  });

  it("handles country code with leading +", () => {
    expect(formatMemberPhone({
      phoneCountryCode: "+64", phoneAreaCode: "27", phoneNumber: "4224115",
    })).toBe("+64 27 4224115");
  });

  it("omits country code if null", () => {
    expect(formatMemberPhone({
      phoneCountryCode: null, phoneAreaCode: "027", phoneNumber: "4224115",
    })).toBe("027 4224115");
  });

  it("omits area code if null", () => {
    expect(formatMemberPhone({
      phoneCountryCode: "64", phoneAreaCode: null, phoneNumber: "4224115",
    })).toBe("+64 4224115");
  });

  it("returns just the number if no country or area", () => {
    expect(formatMemberPhone({
      phoneCountryCode: null, phoneAreaCode: null, phoneNumber: "0274224115",
    })).toBe("0274224115");
  });

  it("returns null if phoneNumber is null", () => {
    expect(formatMemberPhone({
      phoneCountryCode: "64", phoneAreaCode: "27", phoneNumber: null,
    })).toBeNull();
  });

  it("returns null if phoneNumber is undefined", () => {
    expect(formatMemberPhone({})).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────
// parsePhoneString
// ──────────────────────────────────────────────────────────────

describe("parsePhoneString", () => {
  it("parses +CC AC NUM format", () => {
    expect(parsePhoneString("+64 27 4224115")).toEqual({
      phoneCountryCode: "64",
      phoneAreaCode: "27",
      phoneNumber: "4224115",
    });
  });

  it("parses +CC NUM (no area code) format", () => {
    expect(parsePhoneString("+64 4224115")).toEqual({
      phoneCountryCode: "64",
      phoneAreaCode: null,
      phoneNumber: "4224115",
    });
  });

  it("parses plain number (no country code)", () => {
    expect(parsePhoneString("021 123 4567")).toEqual({
      phoneCountryCode: null,
      phoneAreaCode: null,
      phoneNumber: "021 123 4567",
    });
  });

  it("parses bare number", () => {
    expect(parsePhoneString("4224115")).toEqual({
      phoneCountryCode: null,
      phoneAreaCode: null,
      phoneNumber: "4224115",
    });
  });

  it("handles empty string", () => {
    expect(parsePhoneString("")).toEqual({
      phoneCountryCode: null,
      phoneAreaCode: null,
      phoneNumber: "",
    });
  });

  it("handles whitespace-only string", () => {
    expect(parsePhoneString("   ")).toEqual({
      phoneCountryCode: null,
      phoneAreaCode: null,
      phoneNumber: "",
    });
  });

  it("joins extra parts into phoneNumber", () => {
    expect(parsePhoneString("+64 27 422 4115")).toEqual({
      phoneCountryCode: "64",
      phoneAreaCode: "27",
      phoneNumber: "422 4115",
    });
  });
});

// ──────────────────────────────────────────────────────────────
// Profile API — structured phone + address validation
// ──────────────────────────────────────────────────────────────

describe("Profile API: structured phone and address fields", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  function makeProfilePut(body: Record<string, unknown>) {
    return new NextRequest("http://localhost/api/profile", {
      method: "PUT",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
  }

  const validProfileBody = {
    firstName: "Alice", lastName: "Smith",
    phoneCountryCode: "64", phoneAreaCode: "27", phoneNumber: "4224115",
  };

  it("accepts structured phone fields", async () => {
    vi.mocked(auth).mockResolvedValue(memberSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(baseMember as any);
    vi.mocked(prisma.member.update).mockResolvedValue({ ...baseMember } as any);

    const res = await updateProfile(makeProfilePut(validProfileBody));
    expect(res.status).toBe(200);
    expect(prisma.member.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        phoneCountryCode: "64",
        phoneAreaCode: "27",
        phoneNumber: "4224115",
      }),
    }));
  });

  it("returns 403 for deactivated members", async () => {
    vi.mocked(auth).mockResolvedValue(memberSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({ active: false } as any);

    const res = await updateProfile(makeProfilePut(validProfileBody));
    expect(res.status).toBe(403);
    expect(prisma.member.update).not.toHaveBeenCalled();
  });

  it("accepts address fields", async () => {
    vi.mocked(auth).mockResolvedValue(memberSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(baseMember as any);
    vi.mocked(prisma.member.update).mockResolvedValue({ ...baseMember } as any);

    const res = await updateProfile(makeProfilePut({
      ...validProfileBody,
      streetAddressLine1: "123 Main St",
      streetCity: "Tokoroa",
      streetRegion: "Waikato",
      streetPostalCode: "3420",
      streetCountry: "NZ",
      postalAddressLine1: "PO Box 42",
      postalCity: "Tokoroa",
    }));
    expect(res.status).toBe(200);
    expect(prisma.member.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        streetAddressLine1: "123 Main St",
        streetCity: "Tokoroa",
        postalAddressLine1: "PO Box 42",
      }),
    }));
  });

  it("rejects phoneCountryCode exceeding max length", async () => {
    vi.mocked(auth).mockResolvedValue(memberSession);
    const res = await updateProfile(makeProfilePut({
      ...validProfileBody,
      phoneCountryCode: "123456", // max 5
    }));
    expect(res.status).toBe(422);
  });

  it("rejects phoneNumber exceeding max length", async () => {
    vi.mocked(auth).mockResolvedValue(memberSession);
    const res = await updateProfile(makeProfilePut({
      ...validProfileBody,
      phoneNumber: "1234567890123456", // max 15
    }));
    expect(res.status).toBe(422);
  });

  it("syncs to Xero when member has xeroContactId and Xero is connected", async () => {
    vi.mocked(auth).mockResolvedValue(memberSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(baseMember as any);
    vi.mocked(prisma.member.update).mockResolvedValue({
      ...baseMember, xeroContactId: "xc1",
    } as any);
    vi.mocked(isXeroConnected).mockResolvedValue(true);

    await updateProfile(makeProfilePut(validProfileBody));

    expect(updateXeroContact).toHaveBeenCalledWith("xc1", expect.objectContaining({
      firstName: "Alice",
      lastName: "Smith",
      phoneCountryCode: "64",
    }));
  });

  it("does not sync to Xero when not connected", async () => {
    vi.mocked(auth).mockResolvedValue(memberSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(baseMember as any);
    vi.mocked(prisma.member.update).mockResolvedValue({
      ...baseMember, xeroContactId: "xc1",
    } as any);
    vi.mocked(isXeroConnected).mockResolvedValue(false);

    await updateProfile(makeProfilePut(validProfileBody));

    expect(updateXeroContact).not.toHaveBeenCalled();
  });

  it("nullifies empty phone fields", async () => {
    vi.mocked(auth).mockResolvedValue(memberSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(baseMember as any);
    vi.mocked(prisma.member.update).mockResolvedValue({ ...baseMember } as any);

    await updateProfile(makeProfilePut({
      firstName: "Alice", lastName: "Smith",
      phoneCountryCode: "", phoneAreaCode: "", phoneNumber: "",
    }));

    expect(prisma.member.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        phoneCountryCode: null,
        phoneAreaCode: null,
        phoneNumber: null,
      }),
    }));
  });
});

// ──────────────────────────────────────────────────────────────
// Admin Member Edit API — structured phone + address
// ──────────────────────────────────────────────────────────────

describe("Admin Member Edit: structured phone and address", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  function makePutRequest(id: string, body: Record<string, unknown>) {
    return new NextRequest(`http://localhost/api/admin/members/${id}`, {
      method: "PUT",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
  }

  it("updates structured phone fields via admin", async () => {
    vi.mocked(auth).mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(baseMember as any);
    vi.mocked(prisma.member.update).mockResolvedValue({
      ...baseMember, phoneCountryCode: "61", phoneAreaCode: "2", phoneNumber: "1234567", xeroContactId: null,
    } as any);

    const res = await updateMember(
      makePutRequest("m1", { phoneCountryCode: "61", phoneAreaCode: "2", phoneNumber: "1234567" }),
      { params: Promise.resolve({ id: "m1" }) },
    );
    expect(res.status).toBe(200);
    expect(prisma.member.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        phoneCountryCode: "61",
        phoneAreaCode: "2",
        phoneNumber: "1234567",
      }),
    }));
  });

  it("updates address fields via admin", async () => {
    vi.mocked(auth).mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(baseMember as any);
    vi.mocked(prisma.member.update).mockResolvedValue({
      ...baseMember,
      streetAddressLine1: "42 Lodge Rd",
      streetCity: "Whakapapa",
      xeroContactId: null,
    } as any);

    const res = await updateMember(
      makePutRequest("m1", { streetAddressLine1: "42 Lodge Rd", streetCity: "Whakapapa" }),
      { params: Promise.resolve({ id: "m1" }) },
    );
    expect(res.status).toBe(200);
    expect(prisma.member.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        streetAddressLine1: "42 Lodge Rd",
        streetCity: "Whakapapa",
      }),
    }));
  });

  it("passes structured phone + address to Xero on admin edit", async () => {
    vi.mocked(auth).mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(baseMember as any);
    vi.mocked(prisma.member.update).mockResolvedValue({
      ...baseMember,
      xeroContactId: "xc1",
      streetAddressLine1: "42 Lodge Rd",
    } as any);
    vi.mocked(isXeroConnected).mockResolvedValue(true);

    await updateMember(
      makePutRequest("m1", { streetAddressLine1: "42 Lodge Rd" }),
      { params: Promise.resolve({ id: "m1" }) },
    );

    expect(updateXeroContact).toHaveBeenCalledWith(
      "xc1",
      expect.objectContaining({
        streetAddressLine1: "42 Lodge Rd",
      }),
    );
  });

  it("returns 409 when admin member update hits a unique email constraint", async () => {
    vi.mocked(auth).mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(baseMember as any);
    vi.mocked(prisma.member.update).mockRejectedValueOnce({ code: "P2002" });

    const res = await updateMember(
      makePutRequest("m1", { email: "new@test.com" }),
      { params: Promise.resolve({ id: "m1" }) },
    );

    expect(res.status).toBe(409);
  });
});

// ──────────────────────────────────────────────────────────────
// Registration — structured phone + Xero auto-link
// ──────────────────────────────────────────────────────────────

describe("Registration: structured phone + Xero auto-link", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  function makeRegisterRequest(body: Record<string, unknown>) {
    return new NextRequest("http://localhost/api/auth/register", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
  }

  const validRegistration = {
    email: "new@test.com",
    password: "securePassword123",
    firstName: "Jane",
    lastName: "Doe",
    phoneCountryCode: "64",
    phoneAreaCode: "21",
    phoneNumber: "5551234",
  };

  it("stores structured phone fields on registration", async () => {
    vi.mocked(prisma.member.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.member.create).mockResolvedValue({
      id: "new1", email: "new@test.com", firstName: "Jane", lastName: "Doe",
      phoneCountryCode: "64", phoneAreaCode: "21", phoneNumber: "5551234",
    } as any);

    const res = await register(makeRegisterRequest(validRegistration));
    expect(res.status).toBe(201);
    expect(prisma.member.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        phoneCountryCode: "64",
        phoneAreaCode: "21",
        phoneNumber: "5551234",
      }),
    }));
  });

  it("auto-creates Xero contact when Xero is connected", async () => {
    vi.mocked(prisma.member.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.member.create).mockResolvedValue({ id: "new1", email: "new@test.com", firstName: "Jane" } as any);
    vi.mocked(isXeroConnected).mockResolvedValue(true);
    vi.mocked(findOrCreateXeroContact).mockResolvedValue("xc-new" as any);

    await register(makeRegisterRequest(validRegistration));

    // isXeroConnected is called fire-and-forget, so wait for promises
    await new Promise((r) => setTimeout(r, 50));

    expect(findOrCreateXeroContact).toHaveBeenCalledWith("new1");
  });

  it("does not create Xero contact when Xero is disconnected", async () => {
    vi.mocked(prisma.member.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.member.create).mockResolvedValue({ id: "new1", email: "new@test.com", firstName: "Jane" } as any);
    vi.mocked(isXeroConnected).mockResolvedValue(false);

    await register(makeRegisterRequest(validRegistration));
    await new Promise((r) => setTimeout(r, 50));

    expect(findOrCreateXeroContact).not.toHaveBeenCalled();
  });

  it("handles Xero auto-link failure gracefully", async () => {
    vi.mocked(prisma.member.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.member.create).mockResolvedValue({ id: "new1", email: "new@test.com", firstName: "Jane" } as any);
    vi.mocked(isXeroConnected).mockResolvedValue(true);
    vi.mocked(findOrCreateXeroContact).mockRejectedValue(new Error("Xero unavailable"));

    const res = await register(makeRegisterRequest(validRegistration));
    // Registration should still succeed even if Xero fails
    expect(res.status).toBe(201);

    await new Promise((r) => setTimeout(r, 50));
    // Should have attempted but failed gracefully
    expect(findOrCreateXeroContact).toHaveBeenCalledWith("new1");
  });

  it("registers without phone fields (optional)", async () => {
    vi.mocked(prisma.member.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.member.create).mockResolvedValue({ id: "new2", email: "bob@test.com", firstName: "Bob" } as any);

    const res = await register(makeRegisterRequest({
      email: "bob@test.com", password: "securePassword123",
      firstName: "Bob", lastName: "Builder",
    }));
    expect(res.status).toBe(201);
  });

  it("returns 409 when registration hits a unique email constraint after the pre-check", async () => {
    vi.mocked(prisma.member.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.member.create).mockRejectedValueOnce({ code: "P2002" });

    const res = await register(makeRegisterRequest(validRegistration));
    expect(res.status).toBe(409);
  });
});
