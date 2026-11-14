import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));

const h = vi.hoisted(() => {
  class FakeBookingRequestError extends Error {
    status: number;
    constructor(message: string, status = 400) {
      super(message);
      this.name = "BookingRequestError";
      this.status = status;
    }
  }
  return { FakeBookingRequestError, mockAssertMappable: vi.fn() };
});
const { FakeBookingRequestError } = h;
const mockAssertMappable = h.mockAssertMappable;
vi.mock("@/lib/booking-request", () => ({
  MAPPABLE_CONTACT_ROLES: ["NON_MEMBER", "SCHOOL"],
  BookingRequestError: h.FakeBookingRequestError,
  assertMappableOwnerContact: (...args: unknown[]) => h.mockAssertMappable(...args),
}));

import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import {
  createNonMemberContact,
  NonMemberContactError,
  reuseNonMemberContact,
  suggestNonMemberContacts,
} from "@/lib/non-member-contact";
import { isPlaceholderContactEmail } from "@/lib/placeholder-contact-email";

const mockedPrisma = vi.mocked(prisma);
const mockedAudit = vi.mocked(logAudit);

beforeEach(() => {
  vi.clearAllMocks();
  (mockedPrisma.member.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
});

describe("createNonMemberContact (#1935)", () => {
  it("server-forces role/canLogin/emailVerified/ageTier regardless of payload", async () => {
    (mockedPrisma.member.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "c1",
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@example.com",
    });

    await createNonMemberContact({
      actorMemberId: "officer1",
      firstName: "Jane",
      lastName: "Doe",
      email: "Jane@Example.com",
      noEmail: false,
      // Tampering attempt — these are not part of the schema and must be ignored.
      ...( { role: "ADMIN", canLogin: true, emailVerified: true, ageTier: "CHILD" } as Record<string, unknown>),
    });

    const data = (mockedPrisma.member.create as ReturnType<typeof vi.fn>).mock.calls[0][0].data;
    expect(data.role).toBe("NON_MEMBER");
    expect(data.canLogin).toBe(false);
    expect(data.emailVerified).toBe(false);
    expect(data.ageTier).toBe("ADULT");
    expect(data.active).toBe(true);
    // Email is lower-cased.
    expect(data.email).toBe("jane@example.com");
    expect(mockedAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "admin.non_member_contact.created", actorMemberId: "officer1" }),
    );
  });

  it("blocks creation when a login-capable member shares the exact email", async () => {
    (mockedPrisma.member.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "real-member" });

    await expect(
      createNonMemberContact({
        actorMemberId: "officer1",
        firstName: "Jane",
        lastName: "Doe",
        email: "jane@example.com",
        noEmail: false,
      }),
    ).rejects.toMatchObject({ code: "LOGIN_MEMBER_EXISTS" });

    expect(mockedPrisma.member.create).not.toHaveBeenCalled();
    // The login-capable lookup scopes to canLogin:true only.
    const where = (mockedPrisma.member.findFirst as ReturnType<typeof vi.fn>).mock.calls[0][0].where;
    expect(where.canLogin).toBe(true);
  });

  it("stores a club-internal placeholder for a no-email walk-in and never checks for a login match", async () => {
    (mockedPrisma.member.create as ReturnType<typeof vi.fn>).mockImplementation(
      async (args: { data: { email: string } }) => ({
        id: "c2",
        firstName: "Walk",
        lastName: "In",
        email: args.data.email,
      }),
    );

    const result = await createNonMemberContact({
      actorMemberId: "officer1",
      firstName: "Walk",
      lastName: "In",
      noEmail: true,
    });

    const data = (mockedPrisma.member.create as ReturnType<typeof vi.fn>).mock.calls[0][0].data;
    expect(isPlaceholderContactEmail(data.email)).toBe(true);
    expect(data.emailVerified).toBe(false);
    expect(result.isPlaceholderEmail).toBe(true);
    // The UI never sees the placeholder string as a real address.
    expect(result.email).toBe("");
    // No login-match lookup runs for a placeholder (no real address to match).
    expect(mockedPrisma.member.findFirst).not.toHaveBeenCalled();
    expect(mockedAudit).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ noEmailPlaceholder: true }) }),
    );
  });
});

