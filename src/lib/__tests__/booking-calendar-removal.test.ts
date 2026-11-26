import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #5249: the cancellation file and calendar note are sent only where the member
 * was offered a calendar entry, and the file only for a stay that no longer
 * stands. A wrong answer either way is a real harm: a file to someone never
 * offered an entry leaks the booking into their mail, and a file for a standing
 * stay removes a real entry from the member's calendar.
 */

const mocks = vi.hoisted(() => ({
  emailLogFindFirst: vi.fn(),
  bookingFindUnique: vi.fn(),
  resolveBookingEmailLink: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    emailLog: { findFirst: mocks.emailLogFindFirst },
    booking: { findUnique: mocks.bookingFindUnique },
  },
}));
vi.mock("@/lib/booking-email-authority", () => ({
  resolveBookingEmailLink: mocks.resolveBookingEmailLink,
}));
vi.mock("@/lib/logger", () => ({
  default: { error: mocks.loggerError, warn: vi.fn(), info: vi.fn() },
}));

import {
  resolveBookingCalendarRemoval,
  retryCalendarRemovalAttachments,
  wasBookingCalendarEntryOffered,
} from "@/lib/booking-calendar-removal";
import { buildBookingIcs } from "@/lib/calendar-links";
import { parseDateOnly } from "@/lib/date-only";

const PARAMS = {
  bookingId: "bkg_cal1",
  recipientMemberId: "mem_owner",
  deliveryAddress: "owner@example.org",
  templateName: "booking-cancelled",
};
// After the frozen test clock (2026-07-01T00:00:00Z), so the booking's own
// revision is what the sequence has to beat.
const LATER_UPDATED_AT = new Date("2026-07-01T00:10:00.000Z");
const BOOKING = {
  checkIn: parseDateOnly("2026-08-01"),
  checkOut: parseDateOnly("2026-08-04"),
  status: "CANCELLED",
  updatedAt: LATER_UPDATED_AT,
  lodge: { name: "Example Lodge" },
};

function icsText(attachment: { content: Buffer } | null): string {
  return attachment ? attachment.content.toString("utf8") : "";
}

beforeEach(() => {
  vi.stubEnv("AUTH_SECRET", "calendar-test-secret");
  mocks.emailLogFindFirst.mockResolvedValue({ id: "log_confirmed" });
  mocks.resolveBookingEmailLink.mockResolvedValue({
    authority: "signed-in-booking-owner",
    bookingUrl: "https://bookings.example.org/bookings/bkg_cal1",
  });
  mocks.bookingFindUnique.mockResolvedValue(BOOKING);
});

describe("wasBookingCalendarEntryOffered", () => {
  it("looks for a SENT confirmation to this recipient, then repeats the booking-link privacy decision", async () => {
    await expect(wasBookingCalendarEntryOffered(PARAMS)).resolves.toBe(true);
    expect(mocks.emailLogFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          bookingId: "bkg_cal1",
          templateName: "booking-confirmed",
          bookingRecipientMemberId: "mem_owner",
          status: "SENT",
        },
      }),
    );
    expect(mocks.resolveBookingEmailLink).toHaveBeenCalledWith({
      bookingId: "bkg_cal1",
      templateName: "booking-cancelled",
      recipient: { kind: "member", memberId: "mem_owner" },
      deliveryAddress: "owner@example.org",
    });
  });

  it("is false for an organisation-owned booking without reading anything", async () => {
    await expect(
      wasBookingCalendarEntryOffered({ ...PARAMS, recipientMemberId: null }),
    ).resolves.toBe(false);
    expect(mocks.emailLogFindFirst).not.toHaveBeenCalled();
  });
});

