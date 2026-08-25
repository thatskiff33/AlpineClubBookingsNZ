"use client";

/**
 * What the public payment-link page SHOWS: the shape it receives on the wire,
 * its two date formatters, and the card every non-payable state renders
 * through. `page.tsx` keeps the route shell — the fetches, the state machine
 * and the Stripe handoff.
 *
 * ## Why this is a separate file
 *
 * The club-time migration (CT-4 group E, #2870; epic #2988) and the null-safety
 * hardening beside it carried `page.tsx` past the 500-line route-page budget for
 * the FIRST time, and the file-size ratchet refuses an allowance for exactly
 * that case: a module still inside its budget has the cheapest split available
 * to it, so it should take it (`docs/MAINTENANCE.md` → "File-size budget
 * ratchet", `size-allowances.d/README.md`). The seam was already here —
 * everything below sat above the page component and none of it reads the page's
 * state.
 *
 * Nothing below changed meaning in the move. The two formatters in particular
 * keep every guard they arrived with, because this page is opened by an
 * UNAUTHENTICATED visitor following an emailed link: there is no session to fall
 * back on and no way for them to recover, so an unhandled throw in a client
 * render costs them the whole payment screen over a date they were only being
 * shown for information.
 */
import { AlertTriangle, CheckCircle2, Info } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  calendarDateOfDateOnlyInstant,
  formatClubDate,
  parseInstant,
  type BoundClubTime,
} from "@/lib/club-time";

export interface Narrative {
  state: string;
  headline: string;
  message: string;
  nextStep: string;
}

export interface PaymentLinkContext {
  state: string;
  narrative: Narrative;
  firstName: string;
  payable: {
    checkIn: string;
    checkOut: string;
    guestCount: number;
    status: string;
    amountCents: number;
    internetBankingReference?: string;
    expiresAt: string;
  } | null;
  canRequestFreshLink: boolean;
  /**
   * The lodge THIS booking is at (#2919). Optional on the wire so a page served
   * from a cached/older response still renders — the club default stands in.
   */
  lodgeName?: string;
}

type Tone = "success" | "warning" | "info";

export type PaymentRecovery = {
  heading: string;
  message: string;
};

const TONE_STYLES: Record<Tone, { wrap: string; icon: typeof Info }> = {
  success: { wrap: "text-success-11", icon: CheckCircle2 },
  warning: { wrap: "text-warning-11", icon: AlertTriangle },
  info: { wrap: "text-info-11", icon: Info },
};

/**
 * One end of the stay, rendered as the CALENDAR DAY it is (CT-4, #2870; epic
 * #2988).
 *
 * `payable.checkIn`/`checkOut` are the booking's `@db.Date` lodge nights,
 * serialised by `src/lib/payment-link.ts` with `.toISOString()`. A calendar day
 * has no timezone, so this consults no zone and could not be wrong about one:
 * the kernel decodes the UTC-midnight encoding and formats it pinned to `UTC`,
 * provably the identity for every club. The legacy helper projected it through
 * `APP_TIME_ZONE`, which cancels only east of Greenwich — a club west of it
 * named the night before the stay, on the page a guest pays from.
 *
 * `parseInstant` and the raw value rather than a throw: this is a public token
 * landing page with no runtime schema check on the payload, and an unhandled throw in a client render
 * replaces the whole screen with an error boundary. THE PREVIOUS CODE THREW
 * TOO — `Intl.DateTimeFormat.format` on an invalid `Date` is a `RangeError`,
 * not the string "Invalid Date", which only `toLocaleDateString` produces — so
 * this fallback is a FIX rather than a preserved behaviour.
 */
export function formatStayDay(value: string): string {
  // NOT-A-STRING FIRST, and this order is the whole point: `parseInstant` calls
  // `value.trim()` BEFORE its own nullish check, so `parseInstant(null)` throws a
  // `TypeError` out of the guard that exists to stop a throw. The premise above
  // is that nothing validates this payload on the way in, and a missing field is
  // exactly what an unvalidated payload produces — so the guard has to cover it.
  if (typeof value !== "string") return "";
  const instant = parseInstant(value);
  if (instant === null) return value;
  try {
    return formatClubDate(calendarDateOfDateOnlyInstant(instant));
  } catch {
    return value;
  }
}

