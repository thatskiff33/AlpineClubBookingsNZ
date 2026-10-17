import { bookingOwner } from "@/lib/booking-owner";
import type { ClubFormat } from "@/lib/club-format";
import { adminCardRefundFailedAfterPaidAnotherWayTemplate } from "@/lib/email-templates/admin-card-refund-failed-after-paid-another-way";
import { emailCalendarDay } from "@/lib/email-templates-club-time";
import { renderEmailHtml } from "@/lib/email-theme";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { formatCents as formatMoneyCents } from "@/lib/utils";
import { sendUnmuteableAdminAlert } from "./admin-alerts-shared";

/**
 * #4210 (`INV-PAY-136`): a card refund Stripe failed after a "Paid another
 * way" close had already settled it - said by the failed-later writer's
 * decision (`paidAnotherWayFailedLaterNote`). Its own template and subject,
 * through the UNMUTEABLE sender (#2761, #3638): the one mail that stops a
 * person paying the member a second time, or tells them what is left to check.
 * Once per decision, after the commit that made it (`alertFailedLaterCardRefunds`).
 */
export async function alertCardRefundFailedAfterPaidAnotherWay(
  data: { bookingId: string; amountCents: number; note: string },
  format: ClubFormat,
): Promise<void> {
  const booking = await prisma.booking.findUnique({
    where: { id: data.bookingId },
    // #3369: the owner may be an Organisation; bookingOwner() reads both.
    include: { member: true, organisation: { select: { name: true, email: true } } },
  });
  if (!booking) {
    logger.warn({ bookingId: data.bookingId }, "Card refund failed-after-paid-another-way alert skipped because the booking no longer exists (#4210)");
    return;
  }
  const { member } = bookingOwner(booking);
  await sendAdminCardRefundFailedAfterPaidAnotherWayAlert(
    { ...data, memberName: `${member.firstName} ${member.lastName}`, checkIn: booking.checkIn, checkOut: booking.checkOut },
    format,
  );
}

/** The send itself, for a booking already read. */
export async function sendAdminCardRefundFailedAfterPaidAnotherWayAlert(
  data: { bookingId: string; memberName: string; checkIn: Date; checkOut: Date; amountCents: number; note: string },
  format: ClubFormat,
): Promise<void> {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const reviewUrl = `${baseUrl}/admin/stuck-states`;
  await sendUnmuteableAdminAlert({
    subject: `Card refund failed after it was paid back another way: ${data.memberName}`,
    html: await renderEmailHtml(() => adminCardRefundFailedAfterPaidAnotherWayTemplate({ ...data, reviewUrl }, format)),
    templateName: "admin-card-refund-failed-after-paid-another-way",
    templateData: {
      memberName: data.memberName,
      checkIn: emailCalendarDay(data.checkIn),
      checkOut: emailCalendarDay(data.checkOut),
      bookingId: data.bookingId,
      amount: formatMoneyCents(data.amountCents, format),
      paidAnotherWayFailedLaterNote: data.note,
      reviewUrl,
    },
    // The people who reconcile the club's money own it, as every finance alert.
    requirement: { area: "finance", level: "edit" },
  });
}