describe("suggestNonMemberContacts (#1935)", () => {
  it("scopes suggestions to non-login mappable contacts and blanks placeholder emails", async () => {
    (mockedPrisma.member.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "s1",
        firstName: "Rita",
        lastName: "Repeat",
        email: "rita@example.com",
        role: "NON_MEMBER",
        phoneNumber: null,
        _count: { bookings: 3 },
      },
      {
        id: "s2",
        firstName: "Walk",
        lastName: "In",
        email: "walk-in-xyz@no-email.invalid",
        role: "NON_MEMBER",
        phoneNumber: null,
        _count: { bookings: 1 },
      },
    ]);

    const out = await suggestNonMemberContacts({ email: "rita@example.com" });

    const where = (mockedPrisma.member.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0].where;
    const scope = where.AND[0];
    expect(scope).toEqual({
      canLogin: false,
      role: { in: ["NON_MEMBER", "SCHOOL"] },
      archivedAt: null,
      active: true,
    });
    expect(out[0]).toMatchObject({ id: "s1", email: "rita@example.com", isPlaceholderEmail: false });
    expect(out[1]).toMatchObject({ id: "s2", email: "", isPlaceholderEmail: true });
  });

  it("escapes typed email/name fragments while retaining insensitive matching (#4190)", async () => {
    (mockedPrisma.member.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    await suggestNonMemberContacts({ email: " John_%\\Smith@example.invalid ", name: " John_%\\Smith " });
    expect(mockedPrisma.member.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        AND: [
          { canLogin: false, role: { in: ["NON_MEMBER", "SCHOOL"] }, archivedAt: null, active: true },
          { OR: [
            { email: { equals: "John_%\\Smith@example.invalid", mode: "insensitive" } },
            { email: { contains: "John\\_\\%\\\\Smith@example.invalid", mode: "insensitive" } },
            { firstName: { contains: "John\\_\\%\\\\Smith", mode: "insensitive" } },
            { lastName: { contains: "John\\_\\%\\\\Smith", mode: "insensitive" } },
          ] },
        ],
      },
    }));
  });

  it("returns nothing for too-short input", async () => {
    const out = await suggestNonMemberContacts({ email: "a", name: "" });
    expect(out).toEqual([]);
    expect(mockedPrisma.member.findMany).not.toHaveBeenCalled();
  });
});

describe("reuseNonMemberContact (#1935)", () => {
  it("validates the picked contact via assertMappableOwnerContact and returns it", async () => {
    const tx = {
      member: { findUniqueOrThrow: vi.fn().mockResolvedValue({ id: "c9", firstName: "Org", lastName: "Contact", email: "org@example.com" }) },
    };
    (mockedPrisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
      async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
    );
    mockAssertMappable.mockResolvedValue("c9");

    const result = await reuseNonMemberContact("c9");
    expect(mockAssertMappable).toHaveBeenCalledWith(tx, "c9");
    expect(result).toMatchObject({ id: "c9", email: "org@example.com" });
  });

  it("maps an invalid pick (login-capable/archived/etc) to a structured error", async () => {
    const tx = { member: { findUniqueOrThrow: vi.fn() } };
    (mockedPrisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
      async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
    );
    mockAssertMappable.mockRejectedValue(
      new FakeBookingRequestError("That member can sign in", 422),
    );

    await expect(reuseNonMemberContact("bad")).rejects.toBeInstanceOf(NonMemberContactError);
    await expect(reuseNonMemberContact("bad")).rejects.toMatchObject({ status: 422, code: "CONTACT_INVALID" });
  });
});