describe("resolveBookingCalendarRemoval", () => {
  it.each([
    [
      "no SENT confirmation",
      () => mocks.emailLogFindFirst.mockResolvedValue(null),
    ],
    [
      "a recipient the booking-link decision refuses",
      () =>
        mocks.resolveBookingEmailLink.mockResolvedValue({
          authority: "unauthorized",
          bookingUrl: null,
        }),
    ],
    [
      "a failed EmailLog read",
      () => mocks.emailLogFindFirst.mockRejectedValue(new Error("db down")),
    ],
  ])("sends neither note nor file with %s", async (_label, arrange) => {
    arrange();
    await expect(resolveBookingCalendarRemoval(PARAMS)).resolves.toEqual({
      offered: false,
      attachment: null,
    });
    expect(mocks.bookingFindUnique).not.toHaveBeenCalled();
  });

  it.each(["CONFIRMED", "PAID", "PENDING", "COMPLETED"])(
    "never builds a file for a %s booking, whose entry still stands",
    async (status) => {
      mocks.bookingFindUnique.mockResolvedValue({ ...BOOKING, status });
      await expect(resolveBookingCalendarRemoval(PARAMS)).resolves.toEqual({
        offered: true,
        attachment: null,
      });
    },
  );

  it("keeps the note but drops the file when the booking cannot be read", async () => {
    mocks.bookingFindUnique.mockRejectedValue(new Error("db down"));
    await expect(resolveBookingCalendarRemoval(PARAMS)).resolves.toEqual({
      offered: true,
      attachment: null,
    });
    expect(mocks.loggerError).toHaveBeenCalledTimes(1);
  });

  it.each(["CANCELLED", "BUMPED"])(
    "attaches a CANCEL for the original event to a %s booking, at a sequence above its last revision",
    async (status) => {
      mocks.bookingFindUnique.mockResolvedValue({ ...BOOKING, status });
      const { offered, attachment } = await resolveBookingCalendarRemoval(PARAMS);
      expect(offered).toBe(true);
      expect(attachment).toMatchObject({
        filename: "lodge-stay-cancelled-20260801.ics",
        contentType: "text/calendar; charset=utf-8; method=CANCEL",
      });
      const ics = icsText(attachment);
      expect(ics).toContain("METHOD:CANCEL");
      expect(ics).toContain("STATUS:CANCELLED");
      // The same UID the download route's file carried.
      const published = buildBookingIcs({
        stay: { bookingId: "bkg_cal1", checkIn: BOOKING.checkIn, checkOut: BOOKING.checkOut },
        lodgeName: "Example Lodge",
        sequence: 0,
        generatedAt: new Date(),
      });
      const uid = published.split("\r\n").find((line) => line.startsWith("UID:"));
      expect(ics.split("\r\n")).toContain(uid);
      const sequence = Number(/SEQUENCE:(\d+)/.exec(ics)?.[1]);
      expect(sequence).toBeGreaterThan(
        Math.floor(LATER_UPDATED_AT.getTime() / 1000),
      );
    },
  );
});

describe("retryCalendarRemovalAttachments", () => {
  const ROW = {
    templateName: "booking-bumped",
    bookingId: "bkg_cal1",
    bookingRecipientMemberId: "mem_owner",
    to: "owner@example.org",
  };

  it("rebuilds the file for a retried bumped or cancelled email under the same rules", async () => {
    const attachments = await retryCalendarRemovalAttachments(ROW);
    expect(attachments).toHaveLength(1);
    expect(icsText(attachments[0])).toContain("METHOD:CANCEL");
    expect(mocks.resolveBookingEmailLink).toHaveBeenCalledWith(
      expect.objectContaining({
        templateName: "booking-bumped",
        deliveryAddress: "owner@example.org",
        recipient: { kind: "member", memberId: "mem_owner" },
      }),
    );
  });

  it.each([
    ["another template", { ...ROW, templateName: "booking-modified" }],
    ["a row with no booking", { ...ROW, bookingId: null }],
  ])("returns no attachment for %s, without reading anything", async (_label, row) => {
    await expect(retryCalendarRemovalAttachments(row)).resolves.toEqual([]);
    expect(mocks.emailLogFindFirst).not.toHaveBeenCalled();
  });

  it("returns no attachment where the member was never offered an entry", async () => {
    mocks.emailLogFindFirst.mockResolvedValue(null);
    await expect(retryCalendarRemovalAttachments(ROW)).resolves.toEqual([]);
  });
});
