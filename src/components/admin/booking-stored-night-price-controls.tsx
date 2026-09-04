"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { FieldHint, useFieldHint } from "@/components/ui/field-hint";
import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import {
  parseNightInput,
  UnpricedNightPriceFields,
} from "@/components/admin/unpriced-night-price-fields";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import { EDIT_FINANCIAL_REVIEW_CAUSE_LABEL } from "@/lib/edit-financial-review-context";
import { formatClubDate } from "@/lib/club-time";
import { formatCents } from "@/lib/utils";
import {
  checkStoredNightPriceRepair,
  nightPriceRepairUnreadableMessage,
  unpricedNightTargetCents,
  unreconciledStrandExplanation,
  STORED_NIGHT_PRICE_RECORD_CONTROL_LABEL,
  type NonEmptyDates,
  type RecordedNightPrice,
  type StoredNightPriceRepairCheck,
  type StrandNightPriceOffer,
} from "@/lib/stored-night-price-repair";

// Mirrors MANUAL_PAYMENT_NOTE_MAX in src/lib/manual-subscription-payment.ts,
// which cannot be imported here: that module is `server-only`. The same mirror
// the three sibling note fields on this card and the refund queue carry, and
// the route enforces the real cap — without it the officer can type past a
// limit the screen never mentions and gets back a generic refusal.
const NOTE_MAX_LENGTH = 500;

/**
 * #3214 (epic #2797): the officer's control for recording what one guest's
 * nights sold for, on the booking's own page.
 *
 * ## Why it is on this page and names the guest
 *
 * The finance queue's review payload deliberately REDACTS the guest-strand id,
 * because a finance-only admin reading that queue may have no way to open the
 * booking at all and has no use for the identifier. Here the opposite holds in
 * both directions: this card renders behind the booking page's own admin-tools
 * gate, so the viewer already sees every guest on the booking by name - and they
 * have to know WHOSE stay they are pricing, because the amounts differ per
 * person and there is no other way to tell two strands apart. Naming the strand
 * is therefore correct here and would be wrong there. Written down because a
 * later reader comparing the two surfaces would otherwise "fix" this one back.
 *
 * ## What it deliberately does NOT do
 *
 * IT NEVER FILLS A BOX IN, and it has nothing that could: no even split, no rate
 * lookup, no remainder control, no default and no placeholder that reads as a
 * value. `stored-night-price-repair-census.test.ts` scans this file for a
 * division, a rounding, a `split*` helper, an averaging pass and a defaulted
 * zero; the half a regex cannot see - a control that posts a complete,
 * reconciling vector the checker is obliged to accept - is covered by this
 * component's own behaviour test.
 *
 * ## What the officer is promised, and why it is true
 *
 * That recording these amounts cannot change what anybody owes. That is
 * arithmetic rather than a policy the screen is being trusted to keep: the
 * server asks for every night the strand holds and forces them to sum to what
 * the stay is ALREADY stored as being worth, so the total it writes back is the
 * number already there. The server re-derives all of it - the strand, its
 * nights, its eligibility - so nothing on this screen is load-bearing for
 * safety; it is here so the officer sees the refusal before they post rather
 * than after.
 */

/**
 * What is on file for a night now.
 *
 * "No stored price" and "$0.00" RENDER DIFFERENTLY, and that distinction is the
 * whole reason this exists rather than a `formatCents` call: zero is a real sold
 * price - a comped night - and an absence is not a price at all. The finance
 * queue's evidence block makes the same distinction for the same reason.
 */
function formatStoredNightPrice(priceCents: number | null): string {
  return priceCents === null ? "no stored price" : formatCents(priceCents);
}

/**
 * One strand's boxes, its verdict and its submit.
 *
 * A COMPONENT PER STRAND rather than one form over all of them, because the
 * server settles one strand at a time: a booking with two unreadable strands is
 * two separate acts, each with its own total to reconcile to, and a single form
 * would let an officer believe one press covered both.
 */
