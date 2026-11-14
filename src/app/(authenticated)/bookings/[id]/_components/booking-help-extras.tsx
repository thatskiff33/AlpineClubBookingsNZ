"use client";

import {
  BOOKING_STATUS_GLOSSARY,
} from "@/lib/contextual-help/booking-status-glossary";
import {
  type HelpQuestion,
  type HelpSection,
} from "@/lib/contextual-help/types";
import type { CancellationScheduleRow } from "@/lib/cancellation-schedule";
import { buildProfilePathWithReturnTo } from "@/lib/internal-return-path";
import { CANCELLATION_EXACT_AMOUNT_NOTE } from "@/components/booking/cancellation-schedule-block";
import { useHelpWidgetExtras } from "@/components/help-widget/help-widget-context";

const PROFILE_FAMILY_GROUP_RETURN_TO_BOOK = buildProfilePathWithReturnTo(
  "/book",
  "family-group",
);

/**
 * Render-null leaf that re-surfaces, through the global help widget, the four
 * blocks the retired `BookingHelpDialog` carried (#1371 F28, epic #2094 C2):
 *  (a) the booking status glossary (#1072);
 *  (b) the family-members section and its exact profile Family Group deep link;
 *  (c) the cancellation refund schedule when a payment has been captured; and
 *  (d) the plain "no payment received, no refund" guidance for an unpaid but
 *      cancellable booking (owner review of PR #1389).
 *
 * The branch logic for (c)/(d) is ported verbatim: the refund schedule shows
 * ONLY when a payment was captured, so its tier percentages never imply a refund
 * the member cannot receive; otherwise the no-refund message shows instead.
 *
 * It takes the same props the dialog took (`cancellationSchedule`,
 * `cancellationHasNoPayment`) and registers them as widget extras, deregistering
 * on unmount.
 */
export function BookingHelpExtras({
  cancellationSchedule,
  cancellationHasNoPayment = false,
}: {
  cancellationSchedule?: CancellationScheduleRow[];
  cancellationHasNoPayment?: boolean;
}) {
  const hasSchedule = Boolean(
    cancellationSchedule && cancellationSchedule.length > 0,
  );

  const sections: HelpSection[] = [
    {
      title: "Booking statuses",
      details: BOOKING_STATUS_GLOSSARY,
    },
    {
      title: "Family members on bookings",
      details: [
        "Family member missing from the quick-add list? Add or invite them in your User Profile > Family Group, then return to the booking flow.",
      ],
    },
  ];

  if (hasSchedule) {
    sections.push({
      title: "Cancellation refund schedule",
      details: [
        "How much is refunded depends on how many days before your stay you cancel:",
        ...cancellationSchedule!.map((row) => row.description),
        CANCELLATION_EXACT_AMOUNT_NOTE,
      ],
    });
  } else if (cancellationHasNoPayment) {
    sections.push({
      title: "Cancelling this booking",
      details: [
        "No payment has been received for this booking, so no refund applies if you cancel.",
      ],
    });
  }

  const questions: HelpQuestion[] = [
    {
      q: "What do the status badges mean?",
      a: "Each badge is a booking state — for example Confirmed (Unpaid) means the lodge is reserved while the emailed Xero invoice is outstanding, and Bumped means a guest was displaced when capacity changed. The full glossary is in this page's guide.",
    },
    {
      q: "A family member is missing from the quick-add list.",
      a: "Add or invite them in your profile Family Group section, then return to the booking flow.",
      link: {
        href: PROFILE_FAMILY_GROUP_RETURN_TO_BOOK,
        label: "Open Family Group in your profile",
      },
    },
  ];

  if (hasSchedule) {
    questions.push({
      q: "Will I get a refund if I cancel?",
      a: "How much is refunded depends on how many days before your stay you cancel — see the cancellation refund schedule in this page's guide. The exact amount for your booking is shown when you start the cancellation.",
    });
  } else if (cancellationHasNoPayment) {
    questions.push({
      q: "Will I get a refund if I cancel?",
      a: "No payment has been received for this booking, so no refund applies if you cancel.",
    });
  }

  useHelpWidgetExtras({ sections, questions });

  return null;
}
