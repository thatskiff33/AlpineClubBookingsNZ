/**
 * #2936 — correcting a booking request before it is converted.
 *
 * The properties under test are the ones an officer's mistake would otherwise
 * be paid for in money or beds: a correction never survives an agreed quote,
 * never runs on data nobody can read, never leaves a price computed from a
 * shape that has changed, never leaves beds held for the old one, and — since
 * #3367 — never quietly moves a school onto a different Xero customer.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BookingRequestQuoteStatus,
  BookingRequestStatus,
  BookingRequestType,
  BookingStatus,
  SchoolCateringPreference,
} from "@prisma/client";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    bookingRequest: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
    },
    bookingRequestQuote: { updateMany: vi.fn() },
    booking: { findUnique: vi.fn() },
    // The read-only school-record preview. `findFirst` answering null is the
    // "club has never heard of this school" branch.
    organisation: { findFirst: vi.fn().mockResolvedValue(null) },
    lodge: { findFirst: vi.fn().mockResolvedValue({ id: "lodge-1" }) },
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
  },
}));

vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn(),
  createAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/booking-cancel", () => ({
  cancelBooking: vi.fn().mockResolvedValue({ status: 200 }),
}));

vi.mock("@/lib/booking-request-shared", async (importOriginal) => {
  const actual =
    (await importOriginal()) as typeof import("@/lib/booking-request-shared");
  return {
    ...actual,
    collectNotifiedMemberGuestIds: vi.fn().mockResolvedValue(["member-guest-1"]),
    notifyMemberGuestsHoldReleased: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@/lib/capacity", () => ({
  acquireLodgeCapacityLock: vi.fn().mockResolvedValue(undefined),
  checkCapacityForGuestRanges: vi.fn().mockResolvedValue({
    available: true,
    minAvailable: 20,
    nightDetails: [],
  }),
  findOverlappingCapacityHoldingBookings: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/lodge-capacity", () => ({
  getLodgeCapacity: vi.fn().mockResolvedValue(40),
  getDefaultLodgeCapacity: vi.fn().mockResolvedValue(40),
  FALLBACK_LODGE_CAPACITY: 20,
}));

vi.mock("@/lib/lodges", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/lodges");
  return { ...actual, getDefaultLodgeId: vi.fn().mockResolvedValue("lodge-1") };
});

vi.mock("@/lib/club-time-zone-runtime", () => ({
  readClubTimeZoneOutsideRequest: vi.fn().mockResolvedValue("Pacific/Auckland"),
}));

vi.mock("@/lib/email", () => ({
  sendBookingRequestVerificationEmail: vi.fn().mockResolvedValue(undefined),
  sendBookingRequestDeclinedEmail: vi.fn().mockResolvedValue(undefined),
  sendHutLeaderAssignmentEmail: vi.fn().mockResolvedValue(undefined),
  sendAdminSchoolManualInvoiceEmail: vi.fn().mockResolvedValue(undefined),
  sendAdminWholeLodgeManualInvoiceEmail: vi.fn().mockResolvedValue(undefined),
  sendBookingConfirmedEmail: vi.fn().mockResolvedValue(undefined),
  sendAdminOwnerSubstitutionAlert: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { logAudit } from "@/lib/audit";
import { cancelBooking } from "@/lib/booking-cancel";
import { notifyMemberGuestsHoldReleased } from "@/lib/booking-request-shared";
import { checkCapacityForGuestRanges } from "@/lib/capacity";
import { prisma } from "@/lib/prisma";
import {
  correctBookingRequest,
  type BookingRequestCorrectionInput,
} from "@/lib/booking-request-corrections";
import { BookingRequestCorrectionCommittedError } from "@/lib/booking-request-correction-hold";

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

/** A verified school request as it sits in the officer's queue. */
function schoolRequestRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "req-1",
    type: BookingRequestType.SCHOOL,
    status: BookingRequestStatus.PRICED,
    version: 4,
    lodgeId: "lodge-1",
    contactFirstName: "Ann",
    contactLastName: "Baker",
    contactEmail: "ann@example.test",
    contactPhone: "0211111111",
    checkIn: day("2026-08-10"),
    checkOut: day("2026-08-12"),
    guests: [
      { firstName: "Ann", lastName: "Baker", ageTier: "ADULT" },
      { firstName: "School Child", lastName: "1", ageTier: "CHILD" },
    ],
    schoolName: "Tokora Primary School",
    teachers: [{ firstName: "Ann", lastName: "Baker", email: "ann@example.test" }],
    cateringPreference: SchoolCateringPreference.QUOTE_BOTH,
    linkedGuestMembers: [],
    message: null,
    priceCents: 25000,
    exclusivityRequested: false,
    requestedByMemberId: null,
    convertedBookingId: null,
    acceptedQuoteId: null,
    heldBookingId: null,
    quotes: [],
    ...overrides,
  };
}

