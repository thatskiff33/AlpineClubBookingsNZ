import Link from "next/link";

import type { ClubFormat } from "@/lib/club-format";
import { NO_STORED_CURRENCY } from "@/lib/club-currency-minor-unit";

/**
 * The admin-wide warning while card payments are REFUSED (#3567 re-review, D3
 * as the owner decided: refused at payment time).
 *
 * A currency is stored that cannot be charged — a hand-edited or seeded `JPY`,
 * a `dollars`. Pages keep rendering in the fallback currency (the server's
 * `CURRENCY`, then `NZD`), but no card is charged anywhere until an
 * administrator saves a currency with two decimal places. That is a state every
 * admin has to see on every screen, not only on the setup page, because members
 * cannot pay in it. Rendered by the admin layout for every admin; the fix is a
 * Full Administrator's, which the text says.
 */
export function CardPaymentsRefusedBanner({ format }: { format: ClubFormat }) {
  if (!format.unusableStoredCurrency) return null;
  const why =
    format.unusableStoredCurrency === NO_STORED_CURRENCY
      ? "The club has no currency recorded, so no card can be charged."
      : `The club's recorded currency, "${format.unusableStoredCurrency}", cannot be charged, because it does not have two decimal places.`;
  return (
    <div
      role="alert"
      data-testid="card-payments-refused-banner"
      className="mb-6 rounded-md border border-danger-6 bg-danger-3 p-4 text-sm print:hidden"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="font-medium">
          {`Card payments are switched off. ${why} Members see amounts in ${format.currencyCode} until it is fixed, but no card can be charged. A Full Administrator must set the club's currency again.`}
        </p>
        <Link
          href="/admin/club-format"
          className="rounded-md border border-danger-7 px-3 py-2 text-sm font-semibold"
        >
          Open Club Currency &amp; Locale
        </Link>
      </div>
    </div>
  );
}
