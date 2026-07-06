import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BookingRequestStatus,
  BookingRequestType,
  BookingStatus,
  PaymentSource,
  PaymentStatus,
} from "@prisma/client";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    bookingRequest: {
      create: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
    },
    member: { create: vi.fn(), findUnique: vi.fn() },
    booking: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    bookingGuest: {
      findMany: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
    payment: { create: vi.fn() },
    hutLeaderAssignment: { create: vi.fn() },
    season: { findMany: vi.fn() },
    groupDiscountSetting: { findUnique: vi.fn() },
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
  },
}));

vi.mock("@/lib/email", () => ({
  sendBookingRequestVerificationEmail: vi.fn().mockResolvedValue(undefined),
  sendHutLeaderAssignmentEmail: vi.fn().mockResolvedValue(undefined),
  sendAdminSchoolManualInvoiceEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));

vi.mock("@/lib/capacity", () => ({
  checkCapacityForGuestRanges: vi.fn(),
}));

vi.mock("@/lib/lodge-capacity", () => ({
  getLodgeCapacity: vi.fn().mockResolvedValue(40),
}));

vi.mock("@/lib/lodge-pin-session", () => ({
  generateHutLeaderPin: vi.fn(() => "246810"),
  hashHutLeaderPin: vi.fn().mockResolvedValue("hashed-pin"),
}));

vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroBookingInvoiceOperation: vi
    .fn()
    .mockResolvedValue({ queueOperationId: "op-1" }),
  kickQueuedXeroOutboxOperationsIfConnected: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/admin-modules", () => ({
  isEffectiveModuleEnabled: vi.fn().mockResolvedValue(true),
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("bcryptjs", () => ({
  hash: vi.fn().mockResolvedValue("hashed-placeholder"),
}));

// Keep the real BookingMemberNightConflictError; only the assertion is a spy.
vi.mock("@/lib/booking-member-night-conflicts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/booking-member-night-conflicts")>();
  return {
    ...actual,
    assertNoBookingMemberNightConflicts: vi.fn().mockResolvedValue(undefined),
  };
});

import { prisma } from "@/lib/prisma";
import {
  sendBookingRequestVerificationEmail,
  sendHutLeaderAssignmentEmail,
  sendAdminSchoolManualInvoiceEmail,
} from "@/lib/email";
import { checkCapacityForGuestRanges } from "@/lib/capacity";
import { logAudit } from "@/lib/audit";
import { isEffectiveModuleEnabled } from "@/lib/admin-modules";
import {
  enqueueXeroBookingInvoiceOperation,
} from "@/lib/xero-operation-outbox";
import { requiresAdultSupervisionReview } from "@/lib/booking-review";
import { BookingRequestError } from "@/lib/booking-request";
import {
  assertNoBookingMemberNightConflicts,
  BookingMemberNightConflictError,
} from "@/lib/booking-member-night-conflicts";
import {
  approveSchoolBookingRequest,
  createSchoolBookingRequest,
  generateSchoolGuests,
} from "@/lib/school-booking-request";

const mockedFindUnique = vi.mocked(prisma.bookingRequest.findUnique);
const mockedCreate = vi.mocked(prisma.bookingRequest.create);
const mockedUpdateMany = vi.mocked(prisma.bookingRequest.updateMany);
const mockedTransaction = vi.mocked(prisma.$transaction);
const mockedCheckCapacity = vi.mocked(checkCapacityForGuestRanges);
const mockedSeasonFindMany = vi.mocked(prisma.season.findMany);
const mockedGroupDiscount = vi.mocked(prisma.groupDiscountSetting.findUnique);
const mockedModuleEnabled = vi.mocked(isEffectiveModuleEnabled);
const mockedEnqueueInvoice = vi.mocked(enqueueXeroBookingInvoiceOperation);
const mockedSendVerification = vi.mocked(sendBookingRequestVerificationEmail);
const mockedSendPin = vi.mocked(sendHutLeaderAssignmentEmail);
const mockedSendManualInvoice = vi.mocked(sendAdminSchoolManualInvoiceEmail);
const mockedAssertNoConflicts = vi.mocked(assertNoBookingMemberNightConflicts);
const mockedLogAudit = vi.mocked(logAudit);

