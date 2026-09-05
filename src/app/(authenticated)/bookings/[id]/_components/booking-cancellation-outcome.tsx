import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatCents } from "@/lib/utils";
import { humanizeStatus, paymentStatusClass } from "@/lib/status-colors";
import type { BookingDetailRecord } from "../_lib/load-booking-detail";
import type { BookingDetailPayment } from "../_lib/booking-detail-payment";

/**
 * WHAT CANCELLATION RETURNED (#2958): the cancellation outcome card — display
 * status, what went back to the original method, what became account credit,
 * what was retained, restored credit, change fees and the latest refund appeal.
 * Figures come from the payment projection; nothing is recomputed here. Moved
 * verbatim from `page.tsx`.
 */
export function BookingCancellationOutcome({
  booking,
  payment,
}: {
  booking: BookingDetailRecord;
  payment: BookingDetailPayment;
}) {
  const {
    paymentDisplay,
    originalPaymentCaptured,
    cancellationSettlement,
    retainedAfterCancellationCents,
    latestRefundAppeal,
  } = payment;
  return (
    <>
      {booking.status === "CANCELLED" && (
        <Card id="cancellation" className="scroll-mt-20">
          <CardHeader>
            <CardTitle>Cancellation Outcome</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Badge
                className={
                  paymentDisplay
                    ? paymentStatusClass(paymentDisplay.toneStatus)
                    : "bg-muted text-muted-foreground"
                }
              >
                {paymentDisplay?.label ?? "Cancelled Before Payment"}
              </Badge>
              <p className="text-sm text-muted-foreground">
                {paymentDisplay?.detail ??
                  "No original payment was captured for this booking, so nothing needed to be returned."}
              </p>
            </div>

            <div className="grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <span className="text-muted-foreground">Original payment:</span>{" "}
                {originalPaymentCaptured && booking.payment
                  ? formatCents(booking.payment.amountCents)
                  : "No original payment captured"}
              </div>

              {originalPaymentCaptured && cancellationSettlement && (
                <>
                  <div>
                    <span className="text-muted-foreground">
                      Returned to original payment method:
                    </span>{" "}
                    {formatCents(
                      cancellationSettlement.refundToOriginalMethodCents
                    )}
                  </div>

                  <div>
                    <span className="text-muted-foreground">Held as account credit:</span>{" "}
                    {formatCents(cancellationSettlement.accountCreditCents)}
                  </div>

                  <div>
                    <span className="text-muted-foreground">
                      Non-refundable amount retained:
                    </span>{" "}
                    {formatCents(retainedAfterCancellationCents)}
                  </div>

                  {cancellationSettlement.restoredAppliedCreditCents > 0 && (
                    <div>
                      <span className="text-muted-foreground">
                        Previously applied credit restored (per the cancellation
                        policy):
                      </span>{" "}
                      {formatCents(
                        cancellationSettlement.restoredAppliedCreditCents
                      )}
                    </div>
                  )}

                  {booking.payment?.changeFeeCents
                    ? (
                    <div>
                      <span className="text-muted-foreground">
                        Included non-refundable change fees:
                      </span>{" "}
                      {formatCents(booking.payment.changeFeeCents)}
                    </div>
                      )
                    : null}
                </>
              )}

              {latestRefundAppeal && (
                <div>
                  <span className="text-muted-foreground">Latest refund appeal:</span>{" "}
                  <Badge
                    variant={
                      latestRefundAppeal.status === "PENDING"
                        ? "outline"
                        : latestRefundAppeal.status === "APPROVED"
                          ? "default"
                          : "destructive"
                    }
                    className="align-middle"
                  >
                    {humanizeStatus(latestRefundAppeal.status)}
                  </Badge>
                  {latestRefundAppeal.requestedAmountCents ? (
                    <span className="ml-2 text-muted-foreground">
                      Requested {formatCents(latestRefundAppeal.requestedAmountCents)}
                    </span>
                  ) : null}
                  {latestRefundAppeal.approvedAmountCents ? (
                    <span className="ml-2 text-muted-foreground">
                      Approved {formatCents(latestRefundAppeal.approvedAmountCents)}
                    </span>
                  ) : null}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </>
  );
}
