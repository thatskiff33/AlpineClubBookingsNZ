"use client";

import { useCallback, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AdditionalPaymentCard, type AdditionalPaymentCardDisplay } from "@/components/additional-payment-card";
import { Button } from "@/components/ui/button";
import { bindClubFormat } from "@/lib/club-format-bound";
import type { ClubFormat } from "@/lib/club-format";
import { bindClubTime, type ClubTimeZone } from "@/lib/club-time";
import { isAdditionalPaymentDoorOpenForBooking } from "@/lib/additional-payment-chase";
import { hasOutstandingCollectionEvidence, type BookingOutstandingPaymentView } from "@/lib/booking-outstanding-payment";

export function BookingOutstandingPayments({ bookingId, initial, format, zone }: {
  bookingId: string;
  initial: BookingOutstandingPaymentView;
  format: ClubFormat;
  zone: ClubTimeZone;
}) {
  const [view, setView] = useState(initial);
  const [cardDisplay, setCardDisplay] = useState<{ revision: string | null; display: AdditionalPaymentCardDisplay } | null>(null);
  const cardRevision = view.kind === "ready" ? view.cardRevision : null;
  const onCardDisplay = useCallback((display: AdditionalPaymentCardDisplay) => setCardDisplay({ revision: cardRevision, display }), [cardRevision]);
  // A replacement ask starts unknown; an old intent's projection cannot label it.
  const currentCard = cardDisplay?.revision === cardRevision ? cardDisplay?.display : null;
  const [continuationFailed, setContinuationFailed] = useState(false);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const money = bindClubFormat(format);
  const club = bindClubTime(zone, format);
  if (view.kind === "hidden") return null;
  if (continuationFailed) return (
    <div className="space-y-2 rounded-md border border-warning-6 bg-warning-3 px-4 py-3 text-sm text-warning-11" role="alert">
      <p>More invoices could not be checked. Current payment information needs to be checked again before using the payment controls.</p>
      {currentCard?.kind === "payable" ? <p>The last checked additional card amount was {money.cents(currentCard.amountCents)}. Its current payment status could not be confirmed.</p>
        : view.cardDueCents > 0 && currentCard?.kind !== "paid" && currentCard?.kind !== "processing" ? <p>Our records last listed an additional card amount of {money.cents(view.cardDueCents)}. Its current payment status could not be confirmed.</p> : null}
      <Button variant="outline" disabled={pending} onClick={() => startTransition(() => router.refresh())}>
        {pending ? "Checking…" : "Check current payment information"}
      </Button>{" "}
      <a className="underline" href={`/bookings/${bookingId}`}>Reload this booking</a>
    </div>
  );
  const hasEvidence = hasOutstandingCollectionEvidence(view);
  const showInvoices = view.observations.length > 0;
  if (!hasEvidence && !showInvoices) return null;
  return (
    <div className="space-y-3" data-testid="booking-outstanding-payments">
      <div className="space-y-2 rounded-md border border-warning-6 bg-warning-3 px-4 py-3 text-sm text-warning-11">
        <p className="font-medium">{currentCard?.kind === "payable" || view.observations.some((row) => row.kind === "payable") ? "Additional payment outstanding" : "Additional payment information"}</p>
        {view.cardDueCents > 0 ? view.audience === "officer" ? <p>Our records list an additional card amount of <strong>{money.cents(view.cardDueCents)}</strong>. The member checks the current amount and pays by card on their booking page.</p>
          : currentCard?.kind === "payable" ? <p>You have an additional card payment of <strong>{money.cents(currentCard.amountCents)}</strong> due. <a className="font-medium underline" href="#additional-payment">Pay the additional amount by card below.</a></p>
            : currentCard?.kind === "paid" || currentCard?.kind === "processing" ? <p>{currentCard.message}</p>
              : currentCard?.kind === "unavailable" ? <p>Our records list an additional card amount of <strong>{money.cents(view.cardDueCents)}</strong>. Current payment details could not be confirmed; see the payment information below.</p>
                : <p>Checking current additional card payment details…</p> : null}
        {view.observations.map((row) => <div key={row.invoiceId} className="space-y-1">
          {row.kind === "payable" ? <>
            <p><strong>{money.cents(row.dueCents)}</strong> remained due on supplementary invoice <strong>{row.invoiceNumber}</strong>.</p>
            <p>{view.audience === "owner" ? "Pay" : "The member pays"} by internet banking using the bank details on that invoice and reference <strong>{row.invoiceNumber}</strong>.</p>
            {row.reference ? <p>Invoice reference: {row.reference}</p> : null}
          </> : row.kind === "settled" ? <p>Supplementary invoice {row.invoiceNumber} had no remaining amount due.</p>
            : row.kind === "retired" ? <p>Supplementary invoice {row.invoiceNumber} has been withdrawn. Any replacement amount and payment instructions cannot yet be confirmed.</p>
              : <p>The remaining additional amount and payment instructions cannot yet be confirmed.</p>}
          <p className="text-xs">Checked {club.instantDateTime(new Date(row.observedAt))}.</p>
        </div>)}
        {view.incomplete ? <p>Some additional amounts and payment instructions cannot yet be confirmed.{" "}
          <a className="underline" href={`/bookings/${bookingId}`}>Check this booking again</a>, or contact the club if you need help.</p> : null}
        {view.nextCursor ? <>
          <p>There are more supplementary invoices to check. These individual observations cover only the invoices checked so far.</p>
          <Button variant="outline" disabled={pending} onClick={() => startTransition(async () => {
            try {
              const response = await fetch(`/api/bookings/${encodeURIComponent(bookingId)}/additional-payment-observations?${new URLSearchParams({ cursor: view.nextCursor! })}`, { cache: "no-store" });
              if (!response.ok) throw new Error("Invoice observations unavailable");
              const next: BookingOutstandingPaymentView = await response.json();
              setView(next.kind === "ready" && next.revision === view.revision
                ? { ...next, observations: [...view.observations, ...next.observations].filter((row, index, rows) => rows.findIndex((other) => other.invoiceId === row.invoiceId) === index) }
                : next);
            } catch {
              // Transport failure gives no new card authority. Retain its last
              // observation and wait for an explicit retry before another read.
              setContinuationFailed(true);
            }
          })}>{pending ? "Checking…" : "Check more invoices"}</Button>
        </> : null}
      </div>
      {view.audience === "owner" && view.cardDueCents > 0 &&
        isAdditionalPaymentDoorOpenForBooking({ bookingStatus: view.bookingStatus, bookingDeletedAt: null }) && (
          <div id="additional-payment" className="scroll-mt-20">
            <AdditionalPaymentCard key={view.cardRevision} bookingId={bookingId} additionalAmountCents={view.cardDueCents} askCause={view.askCause} onDisplayChange={onCardDisplay} />
          </div>
        )}
    </div>
  );
}