function memberNightConflictError() {
  return new BookingMemberNightConflictError([
    {
      memberId: "teacher-member-42",
      memberName: "Linked Teacher",
      bookingId: "existing-booking",
      bookingStatus: BookingStatus.CONFIRMED,
      bookingOwnerName: "Other Owner",
      bookingCheckIn: "2026-08-01",
      bookingCheckOut: "2026-08-03",
      guestId: "existing-guest",
      conflictingNights: ["2026-08-01"],
      isOwnBooking: false,
      canOpenBooking: true,
      canSelfRemove: false,
    },
  ]);
}

const CHECK_IN = new Date("2026-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-03T00:00:00.000Z"); // 2 nights

function schoolRequest(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "req-school",
    type: BookingRequestType.SCHOOL,
    status: BookingRequestStatus.VERIFIED,
    schoolName: "New Plymouth Primary School",
    teachers: [{ firstName: "Tana", lastName: "Teacher", email: "tana@school.test" }],
    contactFirstName: "Carol",
    contactLastName: "Contact",
    contactEmail: "office@school.test",
    contactPhone: null,
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    guests: [
      { firstName: "Tana", lastName: "Teacher", ageTier: "ADULT" },
      { firstName: "School Child", lastName: "1", ageTier: "CHILD" },
      { firstName: "School Child", lastName: "2", ageTier: "CHILD" },
    ],
    message: null,
    indicativePriceCents: 20000,
    priceCents: null,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    ...overrides,
  };
}

function seasonWithRates() {
  return [
    {
      id: "season-1",
      startDate: new Date("2026-07-01T00:00:00.000Z"),
      endDate: new Date("2026-09-01T00:00:00.000Z"),
      type: "WINTER",
      rates: [
        { ageTier: "ADULT", isMember: false, pricePerNightCents: 5000 },
        { ageTier: "CHILD", isMember: false, pricePerNightCents: 2500 },
      ],
    },
  ];
}

describe("generateSchoolGuests", () => {
  it("builds named ADULT teachers and numbered School Child rows by tier", () => {
    const guests = generateSchoolGuests({
      teachers: [{ firstName: "Tana", lastName: "Teacher" }],
      childCounts: { CHILD: 2, YOUTH: 1 },
    });

    expect(guests).toEqual([
      { firstName: "Tana", lastName: "Teacher", ageTier: "ADULT" },
      { firstName: "School Child", lastName: "1", ageTier: "CHILD" },
      { firstName: "School Child", lastName: "2", ageTier: "CHILD" },
      { firstName: "School Child", lastName: "3", ageTier: "YOUTH" },
    ]);
  });
});

describe("adult supervision rule with a teacher (issue #709 requirement 7)", () => {
  it("accepts a school booking when a teacher (ADULT) is present", () => {
    const guests = generateSchoolGuests({
      teachers: [{ firstName: "Tana", lastName: "Teacher" }],
      childCounts: { CHILD: 5 },
    });
    expect(requiresAdultSupervisionReview(guests)).toBe(false);
  });

  it("still flags a children-only group with no adult", () => {
    const guests = generateSchoolGuests({
      teachers: [],
      childCounts: { CHILD: 5 },
    });
    expect(requiresAdultSupervisionReview(guests)).toBe(true);
  });
});