function schoolInput(
  overrides: Partial<BookingRequestCorrectionInput> = {},
): BookingRequestCorrectionInput {
  return {
    requestId: "req-1",
    adminMemberId: "admin-1",
    ipAddress: "10.0.0.1",
    expectedVersion: 4,
    reason: "School rang: two more children and the dates moved a week.",
    checkIn: day("2026-08-17"),
    checkOut: day("2026-08-19"),
    contactFirstName: "Ann",
    contactLastName: "Baker",
    contactEmail: "ann@example.test",
    contactPhone: "0211111111",
    school: {
      schoolName: "Tokoroa Primary School",
      teachers: [
        { firstName: "Ann", lastName: "Baker", email: "ann@example.test" },
      ],
      childCounts: { CHILD: 3 },
      cateringPreference: SchoolCateringPreference.QUOTE_BOTH,
      schoolRecord: { outcome: "new" },
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (prisma.$transaction as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    async (fn: (tx: typeof prisma) => unknown) => fn(prisma),
  );
  (prisma.$executeRaw as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(1);
  (prisma.organisation.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  (prisma.bookingRequest.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({
    count: 1,
  });
  (prisma.bookingRequestQuote.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue(
    { count: 0 },
  );
  (checkCapacityForGuestRanges as ReturnType<typeof vi.fn>).mockResolvedValue({
    available: true,
    minAvailable: 20,
    nightDetails: [],
  });
  (cancelBooking as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 200 });
});

function stubRequest(row: Record<string, unknown>) {
  (prisma.bookingRequest.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(row);
}

/** The `data` the claim wrote, for assertions about what a correction changes. */
function claimData() {
  const call = (prisma.bookingRequest.updateMany as ReturnType<typeof vi.fn>).mock
    .calls[0][0];
  return call.data as Record<string, unknown>;
}

describe("what may be corrected at all", () => {
  it("refuses a member's whole-lodge request, which has no quote stage", async () => {
    stubRequest(
      schoolRequestRow({
        type: BookingRequestType.GENERAL,
        requestedByMemberId: "member-9",
        exclusivityRequested: true,
        schoolName: null,
        teachers: null,
      }),
    );
    await expect(
      correctBookingRequest(schoolInput({ school: null, guests: [] })),
    ).rejects.toThrow(/whole-lodge request cannot be corrected/i);
    expect(prisma.bookingRequest.updateMany).not.toHaveBeenCalled();
  });

  it("refuses a request that has already become a booking", async () => {
    stubRequest(schoolRequestRow({ convertedBookingId: "booking-1" }));
    await expect(correctBookingRequest(schoolInput())).rejects.toThrow(
      /already been converted/i,
    );
    expect(prisma.bookingRequest.updateMany).not.toHaveBeenCalled();
  });

  it("refuses a request that is no longer open", async () => {
    stubRequest(schoolRequestRow({ status: BookingRequestStatus.DECLINED }));
    await expect(correctBookingRequest(schoolInput())).rejects.toThrow(
      /no longer open/i,
    );
  });

  it("refuses an unverified request, which nobody has asked for a change to", async () => {
    stubRequest(schoolRequestRow({ status: BookingRequestStatus.NEW }));
    await expect(correctBookingRequest(schoolInput())).rejects.toThrow(
      /no longer open/i,
    );
  });
});

describe("an agreed quote blocks the edit", () => {
  it("refuses when a quote row has been accepted", async () => {
    stubRequest(
      schoolRequestRow({
        quotes: [{ id: "q-1", status: BookingRequestQuoteStatus.ACCEPTED }],
      }),
    );
    await expect(correctBookingRequest(schoolInput())).rejects.toThrow(
      /already accepted a quote/i,
    );
    expect(prisma.bookingRequest.updateMany).not.toHaveBeenCalled();
  });

  it("refuses on the request's own accepted-quote pointer, not only the quote row", async () => {
    // The reachable half-state: the accept re-armed the request and the
    // conversion that follows it in the same call did not finish. The quote row
    // is still SENT, so a guard reading only the rows would let the edit
    // through and void an agreement the requester has already made.
    stubRequest(
      schoolRequestRow({
        acceptedQuoteId: "q-1",
        quotes: [{ id: "q-1", status: BookingRequestQuoteStatus.SENT }],
      }),
    );
    await expect(correctBookingRequest(schoolInput())).rejects.toThrow(
      /already accepted a quote/i,
    );
  });

  it("supersedes a DRAFT or SENT quote instead, and says how many", async () => {
    stubRequest(
      schoolRequestRow({
        status: BookingRequestStatus.QUOTE_SENT,
        quotes: [{ id: "q-1", status: BookingRequestQuoteStatus.SENT }],
      }),
    );
    (prisma.bookingRequestQuote.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue(
      { count: 1 },
    );
    const result = await correctBookingRequest(schoolInput());
    expect(result.supersededQuoteCount).toBe(1);
    const call = (prisma.bookingRequestQuote.updateMany as ReturnType<typeof vi.fn>)
      .mock.calls[0][0];
    expect(call.where.status.in).toEqual([
      BookingRequestQuoteStatus.DRAFT,
      BookingRequestQuoteStatus.SENT,
    ]);
    // SUPERSEDED, never CANCELLED — that status is the requester's own
    // semantic, and flipping off SENT is what kills their response link.
    expect(call.data.status).toBe(BookingRequestQuoteStatus.SUPERSEDED);
    expect(call.data.supersededAt).toBeInstanceOf(Date);
  });
});

describe("corrupt stored data is refused rather than guessed", () => {
  it("refuses a request whose stored guest list cannot be read back", async () => {
    stubRequest(schoolRequestRow({ guests: [{ firstName: "Ann" }] }));
    await expect(correctBookingRequest(schoolInput())).rejects.toThrow();
    expect(prisma.bookingRequest.updateMany).not.toHaveBeenCalled();
  });

  it("refuses a request whose stored member links cannot be read back", async () => {
    stubRequest(schoolRequestRow({ linkedGuestMembers: [{ guestIndex: "x" }] }));
    await expect(correctBookingRequest(schoolInput())).rejects.toThrow();
    expect(prisma.bookingRequest.updateMany).not.toHaveBeenCalled();
  });
});

describe("the corrected values themselves", () => {
  it("refuses a stay that ends before it starts", async () => {
    stubRequest(schoolRequestRow());
    await expect(
      correctBookingRequest(
        schoolInput({ checkIn: day("2026-08-19"), checkOut: day("2026-08-17") }),
      ),
    ).rejects.toThrow(/Check-out must be after check-in/i);
  });

  it("refuses a stay that starts in the past at the club", async () => {
    stubRequest(schoolRequestRow());
    await expect(
      correctBookingRequest(
        schoolInput({ checkIn: day("2026-06-01"), checkOut: day("2026-06-03") }),
      ),
    ).rejects.toThrow(/cannot start in the past/i);
  });

  it("refuses a party larger than the lodge", async () => {
    stubRequest(schoolRequestRow());
    await expect(
      correctBookingRequest(
        schoolInput({
          school: { ...schoolInput().school!, childCounts: { CHILD: 200 } },
        }),
      ),
    ).rejects.toThrow(/larger than the lodge capacity/i);
  });

  it("refuses a school correction with no teacher attending", async () => {
    stubRequest(schoolRequestRow());
    await expect(
      correctBookingRequest(
        schoolInput({ school: { ...schoolInput().school!, teachers: [] } }),
      ),
    ).rejects.toThrow(/at least one teacher/i);
  });

  it("requires the officer to record why", async () => {
    stubRequest(schoolRequestRow());
    await expect(
      correctBookingRequest(schoolInput({ reason: "   " })),
    ).rejects.toThrow(/Record why/i);
  });

  it("refuses a correction that changes nothing", async () => {
    stubRequest(schoolRequestRow());
    await expect(
      correctBookingRequest(
        schoolInput({
          checkIn: day("2026-08-10"),
          checkOut: day("2026-08-12"),
          school: {
            ...schoolInput().school!,
            schoolName: "Tokora Primary School",
            childCounts: { CHILD: 1 },
            schoolRecord: { outcome: "new" },
          },
        }),
      ),
    ).rejects.toThrow(/Nothing was changed/i);
  });
});

describe("optimistic concurrency", () => {
  it("refuses a correction written over a version the officer never saw", async () => {
    stubRequest(schoolRequestRow({ version: 7 }));
    await expect(
      correctBookingRequest(schoolInput({ expectedVersion: 4 })),
    ).rejects.toThrow(/changed while you were correcting it/i);
    expect(prisma.bookingRequest.updateMany).not.toHaveBeenCalled();
  });

  it("refuses when the guarded claim loses the row under the lock", async () => {
    stubRequest(schoolRequestRow());
    (prisma.bookingRequest.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({
      count: 0,
    });
    await expect(correctBookingRequest(schoolInput())).rejects.toThrow(
      /changed while you were correcting it/i,
    );
    // A lost claim touches nothing else: no quote is retired and no bed freed.
    expect(prisma.bookingRequestQuote.updateMany).not.toHaveBeenCalled();
    expect(cancelBooking).not.toHaveBeenCalled();
  });

  it("fences the claim on version, status, conversion and acceptance together", async () => {
    stubRequest(schoolRequestRow());
    await correctBookingRequest(schoolInput());
    const where = (prisma.bookingRequest.updateMany as ReturnType<typeof vi.fn>).mock
      .calls[0][0].where;
    expect(where.version).toBe(4);
    expect(where.convertedBookingId).toBeNull();
    expect(where.acceptedQuoteId).toBeNull();
    expect(where.status.in).toContain(BookingRequestStatus.QUOTE_SENT);
    expect(where.status.in).not.toContain(BookingRequestStatus.CONVERTED);
  });

  it("takes the canonical global lock before it reads anything it claims on", async () => {
    stubRequest(schoolRequestRow());
    await correctBookingRequest(schoolInput());
    const raw = (prisma.$executeRaw as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(raw.join("?")).toContain("pg_advisory_xact_lock(1)");
  });
});

describe("a correction re-opens the request", () => {
  it("clears the price and drops the request back to VERIFIED", async () => {
    stubRequest(schoolRequestRow());
    await correctBookingRequest(schoolInput());
    const data = claimData();
    expect(data.status).toBe(BookingRequestStatus.VERIFIED);
    expect(data.priceCents).toBeNull();
    expect(data.pricedAt).toBeNull();
    expect(data.pricedByMemberId).toBeNull();
    expect(data.version).toEqual({ increment: 1 });
  });

  it("writes the corrected envelope, party, contact and school details", async () => {
    stubRequest(schoolRequestRow());
    const result = await correctBookingRequest(schoolInput());
    const data = claimData();
    expect(data.checkIn).toEqual(day("2026-08-17"));
    expect(data.checkOut).toEqual(day("2026-08-19"));
    expect(data.schoolName).toBe("Tokoroa Primary School");
    expect(data.cateringPreference).toBe(SchoolCateringPreference.QUOTE_BOTH);
    // The party is REGENERATED from teachers + counts, exactly as the public
    // school form builds it — never spliced into the stored list.
    expect(data.guests).toEqual([
      { firstName: "Ann", lastName: "Baker", ageTier: "ADULT" },
      { firstName: "School Child", lastName: "1", ageTier: "CHILD" },
      { firstName: "School Child", lastName: "2", ageTier: "CHILD" },
      { firstName: "School Child", lastName: "3", ageTier: "CHILD" },
    ]);
    expect(result.changedFields).toEqual(
      expect.arrayContaining(["checkIn", "checkOut", "guests", "schoolName"]),
    );
  });

  it("normalises a corrected teacher the way the public form does", async () => {
    stubRequest(schoolRequestRow());
    await correctBookingRequest(
      schoolInput({
        school: {
          ...schoolInput().school!,
          teachers: [
            { firstName: "  Ann ", lastName: "Baker ", email: "ANN@Example.test" },
            { firstName: "  ", lastName: "", email: null },
          ],
        },
      }),
    );
    expect(claimData().teachers).toEqual([
      { firstName: "Ann", lastName: "Baker", email: "ann@example.test" },
    ]);
  });

  it("records the correction, what changed, and why, in the audit log", async () => {
    stubRequest(schoolRequestRow());
    await correctBookingRequest(schoolInput());
    const row = (logAudit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(row.action).toBe("booking_request.corrected");
    expect(row.category).toBe("booking");
    expect(row.entityType).toBe("BookingRequest");
    expect(row.metadata.reason).toMatch(/two more children/);
    expect(row.metadata.previousCheckIn).toBe("2026-08-10T00:00:00.000Z");
    expect(row.metadata.checkIn).toBe("2026-08-17T00:00:00.000Z");
    expect(row.metadata.previousPriceCents).toBe(25000);
  });
});

describe("#3367: which school the corrected name resolves to", () => {
  const existingRecord = {
    id: "org-7",
    name: "Tokoroa Primary School",
    archivedAt: null,
    xeroContactId: "xero-contact-7",
    contacts: [{ member: { firstName: "Bill", lastName: "Carter" } }],
  };

  it("refuses when the officer confirmed a new school and the club already has one", async () => {
    stubRequest(schoolRequestRow());
    (prisma.organisation.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
      existingRecord,
    );
    await expect(correctBookingRequest(schoolInput())).rejects.toThrow(
      /already has on record.*Xero customer/is,
    );
    expect(prisma.bookingRequest.updateMany).not.toHaveBeenCalled();
  });

  it("refuses when the officer confirmed an existing school the club does not have", async () => {
    stubRequest(schoolRequestRow());
    await expect(
      correctBookingRequest(
        schoolInput({
          school: {
            ...schoolInput().school!,
            schoolRecord: { outcome: "existing", schoolRecordId: "org-7" },
          },
        }),
      ),
    ).rejects.toThrow(/no school on record/i);
  });

  it("refuses when the acknowledgement names a DIFFERENT record from the one the name claims", async () => {
    stubRequest(schoolRequestRow());
    (prisma.organisation.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
      existingRecord,
    );
    await expect(
      correctBookingRequest(
        schoolInput({
          school: {
            ...schoolInput().school!,
            schoolRecord: { outcome: "existing", schoolRecordId: "org-other" },
          },
        }),
      ),
    ).rejects.toThrow(/already has on record/i);
  });

  it("saves when the officer confirmed the record the name actually claims", async () => {
    stubRequest(schoolRequestRow());
    (prisma.organisation.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
      existingRecord,
    );
    const result = await correctBookingRequest(
      schoolInput({
        school: {
          ...schoolInput().school!,
          schoolRecord: { outcome: "existing", schoolRecordId: "org-7" },
        },
      }),
    );
    expect(result.schoolRecord?.known).toBe(true);
    expect(result.schoolRecord?.schoolRecordHasXeroCustomer).toBe(true);
    // The people this request's teachers would REPLACE at approval, surfaced
    // here because the replacement itself happens in a later transaction.
    expect(result.schoolRecord?.currentContactNames).toEqual(["Bill Carter"]);
    const row = (logAudit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(row.metadata.schoolContactPeopleToReplace).toEqual(["Bill Carter"]);
    expect(row.metadata.schoolRecordHasXeroCustomer).toBe(true);
  });

  it("asks the question UNDER the lock, not before it", async () => {
    stubRequest(schoolRequestRow());
    const order: string[] = [];
    (prisma.$executeRaw as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push("lock");
      return 1;
    });
    (prisma.organisation.findFirst as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        order.push("preview");
        return null;
      },
    );
    await correctBookingRequest(schoolInput());
    expect(order).toEqual(["lock", "preview"]);
  });

  it("never asks it for a general request", async () => {
    stubRequest(
      schoolRequestRow({
        type: BookingRequestType.GENERAL,
        schoolName: null,
        teachers: null,
        cateringPreference: null,
      }),
    );
    const result = await correctBookingRequest(
      schoolInput({
        school: null,
        guests: [{ firstName: "Cam", lastName: "Doyle", ageTier: "ADULT" }],
      }),
    );
    expect(prisma.organisation.findFirst).not.toHaveBeenCalled();
    expect(result.schoolRecord).toBeNull();
    expect(claimData().schoolName).toBeUndefined();
  });
});

describe("the beds the request was holding", () => {
  const heldRow = () =>
    schoolRequestRow({
      heldBookingId: "held-1",
      status: BookingRequestStatus.QUOTE_SENT,
    });

  it("releases a live hold through the shared cancel path, and tells the members on it", async () => {
    stubRequest(heldRow());
    (prisma.booking.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "held-1",
      status: BookingStatus.AWAITING_REVIEW,
    });
    const result = await correctBookingRequest(schoolInput());
    expect(result.holdOutcome).toBe("released");
    const [bookingId, actor, role, ip, refundMethod, options] = (
      cancelBooking as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(bookingId).toBe("held-1");
    expect(actor).toBe("admin-1");
    expect(role).toBe("ADMIN");
    expect(ip).toBe("10.0.0.1");
    expect(refundMethod).toBe("card");
    expect(options.suppressCustomerNotification).toBe(true);
    // Without this the shared cancel path would clobber a booking a requester
    // accept had just converted out from under the correction.
    expect(options.requireRequestHold).toBe(true);
    expect(notifyMemberGuestsHoldReleased).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: "held-1",
        targetMemberIds: ["member-guest-1"],
      }),
    );
  });

  it("releases it AFTER the correction has committed, never inside that transaction", async () => {
    stubRequest(heldRow());
    (prisma.booking.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "held-1",
      status: BookingStatus.AWAITING_REVIEW,
    });
    const order: string[] = [];
    (prisma.$transaction as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (fn: (tx: typeof prisma) => unknown) => {
        const out = await fn(prisma);
        order.push("claim committed");
        return out;
      },
    );
    (cancelBooking as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push("hold released");
      return { status: 200 };
    });
    await correctBookingRequest(schoolInput());
    expect(order).toEqual(["claim committed", "hold released"]);
  });

  it("keeps the beds when only the catering preference changed", async () => {
    stubRequest(heldRow());
    const result = await correctBookingRequest(
      schoolInput({
        checkIn: day("2026-08-10"),
        checkOut: day("2026-08-12"),
        school: {
          ...schoolInput().school!,
          schoolName: "Tokora Primary School",
          childCounts: { CHILD: 1 },
          cateringPreference: SchoolCateringPreference.CATERED,
        },
      }),
    );
    expect(result.changedFields).toEqual(["cateringPreference"]);
    expect(result.holdOutcome).toBe("keptCateringOnly");
    expect(cancelBooking).not.toHaveBeenCalled();
  });

  it("detaches a pointer to a hold that is no longer live", async () => {
    stubRequest(heldRow());
    (prisma.booking.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "held-1",
      status: BookingStatus.CANCELLED,
    });
    const result = await correctBookingRequest(schoolInput());
    expect(result.holdOutcome).toBe("detachedStalePointer");
    expect(cancelBooking).not.toHaveBeenCalled();
    const detach = (prisma.bookingRequest.updateMany as ReturnType<typeof vi.fn>).mock
      .calls.at(-1)![0];
    expect(detach.data.heldBookingId).toBeNull();
  });

  it("says the correction was SAVED when the release is refused, rather than a clean success", async () => {
    stubRequest(heldRow());
    (prisma.booking.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "held-1",
      status: BookingStatus.AWAITING_REVIEW,
    });
    (cancelBooking as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 409,
      error: "already accepted",
    });
    await expect(correctBookingRequest(schoolInput())).rejects.toBeInstanceOf(
      BookingRequestCorrectionCommittedError,
    );
    await expect(correctBookingRequest(schoolInput())).rejects.toThrow(
      /correction was saved/i,
    );
  });

  it("still records the correction when the release fails, because that is the row an officer needs", async () => {
    // The claim has already committed at this point. If the release error were
    // allowed past the audit write, the ONE case where the beds are left held
    // for the old shape would be the one case with no record of who corrected
    // the request, when, or why.
    stubRequest(heldRow());
    (prisma.booking.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "held-1",
      status: BookingStatus.AWAITING_REVIEW,
    });
    (cancelBooking as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 500,
      error: "boom",
    });
    await expect(correctBookingRequest(schoolInput())).rejects.toBeInstanceOf(
      BookingRequestCorrectionCommittedError,
    );
    const row = (logAudit as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0];
    expect(row.action).toBe("booking_request.corrected");
    expect(row.category).toBe("booking");
    // Not a `CorrectionHoldOutcome`: no outcome was reached, and the row says so
    // rather than implying the beds went.
    expect(row.metadata.holdOutcome).toBe("releaseFailed");
    expect(row.metadata.reason).toBeTruthy();
  });

  it("reports nothing to do when the request held no beds", async () => {
    stubRequest(schoolRequestRow());
    const result = await correctBookingRequest(schoolInput());
    expect(result.holdOutcome).toBe("none");
    expect(cancelBooking).not.toHaveBeenCalled();
  });
});

