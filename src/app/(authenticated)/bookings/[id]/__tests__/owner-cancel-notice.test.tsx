// #3497 — the booking page tells the OWNER of a booking under review why there
// is no Cancel button, and what to do instead — in the one sentence the
// cancel-preview and cancel routes refuse with.
//
// This renders the notices component directly (it is a plain server component
// with no data loading of its own), so the assertion is on what the member sees
// rather than on source text. The one-home half is a source assertion: the
// component must draw the sentence from `memberCancelRefusal`, never restate it.
import { readFileSync } from "fs";
import path from "path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { stripComments } from "@/lib/__tests__/support/strip-comments";
import { memberCancelRefusal } from "@/lib/booking-cancel-eligibility";
import { BookingReviewNotices } from "@/app/(authenticated)/bookings/[id]/_components/booking-review-notices";
import type { BookingDetailRecord } from "@/app/(authenticated)/bookings/[id]/_lib/load-booking-detail";
import type { BookingDetailViewer } from "@/app/(authenticated)/bookings/[id]/_lib/booking-detail-viewer";
import type { BookingDetailEditAccess } from "@/app/(authenticated)/bookings/[id]/_lib/booking-detail-edit-access";
import type { BoundClubTime } from "@/lib/club-time";

const REVIEW_SENTENCE = memberCancelRefusal("AWAITING_REVIEW") as string;

const club = { instantDate: () => "1 Jul 2026" } as unknown as BoundClubTime;

function render({
  status,
  isBookingOwner,
  canCancel,
  requiresAdminReview = false,
}: {
  status: string;
  isBookingOwner: boolean;
  canCancel: boolean;
  requiresAdminReview?: boolean;
}) {
  const booking = {
    status,
    createdBy: null,
    requiresAdminReview,
    adminReviewStatus: requiresAdminReview ? "PENDING" : null,
    adminReviewReason: null,
    memberReviewJustification: null,
    adminReviewNotes: null,
    changeRequests: [],
  } as unknown as BookingDetailRecord;
  return renderToStaticMarkup(
    <BookingReviewNotices
      booking={booking}
      club={club}
      viewer={{ isBookingOwner } as unknown as BookingDetailViewer}
      access={{ canCancel } as unknown as BookingDetailEditAccess}
    />,
  );
}

describe("#3497: the owner of a booking under review is told the officer route", () => {
  it("renders the one refusal sentence for the owner of an AWAITING_REVIEW booking with no Cancel button", () => {
    const html = render({ status: "AWAITING_REVIEW", isBookingOwner: true, canCancel: false });
    expect(html).toContain('data-testid="owner-cancel-notice"');
    expect(html).toContain(REVIEW_SENTENCE);
  });

  it("renders it beneath the admin-review notice when the booking carries one", () => {
    const html = render({
      status: "AWAITING_REVIEW",
      isBookingOwner: true,
      canCancel: false,
      requiresAdminReview: true,
    });
    const notice = html.indexOf("Awaiting admin review.");
    const line = html.indexOf(REVIEW_SENTENCE);
    expect(notice).toBeGreaterThan(-1);
    expect(line).toBeGreaterThan(notice);
  });

  it("says nothing to a non-owner — an officer's door is their own review queue", () => {
    const html = render({ status: "AWAITING_REVIEW", isBookingOwner: false, canCancel: false });
    expect(html).not.toContain("owner-cancel-notice");
    expect(html).not.toContain("with the club for review");
  });

  it("says nothing on a booking the owner CAN cancel, and nothing if the rule is ever widened", () => {
    expect(render({ status: "PENDING", isBookingOwner: true, canCancel: true })).not.toContain(
      "owner-cancel-notice",
    );
    expect(render({ status: "WAITLISTED", isBookingOwner: true, canCancel: true })).not.toContain(
      "owner-cancel-notice",
    );
    // canCancel true on AWAITING_REVIEW cannot happen today; if the member set
    // ever admits it, the line must not contradict the button beside it.
    expect(
      render({ status: "AWAITING_REVIEW", isBookingOwner: true, canCancel: true }),
    ).not.toContain("owner-cancel-notice");
  });

  it("draws the sentence from the one home rather than restating it", () => {
    const source = stripComments(
      readFileSync(
        path.resolve(
          process.cwd(),
          "src/app/(authenticated)/bookings/[id]/_components/booking-review-notices.tsx",
        ),
        "utf8",
      ),
    );
    expect(source).toMatch(/memberCancelRefusal\(booking\.status\)/);
    expect(source).not.toContain("with the club for review");
  });
});