describe("createSchoolBookingRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedSeasonFindMany.mockResolvedValue([] as never); // no indicative price
    mockedCreate.mockResolvedValue(schoolRequest({ id: "req-new" }) as never);
  });

  it("requires a school name", async () => {
    await expect(
      createSchoolBookingRequest({
        schoolName: "  ",
        contactFirstName: "Carol",
        contactLastName: "Contact",
        contactEmail: "office@school.test",
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        teachers: [{ firstName: "Tana", lastName: "Teacher" }],
        childCounts: { CHILD: 2 },
        cateringPreference: "NON_CATERED" as const,
      })
    ).rejects.toThrow(BookingRequestError);
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("requires at least one teacher", async () => {
    await expect(
      createSchoolBookingRequest({
        schoolName: "New Plymouth Primary School",
        contactFirstName: "Carol",
        contactLastName: "Contact",
        contactEmail: "office@school.test",
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        teachers: [],
        childCounts: { CHILD: 2 },
        cateringPreference: "NON_CATERED" as const,
      })
    ).rejects.toThrow(BookingRequestError);
  });

  it("creates a SCHOOL request with generated guests and emails verification", async () => {
    await createSchoolBookingRequest({
      schoolName: "New Plymouth Primary School",
      contactFirstName: "Carol",
      contactLastName: "Contact",
      contactEmail: "Office@School.test",
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      teachers: [{ firstName: "Tana", lastName: "Teacher", email: "Tana@School.test" }],
      childCounts: { CHILD: 2, YOUTH: 1 },
      cateringPreference: "NON_CATERED" as const,
    });

    expect(mockedCreate).toHaveBeenCalledTimes(1);
    const data = mockedCreate.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.type).toBe(BookingRequestType.SCHOOL);
    expect(data.schoolName).toBe("New Plymouth Primary School");
    expect(data.contactEmail).toBe("office@school.test");
    const guests = data.guests as Array<{ ageTier: string }>;
    expect(guests).toHaveLength(4); // 1 teacher + 3 children
    expect(guests.filter((g) => g.ageTier === "ADULT")).toHaveLength(1);
    const teachers = data.teachers as Array<{ email: string | null }>;
    expect(teachers[0].email).toBe("tana@school.test");

    expect(mockedSendVerification).toHaveBeenCalledTimes(1);
  });

  it("rejects a group larger than lodge capacity", async () => {
    await expect(
      createSchoolBookingRequest({
        schoolName: "Big School",
        contactFirstName: "Carol",
        contactLastName: "Contact",
        contactEmail: "office@school.test",
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        teachers: [{ firstName: "Tana", lastName: "Teacher" }],
        childCounts: { CHILD: 200 },
        cateringPreference: "NON_CATERED" as const,
      })
    ).rejects.toThrow(/lodge capacity/);
  });
});