describe("availability after the correction", () => {
  it("re-runs the canonical check over the corrected envelope and party", async () => {
    stubRequest(schoolRequestRow());
    await correctBookingRequest(schoolInput());
    const [lodgeId, checkIn, checkOut, ranges] = (
      checkCapacityForGuestRanges as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(lodgeId).toBe("lodge-1");
    expect(checkIn).toEqual(day("2026-08-17"));
    expect(checkOut).toEqual(day("2026-08-19"));
    // One range per corrected guest: one teacher plus three children.
    expect(ranges).toHaveLength(4);
  });

  it("reports full nights without refusing the correction", async () => {
    stubRequest(schoolRequestRow());
    (checkCapacityForGuestRanges as ReturnType<typeof vi.fn>).mockResolvedValue({
      available: false,
      minAvailable: 0,
      nightDetails: [
        {
          date: day("2026-08-17"),
          occupiedBeds: 20,
          availableBeds: -2,
          wholeLodgeHeld: false,
        },
        {
          date: day("2026-08-18"),
          occupiedBeds: 16,
          availableBeds: 4,
          wholeLodgeHeld: false,
        },
      ],
    });
    const result = await correctBookingRequest(schoolInput());
    // The requester asked for these nights; recording what they asked for is
    // the officer's job whether or not the lodge can take it.
    expect(result.availability.available).toBe(false);
    expect(result.availability.fullNights).toEqual(["2026-08-17"]);
    expect(prisma.bookingRequest.updateMany).toHaveBeenCalled();
  });

  it("measures it after the hold went, not while the old hold still sterilised beds", async () => {
    stubRequest(
      schoolRequestRow({
        heldBookingId: "held-1",
        status: BookingRequestStatus.QUOTE_SENT,
      }),
    );
    (prisma.booking.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "held-1",
      status: BookingStatus.AWAITING_REVIEW,
    });
    const order: string[] = [];
    (cancelBooking as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push("released");
      return { status: 200 };
    });
    (checkCapacityForGuestRanges as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        order.push("measured");
        return { available: true, minAvailable: 20, nightDetails: [] };
      },
    );
    await correctBookingRequest(schoolInput());
    expect(order).toEqual(["released", "measured"]);
  });
});

