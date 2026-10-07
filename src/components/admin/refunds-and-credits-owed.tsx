import { useId } from "react";

import {
  CREDITS_OWED_LABEL,
  REFUNDS_AND_CREDITS_OWED_NOTE,
  REFUNDS_OWED_LABEL,
  type RefundsAndCreditsOwed,
} from "@/lib/refunds-and-credits-owed-shared";
import { cn } from "@/lib/utils";

/**
 * #3372 (owner, 7 Oct 2026): the "Refunds owed" and "Credits owed" figures
 * shown beside every Net Collected figure - the dashboard card, the Payments
 * board, Reports and the Finance dashboard - in one place, so the labels and
 * the "as at today" note cannot read differently on each. A description list,
 * so a screen reader announces each label with its amount, described by the
 * note (`aria-describedby`), which says they are not the page's range.
 *
 * `stacked`: one figure per line on a narrow screen, side by side and
 * right-aligned from `sm` up - for the dashboard card, where the figures sit
 * beside the headline.
 */
export function RefundsAndCreditsOwedList({
  owed,
  formatCents,
  className,
  stacked = false,
}: {
  owed: RefundsAndCreditsOwed;
  formatCents: (cents: number) => string;
  className?: string;
  stacked?: boolean;
}) {
  const noteId = useId();
  return (
    <div className={className} data-testid="refunds-and-credits-owed">
      <dl
        aria-describedby={noteId}
        className={cn(
          "flex text-sm",
          stacked
            ? "flex-col gap-y-1 sm:flex-row sm:flex-wrap sm:justify-end sm:gap-x-6"
            : "flex-wrap gap-x-6 gap-y-1",
        )}
      >
        <div className="flex gap-1">
          <dt className="text-muted-foreground">{REFUNDS_OWED_LABEL}</dt>
          <dd className="font-medium text-foreground">{formatCents(owed.refundsOwedCents)}</dd>
        </div>
        <div className="flex gap-1">
          <dt className="text-muted-foreground">{CREDITS_OWED_LABEL}</dt>
          <dd className="font-medium text-foreground">{formatCents(owed.creditsOwedCents)}</dd>
        </div>
      </dl>
      <p id={noteId} className="text-xs text-muted-foreground">
        {REFUNDS_AND_CREDITS_OWED_NOTE}
      </p>
    </div>
  );
}
