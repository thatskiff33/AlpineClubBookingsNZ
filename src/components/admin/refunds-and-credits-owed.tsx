import {
  REFUNDS_AND_CREDITS_OWED_NOTE,
  type RefundsAndCreditsOwed,
} from "@/lib/refunds-and-credits-owed-shared";

/**
 * #3372 (owner, 7 Oct 2026): the "Refunds owed" and "Credits owed" figures
 * shown beside every Net Collected figure - the dashboard card, the Payments
 * board, Reports and the Finance dashboard - in one place, so the labels and
 * the "as at today" note cannot read differently on each. A description list,
 * so a screen reader announces each label with its amount.
 */
export function RefundsAndCreditsOwedList({
  owed,
  formatCents,
  className,
}: {
  owed: RefundsAndCreditsOwed;
  formatCents: (cents: number) => string;
  className?: string;
}) {
  return (
    <div className={className} data-testid="refunds-and-credits-owed">
      <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
        <div className="flex gap-1">
          <dt className="text-muted-foreground">Refunds owed</dt>
          <dd className="font-medium text-foreground">{formatCents(owed.refundsOwedCents)}</dd>
        </div>
        <div className="flex gap-1">
          <dt className="text-muted-foreground">Credits owed</dt>
          <dd className="font-medium text-foreground">{formatCents(owed.creditsOwedCents)}</dd>
        </div>
      </dl>
      <p className="text-xs text-muted-foreground">{REFUNDS_AND_CREDITS_OWED_NOTE}</p>
    </div>
  );
}
