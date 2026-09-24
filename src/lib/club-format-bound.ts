/**
 * The club's money and number renderings with its format already supplied
 * (stage 3 of programme #3205, #3565). INV-CONFIG-006.
 *
 * Every format-taking function in this kernel is deliberately explicit, which is
 * right at a boundary and tedious inside a component that renders fifteen
 * amounts. `bindClubFormat(format)` hands back the same operations with the
 * currency and locale closed over.
 *
 * THE SAME INTERFACE ON BOTH SIDES OF THE NETWORK. A server module gets one from
 * `clubFormat()` in `./club-format-server`, which resolves the persisted setting
 * once per render pass. A client module gets one by calling `bindClubFormat` on a
 * format it received as data — a prop, or the browser seam #3564 mounts. The
 * method names are identical, so a component that moves between server and client
 * changes the line that obtains the binding and nothing else. That sentence is
 * `bindClubTime`'s, transferred on purpose: this is the club-time kernel's shape
 * applied to the second axis, not a second design.
 *
 * A CLIENT MUST NEVER OBTAIN THE FORMAT FROM ITS OWN HOST.
 * `Intl.NumberFormat().resolvedOptions().locale` is the VIEWER's locale, and a
 * member reading the site in London must see the same club currency, the same
 * grouping and the same decimal mark as a member reading it in Ohakune. The
 * format travels as data from the server that read it — which is the rule the
 * timezone's kernel states for the same reason, and the reason `NEXT_PUBLIC_*`
 * was the wrong answer in the first place (#3205): it is inlined at BUILD time
 * into one image that serves every club.
 *
 * WHY `centsPlain` IS ABSENT, since a reader will look for it. `formatCentsPlain`
 * renders `(cents / 100).toFixed(2)` — no currency symbol, no grouping, no
 * locale — because it seeds an editable dollars input and a report line that
 * already reads as a delta. It has no format to bind, and giving it a method here
 * would advertise a dependency it does not have and invite somebody to
 * "localise" a form field's value. It stays a one-argument import from
 * `@/lib/utils`, permanently, and #3567 does not touch it.
 */

import {
  formatCompactDollarsDisplay,
  formatDollarsDisplay,
  formatFinanceNumber,
  formatFinancePercent,
  formatFinanceRatio,
  formatFinanceSignedNumber,
  formatSignedDollarsDisplay,
} from "@/lib/finance-format";
import { formatCents, formatSignedCents } from "@/lib/utils";

import type { ClubFormat } from "@/lib/club-format";

export interface BoundClubFormat {
  /** The resolved format itself, for a caller that has to pass it on. */
  readonly format: ClubFormat;
  /** Exact amount, e.g. `$1,234.56`. */
  cents(cents: number): string;
  /** Exact amount with an explicit sign, e.g. `+$25.00`; zero stays `$0.00`. */
  signedCents(cents: number): string;
  /** Whole units with separators, e.g. `$446,675`. */
  dollars(cents: number): string;
  /** Signed whole-unit delta, e.g. `+$1,204`; zero stays `$0`. */
  signedDollars(cents: number): string;
  /** Compact chart tick, e.g. `$10k`, `$1.2m`. */
  compactDollars(cents: number): string;
  /** A plain count, capped at `maximumFractionDigits` (default none). */
  number(value: number, maximumFractionDigits?: number): string;
  /** A signed plain count; zero stays `0`. */
  signedNumber(value: number): string;
  /** A proportion as a percentage to one decimal place. */
  percent(value: number): string;
  /** A two-decimal ratio, e.g. `1.35`. */
  ratio(value: number): string;
}

/** The kernel's format-taking operations, with `format` closed over. */
export function bindClubFormat(format: ClubFormat): BoundClubFormat {
  return {
    format,
    cents: (cents) => formatCents(cents, format),
    signedCents: (cents) => formatSignedCents(cents, format),
    dollars: (cents) => formatDollarsDisplay(cents, format),
    signedDollars: (cents) => formatSignedDollarsDisplay(cents, format),
    compactDollars: (cents) => formatCompactDollarsDisplay(cents, format),
    number: (value, maximumFractionDigits) =>
      formatFinanceNumber(value, format, maximumFractionDigits),
    signedNumber: (value) => formatFinanceSignedNumber(value, format),
    percent: (value) => formatFinancePercent(value, format),
    ratio: (value) => formatFinanceRatio(value, format),
  };
}
