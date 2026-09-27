"use client";

import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatCents } from "@/lib/utils";
import { useClubFormat } from "@/components/club-format-provider";
import type { GroupSettlementInvoiceDisplay } from "@/lib/group-settlement-invoice-binding";

/**
 * #3642 (`INV-PAY-105`): the organiser's outstanding combined Internet Banking
 * invoice. Split from `organiser-group-booking-card.tsx`.
 *
 * It says where the invoice has got to — being prepared, failed, raised or
 * actually emailed — so it never claims "emailed" before it was. It names the
 * joiners who are not on it (they joined after it went out) and says when the
 * group's total has moved, and offers an updated invoice rather than telling
 * the organiser to pay one that would leave someone unpaid for.
 */
export function PendingGroupInvoice({
  reference,
  amountCents,
  display,
  notOnInvoice,
  totalChanged,
  busy,
  onSendUpdated,
  invoiceSentDescription,
}: {
  reference: string;
  amountCents: number | null;
  display: GroupSettlementInvoiceDisplay;
  /** Names of joiners not on this invoice. */
  notOnInvoice: string[];
  /** The committed joiners no longer total the invoice. */
  totalChanged: boolean;
  busy: boolean;
  onSendUpdated: () => void;
  /** The club's "invoice sent" message, already rendered. */
  invoiceSentDescription: string;
}) {
  const format = useClubFormat();
  const changed = notOnInvoice.length > 0 || totalChanged;
  const heading =
    display === "emailed"
      ? "Invoice emailed"
      : display === "raised"
        ? "Invoice raised"
        : display === "failed"
          ? "Your invoice hasn't been sent yet"
          : "Your invoice is being prepared";

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2 text-success-11">
        <Check className="h-5 w-5 shrink-0" />
        <p className="text-sm font-medium">
          {heading}
          {amountCents != null ? ` — ${formatCents(amountCents, format)}` : ""}.
        </p>
      </div>
      {display === "preparing" ? (
        <p className="text-sm text-muted-foreground">It will be emailed to you shortly.</p>
      ) : null}
      {display === "raised" ? (
        <p className="text-sm text-muted-foreground">
          If it hasn&apos;t reached your inbox, pay using the reference below or contact the club.
        </p>
      ) : null}
      {changed || display === "failed" ? (
        <div className="space-y-2 rounded-md border border-warning-6 bg-warning-3 p-3 text-sm text-warning-11">
          {notOnInvoice.length > 0 ? (
            <p>
              Not on this invoice: {notOnInvoice.join(", ")}. They joined after it was sent, so
              their places are not confirmed yet.
            </p>
          ) : null}
          {totalChanged ? (
            <p>Your group&apos;s total has changed since this invoice was prepared.</p>
          ) : null}
          {changed ? (
            <p>
              Send an updated invoice for everyone. The current one will be cancelled, so
              don&apos;t pay it.
            </p>
          ) : (
            <p>Something went wrong preparing it. You can try again.</p>
          )}
          <Button type="button" variant="outline" onClick={onSendUpdated} disabled={busy}>
            {busy ? "Preparing..." : changed ? "Send an updated invoice" : "Try again"}
          </Button>
        </div>
      ) : null}
      {display === "emailed" || display === "raised" ? (
        <p className="text-sm text-muted-foreground">{invoiceSentDescription}</p>
      ) : null}
      <div className="rounded-md border border-border p-3 text-sm">
        <p className="font-medium text-foreground">Payment reference</p>
        <p className="mt-1 font-mono text-foreground">{reference}</p>
      </div>
    </div>
  );
}

/** #3642: joiners who joined after the group was paid, never hidden. */
export function NotPaidForYetNotice({ names }: { names: string[] }) {
  return (
    <p className="text-sm text-warning-11">
      Not paid for yet: {names.join(", ")}. They joined after your payment, so their places are
      not confirmed. Contact the club to pay for them.
    </p>
  );
}

/** #3642: the last invoice could not be raised; card still works. */
export function InvoiceBlockedNotice() {
  return (
    <p role="status" className="text-sm text-warning-11">
      We couldn&apos;t prepare an invoice for your group because a booking&apos;s prices need
      checking. The club has been told and will sort it out. You can pay by card in the meantime.
    </p>
  );
}