describe("the party and the member links keyed to it move together", () => {
  /**
   * THE DEFECT: a school books with two teachers, and the officer has linked
   * the second — index 1 — to a real club member. A teacher drops out, the
   * officer corrects the party, and `generateSchoolGuests` rebuilds the list a
   * row shorter. Index 1 is now a CHILD. A correction that rewrote the list and
   * left the links alone would hand that child the member's identity: priced at
   * member rates, checked for night conflicts against them, given their consent
   * plan, and emailed to tell them the club has put them on a lodge booking.
   * The mirror case drops a link entirely and quietly turns a linked member
   * into a non-member.
   */
  function twoTeacherRow(overrides: Record<string, unknown> = {}) {
    return schoolRequestRow({
      guests: [
        { firstName: "Ann", lastName: "Baker", ageTier: "ADULT" },
        { firstName: "Bea", lastName: "Cole", ageTier: "ADULT" },
        { firstName: "School Child", lastName: "1", ageTier: "CHILD" },
      ],
      teachers: [
        { firstName: "Ann", lastName: "Baker", email: "ann@example.test" },
        { firstName: "Bea", lastName: "Cole", email: "bea@example.test" },
      ],
      linkedGuestMembers: [{ guestIndex: 1, memberId: "member-42" }],
      ...overrides,
    });
  }

  /** The same correction, with the second teacher dropped. */
  function droppedTeacherInput() {
    return schoolInput({
      checkIn: day("2026-08-10"),
      checkOut: day("2026-08-12"),
      school: {
        ...schoolInput().school!,
        schoolName: "Tokora Primary School",
        teachers: [
          { firstName: "Ann", lastName: "Baker", email: "ann@example.test" },
        ],
        childCounts: { CHILD: 1 },
      },
    });
  }

  it("clears the links when the party moved, so no member lands on another row", async () => {
    stubRequest(twoTeacherRow());
    const result = await correctBookingRequest(droppedTeacherInput());

    expect(result.changedFields).toContain("guests");
    expect(result.clearedMemberLinkCount).toBe(1);
    const data = claimData();
    // The corrected list is a row shorter, and nothing claims index 1 any more.
    expect(data.guests).toEqual([
      { firstName: "Ann", lastName: "Baker", ageTier: "ADULT" },
      { firstName: "School Child", lastName: "1", ageTier: "CHILD" },
    ]);
    expect(data.linkedGuestMembers).toEqual([]);
  });

  it("writes the list and its links in ONE claim, so no interleaving can split them", async () => {
    // The interleaving this closes: a second write, after the claim committed,
    // is a window in which the request holds the NEW party and the OLD
    // positional links — and every consumer resolves those links by index. A
    // crash, a lost connection or a concurrent reader landing in that window
    // reads a real member onto somebody else's row. One guarded claim, inside
    // the transaction, has no such window: the version fence means either both
    // land or neither does.
    stubRequest(twoTeacherRow());
    const order: string[] = [];
    (prisma.$transaction as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (fn: (tx: typeof prisma) => unknown) => {
        order.push("transaction:open");
        const out = await fn(prisma);
        order.push("transaction:commit");
        return out;
      },
    );
    (prisma.bookingRequest.updateMany as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        order.push("claim");
        return { count: 1 };
      },
    );

    await correctBookingRequest(droppedTeacherInput());

    // Exactly one request write, and it is inside the claim transaction.
    expect(order).toEqual(["transaction:open", "claim", "transaction:commit"]);
    expect(prisma.bookingRequest.updateMany).toHaveBeenCalledTimes(1);
    const call = (prisma.bookingRequest.updateMany as ReturnType<typeof vi.fn>)
      .mock.calls[0][0];
    expect(call.data.guests).toBeDefined();
    expect(call.data.linkedGuestMembers).toEqual([]);
    // And the write is fenced, so a correction racing anything that moved the
    // row claims nothing at all rather than half of it.
    expect(call.where.version).toBe(4);
  });

  it("keeps the links when the list did not move a single position", async () => {
    // Dates only. Every guest is where it was, so every link still names the
    // person it named — clearing them here would make the officer re-link for
    // nothing, and an officer who re-links for nothing eventually does not.
    stubRequest(twoTeacherRow());
    const result = await correctBookingRequest(
      schoolInput({
        school: {
          ...schoolInput().school!,
          schoolName: "Tokora Primary School",
          teachers: [
            { firstName: "Ann", lastName: "Baker", email: "ann@example.test" },
            { firstName: "Bea", lastName: "Cole", email: "bea@example.test" },
          ],
          childCounts: { CHILD: 1 },
        },
      }),
    );

    expect(result.changedFields).toEqual(["checkIn", "checkOut"]);
    expect(result.clearedMemberLinkCount).toBe(0);
    expect(claimData().linkedGuestMembers).toBeUndefined();
  });

  it("records the cleared links on the audit row", async () => {
    stubRequest(twoTeacherRow());
    await correctBookingRequest(droppedTeacherInput());
    const entry = (logAudit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(entry.metadata.clearedMemberLinkCount).toBe(1);
  });
});