function StrandNightPriceForm({
  bookingId,
  offer,
  canEdit,
}: {
  bookingId: string;
  offer: StrandNightPriceOffer;
  canEdit: boolean | undefined;
}) {
  const router = useRouter();
  const [inputs, setInputs] = useState<Readonly<Record<string, string>>>({});
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const noteHint = useFieldHint();

  /*
    Derived exactly as the settle screen derives it, through the SAME shared
    checker the server runs on the same input (`INV-SSOT`), so this screen can
    never enable a button the server then refuses. The one difference is the
    delta: nothing is being settled here, so it is a literal zero rather than a
    figure the officer supplies - which is what makes the target the stay's
    stored total flat.
  */
  const entries: RecordedNightPrice[] = [];
  let unreadableDates: NonEmptyDates | null = null;
  let boxesTyped = 0;
  for (const date of offer.summary.dates) {
    const raw = inputs[date] ?? "";
    if (raw.trim() === "") continue;
    boxesTyped += 1;
    const cents = parseNightInput(raw);
    if (cents === null) {
      unreadableDates =
        unreadableDates === null ? [date] : [...unreadableDates, date];
    } else entries.push({ date, priceCents: cents });
  }
  const check: StoredNightPriceRepairCheck | null =
    boxesTyped === 0
      ? null
      : unreadableDates !== null
        ? {
            ok: false,
            message: nightPriceRepairUnreadableMessage(unreadableDates),
            // The ONE definition of what the nights must come to, shared with
            // the checker rather than restated for this branch.
            targetCents: unpricedNightTargetCents(offer.summary, 0),
          }
        : checkStoredNightPriceRepair({
            summary: offer.summary,
            entries,
            deltaCents: 0,
          });

  async function submit() {
    setSubmitting(true);
    try {
      const response = await fetch(
        `/api/admin/bookings/${bookingId}/stored-night-prices`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            bookingGuestId: offer.bookingGuestId,
            confirmed: true,
            note: note.trim() || null,
            // Sent only on the ok branch, which is also the only branch the
            // button is armed on. A partial or unreadable answer is never
            // posted.
            nightPrices: check?.ok ? check.entries : [],
          }),
        },
      );
      const data = (await response.json().catch(() => null)) as
        | { error?: string; message?: string }
        | null;
      if (!response.ok) {
        toast.error(data?.error ?? "Those night prices could not be recorded.");
        return;
      }
      toast.success(data?.message ?? "Done.");
      setInputs({});
      setNote("");
      router.refresh();
    } catch {
      toast.error(
        "Those night prices may not have been recorded - the request did not complete. Reload the page and check the booking before trying again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="space-y-3 rounded-md border border-border px-3 py-3"
      data-testid="stored-night-price-strand"
      data-booking-guest-id={offer.bookingGuestId}
    >
      <p className="text-sm font-medium text-foreground">{offer.guestName}</p>
      <p className="text-xs text-muted-foreground">
        {EDIT_FINANCIAL_REVIEW_CAUSE_LABEL[offer.cause]}
      </p>
      <p className="text-xs text-muted-foreground">
        On file now:{" "}
        {offer.storedByDate
          .map(
            (night) =>
              `${formatClubDate(night.date)} ${formatStoredNightPrice(night.priceCents)}`,
          )
          .join(" · ")}
      </p>
      <UnpricedNightPriceFields
        summary={offer.summary}
        values={inputs}
        onChange={(date, value) =>
          setInputs((current) => ({ ...current, [date]: value }))
        }
        // There is no settlement to wait on, so what these have to come to is
        // known from the moment the section renders.
        targetKnown
        check={check}
        explanation={unreconciledStrandExplanation(offer.summary)}
        legend="What did this guest's nights sell for?"
        disabled={submitting || canEdit !== true}
      />
      <div className="space-y-1">
        <Label
          htmlFor={`stored-night-price-note-${offer.bookingGuestId}`}
          className="text-sm font-normal"
        >
          Note (optional)
        </Label>
        <Textarea
          id={`stored-night-price-note-${offer.bookingGuestId}`}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          disabled={submitting || canEdit !== true}
          rows={2}
          maxLength={NOTE_MAX_LENGTH}
          {...noteHint.fieldProps}
        />
        <FieldHint {...noteHint.hintProps}>
          Where these figures came from - the quote, the email, the receipt book.
          Kept with the club&apos;s records.
        </FieldHint>
      </div>
      <ViewOnlyActionButton
        canEdit={canEdit}
        size="sm"
        // The canonical settings pattern: the view-only reason is stated ONCE,
        // by the `AdminViewOnlySectionBanner` at the head of this section, which
        // is in this same file. A disabled button is out of the tab order and
        // its `title` never fires, so repeating it here would be saying it in
        // the one place nobody reads it.
        describeReason={false}
        disabled={submitting || check?.ok !== true}
        onClick={submit}
      >
        {/*
          The one home for this name is the client-safe rules module, because
          the other-lodge parking refusal quotes it to tell an officer where to
          go. Renaming the button alone would send them looking for a control
          that does not exist.
        */}
        {STORED_NIGHT_PRICE_RECORD_CONTROL_LABEL}
      </ViewOnlyActionButton>
    </div>
  );
}

/**
 * The section on the booking's Admin tools card.
 *
 * Rendered by the page only when the server found at least one strand to offer,
 * so this component never has to decide whether the act is available - it is a
 * question with a server-side answer, and asking it twice is how a screen offers
 * work the route refuses.
 */
export function BookingStoredNightPriceControls({
  bookingId,
  offers,
}: {
  bookingId: string;
  offers: readonly StrandNightPriceOffer[];
}) {
  // The route is FINANCE-gated (the bookings-shaped path is deliberately
  // overridden in SPECIAL_ROUTE_AREA_PATTERNS), so the affordance follows
  // finance:edit, not bookings:edit - the same reasoning the manual payment
  // controls on this card record.
  const canEdit = useAdminAreaEditAccess("finance");
  if (offers.length === 0) return null;

  return (
    <div
      className="space-y-3 rounded-md border border-warning-6 bg-warning-3 px-3 py-2"
      data-testid="stored-night-price-controls"
    >
      <p className="text-sm font-medium text-warning-11">
        Nights whose sold price the records cannot tell us
      </p>
      <p className="text-xs text-warning-11">
        Until these are recorded, every change to this booking has to be priced
        by hand, and an other-club member rate cannot be set on it. Recording
        them does not move any money: the figures have to come to what each stay
        is already stored as being worth.
      </p>
      <AdminViewOnlySectionBanner canEdit={canEdit} />
      {offers.map((offer) => (
        <StrandNightPriceForm
          key={offer.bookingGuestId}
          bookingId={bookingId}
          offer={offer}
          canEdit={canEdit}
        />
      ))}
    </div>
  );
}
