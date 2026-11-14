"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Mail } from "lucide-react";
import { useConfirm } from "@/components/confirm-dialog";
import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import {
  BOOKING_FRESH_COPY_ANCHOR,
  BOOKING_FRESH_COPY_LABELS,
  type BookingFreshCopyTemplate,
} from "@/lib/booking-fresh-email-copy-templates";

export type BookingFreshCopyPanelOption = {
  template: BookingFreshCopyTemplate;
  unavailableReason: string | null;
  unarchivedFailureCount: number;
};

/**
 * "Send a fresh copy" for the booking emails whose bodies are never kept: the
 * confirmation, the pre-arrival reminder and the split guests' payment link.
 *
 * The officer picks the email and nothing else — the server renders it again
 * from the booking as it is now and sends it to the booking's current owner.
 * The button disables while a send is in flight, and every refusal is shown
 * verbatim, so a withheld or failed send never reads as sent.
 */
export function BookingFreshEmailCopiesPanel({
  bookingId,
  options,
  canEdit,
}: {
  bookingId: string;
  options: BookingFreshCopyPanelOption[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const { confirm, confirmDialog } = useConfirm();
  const [busy, setBusy] = useState<BookingFreshCopyTemplate | null>(null);
  const [results, setResults] = useState<
    Partial<Record<BookingFreshCopyTemplate, { ok: boolean; message: string }>>
  >({});

  async function send(template: BookingFreshCopyTemplate) {
    const labels = BOOKING_FRESH_COPY_LABELS[template];
    const confirmed = await confirm({
      title: `Send a fresh ${labels.title.toLowerCase()}?`,
      description:
        template === "split-guest-payment-link"
          ? "A new payment link is created and emailed. Any link sent before stops working."
          : "The email is rendered again from the booking as it is now and sent to the booking's owner.",
      confirmLabel: "Send",
    });
    if (!confirmed) return;

    setBusy(template);
    setResults((current) => ({ ...current, [template]: undefined }));
    try {
      const res = await fetch(`/api/admin/bookings/${bookingId}/fresh-email-copy`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ template }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "The fresh copy could not be sent.");
      }
      const archived =
        data.archivedFailureCount > 0
          ? ` ${data.archivedFailureCount} earlier failed ${data.archivedFailureCount === 1 ? "copy was" : "copies were"} archived.`
          : "";
      const warning = data.warning ? ` ${data.warning}` : "";
      setResults((current) => ({
        ...current,
        [template]: {
          ok: true,
          message: `Sent to ${data.sentTo || "the booking's owner"}.${archived}${warning}`,
        },
      }));
      router.refresh();
    } catch (err) {
      setResults((current) => ({
        ...current,
        [template]: {
          ok: false,
          message: err instanceof Error ? err.message : "The fresh copy could not be sent.",
        },
      }));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section
      id={BOOKING_FRESH_COPY_ANCHOR}
      aria-labelledby={`${BOOKING_FRESH_COPY_ANCHOR}-heading`}
      className="scroll-mt-24 rounded-lg border bg-card p-4 space-y-3"
    >
      {confirmDialog}
      <div className="flex items-start gap-2">
        <Mail className="mt-0.5 h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <div>
          <h2 id={`${BOOKING_FRESH_COPY_ANCHOR}-heading`} className="font-semibold">
            Send a fresh copy of a booking email
          </h2>
          <p className="text-sm text-muted-foreground">
            These emails carry a door code or a payment link, so the club never keeps
            them and a failed one is not retried. A fresh copy is a new message built
            from the booking as it is now — current owner, lodge details and
            payment state — never the old one.
          </p>
        </div>
      </div>
      {/* #2160: the view-only reason is stated once here, ahead of the buttons. */}
      <AdminViewOnlySectionBanner canEdit={canEdit}>
        Your admin role can view bookings but cannot send booking emails. Bookings
        edit access is required.
      </AdminViewOnlySectionBanner>
      <ul className="divide-y rounded-md border">
        {options.map((option) => {
          const labels = BOOKING_FRESH_COPY_LABELS[option.template];
          const result = results[option.template];
          return (
            <li
              key={option.template}
              className="flex flex-col gap-2 p-3 sm:flex-row sm:items-start sm:justify-between"
            >
              <div className="min-w-0 space-y-1">
                <p className="text-sm font-medium">{labels.title}</p>
                <p className="text-sm text-muted-foreground">{labels.description}</p>
                {option.unarchivedFailureCount > 0 ? (
                  <p className="text-sm text-warning-11">
                    {option.unarchivedFailureCount === 1
                      ? "1 earlier copy failed and was never delivered."
                      : `${option.unarchivedFailureCount} earlier copies failed and were never delivered.`}
                  </p>
                ) : null}
                {option.unavailableReason ? (
                  <p className="text-sm text-muted-foreground">
                    Not available: {option.unavailableReason}
                  </p>
                ) : null}
                {result ? (
                  <p
                    role="status"
                    className={result.ok ? "text-sm text-success-11" : "text-sm text-destructive"}
                  >
                    {result.message}
                  </p>
                ) : null}
              </div>
              <ViewOnlyActionButton
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                canEdit={canEdit}
                describeReason={false}
                disabled={busy !== null || option.unavailableReason !== null}
                onClick={() => send(option.template)}
              >
                {busy === option.template ? "Sending..." : labels.actionLabel}
              </ViewOnlyActionButton>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
