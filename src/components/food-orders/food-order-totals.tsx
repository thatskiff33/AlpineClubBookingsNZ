"use client";

import { useClubFormat } from "@/components/club-format-provider";
import { Card, CardContent } from "@/components/ui/card";
import { formatCents } from "@/lib/utils";

/**
 * The food-order totals panel (fork #121).
 *
 * The headline is the whole filter: the order count, the total of recorded
 * prices, and how many are priced when not all are. Below it, the same figures
 * by calendar year of the needed-by date (owner, 13 Nov 2026): the club's
 * current year and any later years openly, earlier years inside a "Previous
 * years" disclosure that starts closed, newest first. Every figure is computed
 * by the server over the whole filter, not just the page shown.
 */

export type FoodOrderYearTotalView = {
  year: number;
  orderCount: number;
  pricedCount: number;
  priceTotalCents: number;
};

function pricedNote(pricedCount: number, orderCount: number): string {
  return pricedCount < orderCount ? ` (${pricedCount} of ${orderCount} priced)` : "";
}

function YearRow({ total }: { total: FoodOrderYearTotalView }) {
  const format = useClubFormat();
  return (
    <li className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
      <span className="w-12 font-medium">{total.year}</span>
      <span>
        {total.orderCount} {total.orderCount === 1 ? "order" : "orders"}
      </span>
      <span>
        {formatCents(total.priceTotalCents, format)}
        {pricedNote(total.pricedCount, total.orderCount)}
      </span>
    </li>
  );
}

export function FoodOrderTotals({
  orderCount,
  pricedCount,
  priceTotalCents,
  yearTotals,
  currentYear,
  officerLabel,
}: {
  orderCount: number;
  pricedCount: number;
  priceTotalCents: number;
  yearTotals: readonly FoodOrderYearTotalView[];
  currentYear: number;
  officerLabel: string;
}) {
  const format = useClubFormat();
  const current = yearTotals.filter((total) => total.year >= currentYear);
  const previous = yearTotals.filter((total) => total.year < currentYear);

  return (
    <Card>
      <CardContent className="space-y-3 pt-6 text-sm">
        <div className="flex flex-wrap gap-6" role="status">
          <span>
            <strong>{orderCount}</strong> {orderCount === 1 ? "order" : "orders"}
          </span>
          <span>
            Recorded prices: <strong>{formatCents(priceTotalCents, format)}</strong>
            {pricedNote(pricedCount, orderCount)}
          </span>
          <span className="text-muted-foreground">
            New orders are emailed to the club&apos;s {officerLabel}.
          </span>
        </div>

        {yearTotals.length > 0 ? (
          <section aria-labelledby="food-order-years" className="space-y-2 border-t pt-3">
            <h2 id="food-order-years" className="text-sm font-semibold">
              By year
            </h2>
            {current.length > 0 ? (
              <ul className="space-y-1">
                {current.map((total) => (
                  <YearRow key={total.year} total={total} />
                ))}
              </ul>
            ) : null}
            {previous.length > 0 ? (
              <details>
                <summary className="cursor-pointer font-medium">
                  Previous years ({previous.length})
                </summary>
                <ul className="mt-2 space-y-1">
                  {previous.map((total) => (
                    <YearRow key={total.year} total={total} />
                  ))}
                </ul>
              </details>
            ) : null}
          </section>
        ) : null}
      </CardContent>
    </Card>
  );
}