/**
 * The moment the link stops working, spelled in the CLUB's zone (CT-4, #2870;
 * INV-CONFIG-002).
 *
 * Deliberately NOT the same route as the stay dates rendered beside it: those
 * are calendar days and take no zone at all, and merging the two is the defect
 * this epic exists to end.
 *
 * ## Why the TIME is on it, and why that is a fix rather than a flourish
 *
 * This used to render the bare civil DAY. Two lines above it the stay reads
 * "Dates: 16 Apr 2026 to 18 Apr 2026", so a second bare day underneath read as
 * a restatement of the stay — and it could name a different one. `expiresAt` was
 * then minted through `APP_TIME_ZONE`, so for a club whose persisted zone is not
 * the container's the instant landed on the following civil day: a club in
 * `Pacific/Auckland` on a `TZ=UTC` host got "expires on 17 Apr 2026" beside a
 * stay starting on the 16th, and the link in fact died at 11:59 AM on the 17th.
 * A bare day therefore misstated the deadline by most of a day, in the direction
 * that costs the payer their link.
 *
 * `instantDateTime` states the moment as a moment. It also makes this page agree
 * with the email that delivered the link: `email-templates/booking-requests.ts`
 * renders the same value into the same sentence with `emailClubDateTime`, which
 * is `instantDateTime` through the same persisted zone (CT-5, #2869). This page
 * was the one surface spelling it short.
 *
 * THAT EMAIL HAS TWO RENDERERS, NOT ONE, and the second one had to be moved
 * before this paragraph was true. A club that has saved a body override gets its
 * whole message rebuilt from `templateData` by `prepareEmailMessage`, and the
 * shipped default body for both payment-link templates contains `{{expiresAt}}`
 * — so the copy in `src/lib/email/booking-requests.ts` is a real member-facing
 * rendering and not an internal detail. It went through `formatNZDateTime`, the
 * CONTAINER's zone, so on a divergent deployment an edited-wording club read a
 * different time from this page and from an unedited club. Both copies now use
 * `emailClubDateTime` (#2870), which is what lets this say "agree" without a
 * qualifier. The ~146 sibling `templateData` date sites across the email surface
 * still carry the same two-authority split and are their own census.
 *
 * THE MINT NOW AGREES, so this page states the end of the check-in day in the
 * club's own reckoning rather than a moment that merely renders faithfully. All
 * nine `src/lib` sites go through `paymentLinkExpiryForCheckIn`, which takes the
 * persisted zone (#2870). A link minted BEFORE that change keeps the instant it
 * was stored with — `INV-CONFIG-002` rewrites nothing — so on a divergent
 * deployment such a row can still render as the following civil day until it
 * lapses or is re-issued. This line reports the row faithfully either way, which
 * is the whole point of stating the moment as a moment.
 *
 * FAIL-SOFT FOR THE SAME REASON `formatStayDay` IS, which is the half that was
 * missing: this line sits nine below one whose docblock justifies its own
 * try/catch by "nothing validates this payload on the way in", and then handed
 * `new Date(...)` straight to a formatter. `Intl.DateTimeFormat.format` on an
 * invalid `Date` is a `RangeError`, and an unhandled throw in a client render
 * replaces the whole payment page with an error boundary — over a line that only
 * tells the payer when the link expires.
 */
export function formatLinkExpiry(value: string, club: BoundClubTime): string {
  if (typeof value !== "string") return "";
  const instant = parseInstant(value);
  if (instant === null) return value;
  try {
    return club.instantDateTime(instant);
  } catch {
    return value;
  }
}

export function toneForState(state: string): Tone {
  if (state === "paid") return "success";
  if (
    state === "cancelled_post_payment" ||
    state === "cancelled_pre_payment" ||
    state === "declined"
  ) {
    return "warning";
  }
  return "info";
}

export function NarrativeCard({
  narrative,
  tone,
  children,
}: {
  narrative: Narrative;
  tone: Tone;
  children?: React.ReactNode;
}) {
  const { wrap, icon: Icon } = TONE_STYLES[tone];
  return (
    <Card className="w-full max-w-lg">
      <CardHeader>
        <CardTitle>{narrative.headline}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className={`flex items-start gap-2 ${wrap}`}>
          <Icon className="h-6 w-6 shrink-0" />
          <p className="font-medium">{narrative.message}</p>
        </div>
        <p className="text-sm text-muted-foreground">{narrative.nextStep}</p>
        {children}
      </CardContent>
    </Card>
  );
}