describe("approveSchoolBookingRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedTransaction.mockImplementation(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma)
    );
    mockedUpdateMany.mockResolvedValue({ count: 1 } as never);
    mockedCheckCapacity.mockResolvedValue({
      available: true,
      minAvailable: 30,
      nightDetails: [],
    } as never);
    mockedModuleEnabled.mockResolvedValue(true);
    mockedSeasonFindMany.mockResolvedValue(seasonWithRates() as never);
    mockedGroupDiscount.mockResolvedValue(null as never);

    let memberCalls = 0;
    vi.mocked(prisma.member.create).mockImplementation((async () => {
      memberCalls += 1;
      return memberCalls === 1
        ? ({ id: "school-member" } as never)
        : ({
            id: `teacher-member-${memberCalls}`,
            firstName: "Tana",
            email: "tana@school.test",
          } as never);
    }) as never);
    vi.mocked(prisma.booking.create).mockResolvedValue({ id: "booking-1" } as never);
    vi.mocked(prisma.payment.create).mockResolvedValue({} as never);
    vi.mocked(prisma.hutLeaderAssignment.create).mockResolvedValue({} as never);
    vi.mocked(prisma.bookingRequest.update).mockResolvedValue({} as never);
    // Default to no member-night conflict; individual tests override to reject.
    mockedAssertNoConflicts.mockResolvedValue(undefined);
  });

  it("rejects a non-school request", async () => {
    mockedFindUnique.mockResolvedValue(
      schoolRequest({ type: BookingRequestType.GENERAL }) as never
    );
    await expect(
      approveSchoolBookingRequest({ requestId: "req-school", adminMemberId: "admin-1" })
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a request that is not verified or priced", async () => {
    mockedFindUnique.mockResolvedValue(
      schoolRequest({ status: BookingRequestStatus.NEW }) as never
    );
    await expect(
      approveSchoolBookingRequest({ requestId: "req-school", adminMemberId: "admin-1" })
    ).rejects.toMatchObject({ status: 409 });
  });

  it("returns capacityExceeded without converting when no beds remain", async () => {
    mockedFindUnique.mockResolvedValue(schoolRequest() as never);
    mockedCheckCapacity.mockResolvedValue({
      available: false,
      minAvailable: -2,
      nightDetails: [
        { date: new Date("2026-08-01T00:00:00.000Z"), availableBeds: -2 },
        { date: new Date("2026-08-02T00:00:00.000Z"), availableBeds: 1 },
      ],
    } as never);

    const result = await approveSchoolBookingRequest({
      requestId: "req-school",
      adminMemberId: "admin-1",
    });

    expect(result).toEqual({ type: "capacityExceeded", fullNights: ["2026-08-01"] });
    expect(prisma.member.create).not.toHaveBeenCalled();
  });

  it("confirms the booking, prices from group rates, raises the Xero invoice, and assigns the teacher", async () => {
    mockedFindUnique.mockResolvedValue(schoolRequest() as never);

    const result = await approveSchoolBookingRequest({
      requestId: "req-school",
      adminMemberId: "admin-1",
    });

    expect(result).toMatchObject({
      type: "approved",
      bookingId: "booking-1",
      schoolMemberId: "school-member",
      invoiceMode: "xero",
      teacherCount: 1,
    });
    // 1 adult @ 5000 x2 nights + 2 children @ 2500 x2 nights = 20000.
    expect(result).toMatchObject({ priceCents: 20000 });

    // School is the non-login Xero contact: name = school, email = contact.
    const schoolMemberArgs = vi.mocked(prisma.member.create).mock.calls[0][0]
      .data as Record<string, unknown>;
    expect(schoolMemberArgs.firstName).toBe("New Plymouth Primary School");
    expect(schoolMemberArgs.email).toBe("office@school.test");
    expect(schoolMemberArgs.canLogin).toBe(false);
    // Non-member category so the school contact is not counted as a paying member.
    expect(schoolMemberArgs.role).toBe("SCHOOL");

    // Booking is CONFIRMED (capacity held) and pays on account via Xero invoice.
    const bookingArgs = vi.mocked(prisma.booking.create).mock.calls[0][0].data as Record<
      string,
      unknown
    >;
    expect(bookingArgs.status).toBe(BookingStatus.CONFIRMED);
    expect(bookingArgs.finalPriceCents).toBe(20000);

    const paymentArgs = vi.mocked(prisma.payment.create).mock.calls[0][0].data as Record<
      string,
      unknown
    >;
    expect(paymentArgs.source).toBe(PaymentSource.INTERNET_BANKING);
    expect(paymentArgs.status).toBe(PaymentStatus.PENDING);

    // Teacher becomes a non-login member with a hut leader assignment + PIN email.
    const teacherMemberArgs = vi.mocked(prisma.member.create).mock.calls[1][0].data as Record<
      string,
      unknown
    >;
    expect(teacherMemberArgs.canLogin).toBe(false);
    // Teachers carry the same non-member SCHOOL role as the school contact.
    expect(teacherMemberArgs.role).toBe("SCHOOL");
    expect(vi.mocked(prisma.hutLeaderAssignment.create)).toHaveBeenCalledTimes(1);
    expect(mockedSendPin).toHaveBeenCalledWith(
      expect.objectContaining({ email: "tana@school.test", pin: "246810" })
    );

    expect(mockedEnqueueInvoice).toHaveBeenCalledWith(
      "booking-1",
      expect.objectContaining({ createdByMemberId: "admin-1" })
    );
    expect(mockedSendManualInvoice).not.toHaveBeenCalled();
  });

  it("maps the school owner to an existing non-login SCHOOL contact instead of creating one (#1255)", async () => {
    mockedFindUnique.mockResolvedValue(schoolRequest() as never);
    // The chosen contact is a valid non-login SCHOOL organisation contact.
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      id: "existing-school",
      canLogin: false,
      role: "SCHOOL",
      archivedAt: null,
      active: true,
    } as never);
    // On the map path member.create is only called for the teacher(s).
    vi.mocked(prisma.member.create).mockResolvedValue({
      id: "teacher-member",
      firstName: "Tana",
      email: "tana@school.test",
    } as never);

    const result = await approveSchoolBookingRequest({
      requestId: "req-school",
      adminMemberId: "admin-1",
      ownerContactMemberId: "existing-school",
    });

    expect(result).toMatchObject({
      type: "approved",
      schoolMemberId: "existing-school",
      invoiceMode: "xero",
      teacherCount: 1,
    });
    // The booking is owned by the mapped contact, reusing its Xero contact.
    const bookingArgs = vi.mocked(prisma.booking.create).mock.calls[0][0]
      .data as Record<string, unknown>;
    expect(bookingArgs.memberId).toBe("existing-school");
    // member.create ran ONLY for the teacher, never for the school owner.
    expect(prisma.member.create).toHaveBeenCalledTimes(1);
    const onlyMemberArgs = vi.mocked(prisma.member.create).mock.calls[0][0]
      .data as Record<string, unknown>;
    expect(onlyMemberArgs.firstName).toBe("Tana");
  });

  it("rejects mapping a school request onto a login-capable member (#1255 guard)", async () => {
    mockedFindUnique.mockResolvedValue(schoolRequest() as never);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      id: "real-member",
      canLogin: true,
      role: "USER",
      archivedAt: null,
    } as never);

    await expect(
      approveSchoolBookingRequest({
        requestId: "req-school",
        adminMemberId: "admin-1",
        ownerContactMemberId: "real-member",
      })
    ).rejects.toMatchObject({ status: 422 });
    expect(prisma.booking.create).not.toHaveBeenCalled();
  });

  it("is idempotent on a re-armed convertedBookingId: a replayed accept returns the existing booking and raises no second Xero invoice or PIN (#1232)", async () => {
    // First accept: a clean VERIFIED request confirms once and queues one invoice.
    mockedFindUnique.mockResolvedValue(schoolRequest() as never);

    const first = await approveSchoolBookingRequest({
      requestId: "req-school",
      adminMemberId: "admin-1",
    });
    expect(first).toMatchObject({
      type: "approved",
      bookingId: "booking-1",
      schoolMemberId: "school-member",
      invoiceMode: "xero",
    });
    expect(prisma.booking.create).toHaveBeenCalledTimes(1);
    expect(prisma.payment.create).toHaveBeenCalledTimes(1);
    expect(mockedEnqueueInvoice).toHaveBeenCalledTimes(1);
    expect(mockedSendPin).toHaveBeenCalledTimes(1);

    // Simulate the caller's line-~729 re-arm: PRICED (with priceCents, as the
    // real caller writes) WITHOUT clearing convertedBookingId/convertedMemberId.
    // Do NOT reset mock history — the money proof is that the counts stay at one.
    mockedFindUnique.mockResolvedValue(
      schoolRequest({
        status: BookingRequestStatus.PRICED,
        priceCents: 20000,
        convertedBookingId: "booking-1",
        convertedMemberId: "school-member",
      }) as never
    );

    const replay = await approveSchoolBookingRequest({
      requestId: "req-school",
      adminMemberId: "admin-1",
    });

    // Returns the SAME booking; no second booking/payment; and — money-critical —
    // no second Xero invoice and no re-sent teacher PIN.
    expect(replay).toMatchObject({
      type: "approved",
      bookingId: "booking-1",
      schoolMemberId: "school-member",
    });
    expect(prisma.booking.create).toHaveBeenCalledTimes(1);
    expect(prisma.payment.create).toHaveBeenCalledTimes(1);
    expect(mockedEnqueueInvoice).toHaveBeenCalledTimes(1);
    expect(mockedSendPin).toHaveBeenCalledTimes(1);
    // The claim updateMany ran for the first accept only, never the replay.
    expect(mockedUpdateMany).toHaveBeenCalledTimes(1);
    // Under the lock the replay re-asserts the terminal status to CONVERTED.
    const lastUpdate = vi.mocked(prisma.bookingRequest.update).mock.calls.at(-1)?.[0]
      .data as Record<string, unknown>;
    expect(lastUpdate.status).toBe(BookingRequestStatus.CONVERTED);
  });

  it("falls back to a manual-invoice admin alert when the Xero module is off", async () => {
    mockedFindUnique.mockResolvedValue(schoolRequest() as never);
    mockedModuleEnabled.mockResolvedValue(false);

    const result = await approveSchoolBookingRequest({
      requestId: "req-school",
      adminMemberId: "admin-1",
    });

    expect(result).toMatchObject({ type: "approved", invoiceMode: "manual" });
    expect(mockedEnqueueInvoice).not.toHaveBeenCalled();
    expect(mockedSendManualInvoice).toHaveBeenCalledWith(
      expect.objectContaining({
        schoolName: "New Plymouth Primary School",
        contactEmail: "office@school.test",
        totalCents: 20000,
      })
    );
  });

  it("names the mapped contact (not the raw request) on the manual-invoice notification (#1255 decision 3)", async () => {
    mockedFindUnique.mockResolvedValue(schoolRequest() as never);
    mockedModuleEnabled.mockResolvedValue(false); // Xero off → manual invoice
    // Map to an existing SCHOOL contact whose name/email differ from the request.
    // A single findUnique mock serves both the guard and the Decision-3 resolve.
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      id: "mapped-school",
      canLogin: false,
      role: "SCHOOL",
      archivedAt: null,
      active: true,
      firstName: "Mapped College",
      lastName: "",
      email: "accounts@mappedcollege.test",
    } as never);

    const result = await approveSchoolBookingRequest({
      requestId: "req-school",
      adminMemberId: "admin-1",
      ownerContactMemberId: "mapped-school",
    });

    expect(result).toMatchObject({
      type: "approved",
      invoiceMode: "manual",
      schoolMemberId: "mapped-school",
    });
    // The notification names the party actually being invoiced (the mapped
    // contact), not request.schoolName / request.contactEmail.
    expect(mockedSendManualInvoice).toHaveBeenCalledWith(
      expect.objectContaining({
        schoolName: "Mapped College",
        contactEmail: "accounts@mappedcollege.test",
      })
    );
  });

  it("substitutes a fresh SCHOOL contact when the held owner is invalid at conversion, and the accept still succeeds (#1255 decision 1)", async () => {
    mockedFindUnique.mockResolvedValue(
      schoolRequest({ heldBookingId: "held-1" }) as never
    );
    vi.mocked(prisma.booking.findUnique).mockResolvedValue({
      id: "held-1",
      memberId: "held-invalid-school",
      status: BookingStatus.AWAITING_REVIEW,
    } as never);
    // The held school owner became login-capable → re-validation rejects it.
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      id: "held-invalid-school",
      canLogin: true,
      role: "USER",
      archivedAt: null,
      active: true,
    } as never);
    // Guest counts differ → reassign uses delete+recreate (both mocked).
    vi.mocked(prisma.bookingGuest.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.bookingGuest.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.bookingGuest.createMany).mockResolvedValue({ count: 3 } as never);
    vi.mocked(prisma.booking.update).mockResolvedValue({ id: "held-1" } as never);

    const result = await approveSchoolBookingRequest({
      requestId: "req-school",
      adminMemberId: "admin-1",
    });

    // Accept succeeds; the confirmed booking is re-owned by the fresh substitute
    // (first member.create → "school-member" per the beforeEach impl).
    expect(result).toMatchObject({
      type: "approved",
      schoolMemberId: "school-member",
    });
    const substituteArgs = vi.mocked(prisma.member.create).mock.calls[0][0]
      .data as Record<string, unknown>;
    expect(substituteArgs.role).toBe("SCHOOL");
    expect(substituteArgs.canLogin).toBe(false);
    // The held booking is repointed at the substitute owner.
    const updateArgs = vi.mocked(prisma.booking.update).mock.calls[0][0]
      .data as Record<string, unknown>;
    expect(updateArgs.memberId).toBe("school-member");
    expect(mockedLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking_request.owner_substituted",
        metadata: expect.objectContaining({
          invalidMemberId: "held-invalid-school",
          substituteMemberId: "school-member",
        }),
      })
    );
  });

  it("returns capacityExceeded on the held-reuse path when a guest-count override overbooks a night, and swaps/confirms nothing (issue #1352)", async () => {
    mockedFindUnique.mockResolvedValue(
      schoolRequest({ heldBookingId: "held-1" }) as never
    );
    vi.mocked(prisma.booking.findUnique).mockResolvedValue({
      id: "held-1",
      memberId: "held-school",
      status: BookingStatus.AWAITING_REVIEW,
    } as never);
    // Valid non-login SCHOOL owner → re-validation passes; capacity is the guard.
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      id: "held-school",
      canLogin: false,
      role: "SCHOOL",
      archivedAt: null,
      active: true,
    } as never);
    // The enlarged list (admin bumps CHILD to 4) overbooks the first night even
    // after excluding the hold's own beds.
    mockedCheckCapacity.mockResolvedValue({
      available: false,
      minAvailable: -1,
      nightDetails: [
        { date: new Date("2026-08-01T00:00:00.000Z"), availableBeds: -1 },
        { date: new Date("2026-08-02T00:00:00.000Z"), availableBeds: 2 },
      ],
    } as never);

    const result = await approveSchoolBookingRequest({
      requestId: "req-school",
      adminMemberId: "admin-1",
      guestOverride: { childCounts: { CHILD: 4 } },
    });

    expect(result).toEqual({ type: "capacityExceeded", fullNights: ["2026-08-01"] });
    // The re-check excludes the held booking's own held beds (excludeBookingId).
    expect(mockedCheckCapacity).toHaveBeenCalledWith(
      CHECK_IN,
      CHECK_OUT,
      expect.any(Array),
      "held-1",
      expect.anything()
    );
    // The enlarged (5-guest) list, not the 3-guest hold, drove the check.
    const ranges = mockedCheckCapacity.mock.calls[0][2] as unknown[];
    expect(ranges).toHaveLength(5);
    // No guest swap persisted and the hold was NOT flipped to CONFIRMED.
    expect(prisma.bookingGuest.findMany).not.toHaveBeenCalled();
    expect(prisma.bookingGuest.deleteMany).not.toHaveBeenCalled();
    expect(prisma.bookingGuest.createMany).not.toHaveBeenCalled();
    expect(prisma.booking.update).not.toHaveBeenCalled();
    expect(mockedEnqueueInvoice).not.toHaveBeenCalled();
  });

  it("re-checks capacity on the held-reuse path (excluding the hold) and confirms when the enlarged list still fits (issue #1352)", async () => {
    mockedFindUnique.mockResolvedValue(
      schoolRequest({ heldBookingId: "held-1" }) as never
    );
    vi.mocked(prisma.booking.findUnique).mockResolvedValue({
      id: "held-1",
      memberId: "held-school",
      status: BookingStatus.AWAITING_REVIEW,
    } as never);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      id: "held-school",
      canLogin: false,
      role: "SCHOOL",
      archivedAt: null,
      active: true,
    } as never);
    // Guest counts differ from the hold → reassign deletes+recreates (mocked).
    vi.mocked(prisma.bookingGuest.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.bookingGuest.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.bookingGuest.createMany).mockResolvedValue({ count: 5 } as never);
    vi.mocked(prisma.booking.update).mockResolvedValue({ id: "held-1" } as never);
    // beforeEach leaves capacity available → the enlarged list fits, guard passes.

    const result = await approveSchoolBookingRequest({
      requestId: "req-school",
      adminMemberId: "admin-1",
      guestOverride: { childCounts: { CHILD: 4 } },
    });

    expect(result).toMatchObject({
      type: "approved",
      schoolMemberId: "held-school",
    });
    // The re-check ran against the NEW 5-guest list and excluded the hold itself.
    expect(mockedCheckCapacity).toHaveBeenCalledWith(
      CHECK_IN,
      CHECK_OUT,
      expect.any(Array),
      "held-1",
      expect.anything()
    );
    const ranges = mockedCheckCapacity.mock.calls[0][2] as Array<{
      stayStart: Date;
      stayEnd: Date;
    }>;
    expect(ranges).toHaveLength(5); // 1 teacher + 4 children
    expect(ranges[0]).toMatchObject({ stayStart: CHECK_IN, stayEnd: CHECK_OUT });
    // The guest swap ran and the hold flipped to CONFIRMED (guard did not over-reject).
    const updateArgs = vi.mocked(prisma.booking.update).mock.calls[0][0]
      .data as Record<string, unknown>;
    expect(updateArgs.status).toBe(BookingStatus.CONFIRMED);
  });

  it("uses an officer-set price override when present", async () => {
    mockedFindUnique.mockResolvedValue(
      schoolRequest({ status: BookingRequestStatus.PRICED, priceCents: 33000 }) as never
    );

    const result = await approveSchoolBookingRequest({
      requestId: "req-school",
      adminMemberId: "admin-1",
    });

    expect(result).toMatchObject({ priceCents: 33000 });
    const bookingArgs = vi.mocked(prisma.booking.create).mock.calls[0][0].data as Record<
      string,
      unknown
    >;
    expect(bookingArgs.finalPriceCents).toBe(33000);
  });

  it("refuses to approve when no season covers the dates and no price is set", async () => {
    mockedFindUnique.mockResolvedValue(schoolRequest() as never);
    mockedSeasonFindMany.mockResolvedValue([] as never);

    await expect(
      approveSchoolBookingRequest({ requestId: "req-school", adminMemberId: "admin-1" })
    ).rejects.toMatchObject({ status: 409 });
  });

  it("regenerates guests, reprices, and snapshots the request when the admin varies the quantity", async () => {
    mockedFindUnique.mockResolvedValue(schoolRequest() as never);

    const result = await approveSchoolBookingRequest({
      requestId: "req-school",
      adminMemberId: "admin-1",
      guestOverride: { childCounts: { CHILD: 4 } },
    });

    // 1 adult @ 5000 x2 + 4 children @ 2500 x2 = 10000 + 20000 = 30000.
    expect(result).toMatchObject({ type: "approved", priceCents: 30000 });

    // Booking holds the regenerated guest list (1 teacher + 4 children).
    const bookingArgs = vi.mocked(prisma.booking.create).mock.calls[0][0].data as {
      guests: { create: unknown[] };
      finalPriceCents: number;
    };
    expect(bookingArgs.guests.create).toHaveLength(5);
    expect(bookingArgs.finalPriceCents).toBe(30000);

    // The request snapshot is updated to match what was booked.
    const updateArgs = vi.mocked(prisma.bookingRequest.update).mock.calls.at(-1)?.[0]
      .data as { guests?: unknown[] };
    expect(updateArgs.guests).toHaveLength(5);
  });

  it("re-splits an officer-set price across the varied guest count", async () => {
    mockedFindUnique.mockResolvedValue(
      schoolRequest({ status: BookingRequestStatus.PRICED, priceCents: 30000 }) as never
    );

    const result = await approveSchoolBookingRequest({
      requestId: "req-school",
      adminMemberId: "admin-1",
      guestOverride: { childCounts: { CHILD: 4 } },
    });

    // The negotiated total is preserved and split across the new 5 guests.
    expect(result).toMatchObject({ priceCents: 30000 });
    const bookingArgs = vi.mocked(prisma.booking.create).mock.calls[0][0].data as {
      guests: { create: unknown[] };
    };
    expect(bookingArgs.guests.create).toHaveLength(5);
  });

  it("rejects a quantity override that exceeds the lodge capacity", async () => {
    mockedFindUnique.mockResolvedValue(schoolRequest() as never);

    await expect(
      approveSchoolBookingRequest({
        requestId: "req-school",
        adminMemberId: "admin-1",
        guestOverride: { childCounts: { CHILD: 50 } },
      })
    ).rejects.toMatchObject({ status: 422 });
    expect(prisma.member.create).not.toHaveBeenCalled();
  });

  it("runs the member-night conflict guard with the requested guests and range before creating anything (issue #1158)", async () => {
    mockedFindUnique.mockResolvedValue(schoolRequest() as never);

    await approveSchoolBookingRequest({ requestId: "req-school", adminMemberId: "admin-1" });

    expect(mockedAssertNoConflicts).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({
        actorMemberId: "admin-1",
        actorRole: "ADMIN",
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        excludeBookingId: undefined,
      })
    );
    const guardGuests = mockedAssertNoConflicts.mock.calls[0][1].guests;
    expect(guardGuests).toHaveLength(3);
    expect(guardGuests[0]).toMatchObject({ stayStart: CHECK_IN, stayEnd: CHECK_OUT });
  });

  it("blocks approval and creates nothing when a linked member double-books (issue #1158)", async () => {
    mockedFindUnique.mockResolvedValue(schoolRequest() as never);
    mockedAssertNoConflicts.mockRejectedValueOnce(memberNightConflictError());

    await expect(
      approveSchoolBookingRequest({ requestId: "req-school", adminMemberId: "admin-1" })
    ).rejects.toBeInstanceOf(BookingMemberNightConflictError);

    expect(prisma.member.create).not.toHaveBeenCalled();
    expect(prisma.booking.create).not.toHaveBeenCalled();
    expect(mockedEnqueueInvoice).not.toHaveBeenCalled();
  });
});
