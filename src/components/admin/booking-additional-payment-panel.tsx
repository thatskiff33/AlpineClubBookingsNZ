import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ResendAdditionalPaymentButton } from "@/components/admin/resend-additional-payment-button";
import { ADMIN_VIEW_ONLY_ACTION_REASON } from "@/hooks/use-admin-area-edit-access";
import {
  additionalPaymentAgeDays,
  isAdditionalPaymentOwed,
  type AdditionalPaymentChasePayment,
} from "@/lib/additional-payment-chase";
import { clubTime } from "@/lib/club-time/server";
import { formatCents } from "@/lib/utils";

/**
 * Admin-only view of an uncollected additional payment (#2350).
 *
 * The member-facing `AdditionalPaymentCard` is owner-only by design (#1303) — it
 * carries the member's own card-entry controls, which nobody else may operate —
 * so before this panel an admin looking at the booking saw no sign at all that
 * money was outstanding. This is the read-only counterpart: how much, how long
 * it has been owing, whether the last charge attempt failed, when the member was
 * last chased, and one button to chase them again.
 *
 * Deliberately shows nothing an admin could get wrong: it never offers to take
 * the payment, waive it, or change the booking. Collecting it stays with the
 * member (their card) or with the ordinary modification tooling.
 */
export interface BookingAdditionalPaymentPanelProps {
  bookingId: string;
  /**
   * The booking's lifecycle status. Part of the owed test, not decoration: a
   * cancelled booking keeps its delta columns, and this panel must not tell an
   * admin that a cancelled booking still owes money (or offer to chase it).
   */
  bookingStatus: string;
  payment: Pick<
    AdditionalPaymentChasePayment,
    | "additionalAmountCents"
    | "additionalPaymentStatus"
    | "additionalReminderSentAt"
    | "additionalFinalReminderSentAt"
  > | null;
  /**
   * When the current obligation was raised — the latest additional transaction's
   * creation, falling back to the payment row's own (see
   * additionalPaymentEpisodeStartedAt).
   */
  requestedOn: Date | null;
  /** Whether this admin may actually send the email (`bookings:edit`). */
  canResend: boolean;
  /** Injectable for tests; defaults to wall-clock now. */
  now?: Date;
}

/**
 * ASYNC since CT-4 (#2870, epic #2988). The two stamps below are real INSTANTS
 * and must read in the club's PERSISTED timezone (`INV-CONFIG-002`), which is a
 * server-only database read - so this server component takes the club's own
 * binding rather than the client provider's. `now` stays a bare instant: the
 * age in days is an elapsed-time COMPARISON, which needs no zone.
 */
export async function BookingAdditionalPaymentPanel({
  bookingId,
  bookingStatus,
  payment,
  requestedOn,
  canResend,
  now = new Date(),
}: BookingAdditionalPaymentPanelProps) {
  if (!isAdditionalPaymentOwed({ bookingStatus, payment }) || !payment) {
    return null;
  }

  const club = await clubTime();

  const failed = payment.additionalPaymentStatus === "FAILED";
  const lastChasedAt =
    [payment.additionalReminderSentAt, payment.additionalFinalReminderSentAt]
      .filter((stamp): stamp is Date => stamp != null)
      .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  const ageDays = requestedOn
    ? additionalPaymentAgeDays({ now, episodeStartedAt: requestedOn })
    : null;

  return (
    <Card
      className="border-warning-6 bg-warning-3"
      data-testid="additional-payment-outstanding"
    >
      <CardHeader>
        <CardTitle className="text-warning-11">
          Additional payment outstanding
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm text-warning-11">
        <p>
          A change to this booking increased the total by{" "}
          <strong>{formatCents(payment.additionalAmountCents)}</strong>, and that
          amount has not been collected.{" "}
          {failed
            ? "The last attempt to charge the member's card failed."
            : "It is still waiting for the member to pay."}
        </p>
        <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
          <div>
            <dt className="text-xs uppercase tracking-wide opacity-80">
              Amount due
            </dt>
            <dd className="font-medium tabular-nums">
              {formatCents(payment.additionalAmountCents)}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide opacity-80">
              Status
            </dt>
            <dd className="font-medium">
              {failed ? "Payment failed" : "Awaiting payment"}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide opacity-80">
              Requested
            </dt>
            <dd className="font-medium">
              {requestedOn
                ? `${club.instantDateTime(requestedOn)}${
                    ageDays != null
                      ? ` (${ageDays} day${ageDays === 1 ? "" : "s"} ago)`
                      : ""
                  }`
                : "Unknown"}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide opacity-80">
              Member last emailed
            </dt>
            <dd className="font-medium">
              {lastChasedAt ? club.instantDateTime(lastChasedAt) : "Not yet"}
            </dd>
          </div>
        </dl>
        <p>
          The member is reminded automatically while the stay is still ahead.
          Sending the request now takes the place of the reminder that was
          coming, so they get one message rather than two.
        </p>
        {canResend ? (
          <ResendAdditionalPaymentButton bookingId={bookingId} />
        ) : (
          <p className="text-sm opacity-90">{ADMIN_VIEW_ONLY_ACTION_REASON}</p>
        )}
      </CardContent>
    </Card>
  );
}
