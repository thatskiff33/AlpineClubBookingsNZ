"use client";

import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { buildHrefWithReturnTo } from "@/lib/internal-return-path";
import {
  describeMembershipCancellationBlocker,
  describeUnpaidInvoiceBlockerParts,
  isBookingBlocker,
  isUnpaidInvoiceBlocker,
  MEMBERSHIP_CANCELLATION_BLOCKER_DETAIL_SEPARATOR,
  membershipCancellationBlockerHeading,
  membershipCancellationBlockerHint,
  type MembershipCancellationBlocker,
} from "@/lib/membership-cancellation-blocker-messages";
import {
  calendarDateOfSerialisedDbDate,
  formatClubDate,
} from "@/lib/club-time";

/**
 * Everything standing between this participant and an approval, in the server's
 * own words — and, for the Xero ones, the way out of it. A reviewer told only
 * "blocked" has nowhere to go (#2392).
 *
 * Its own component, and not a helper inside the queue page, so the panel a
 * reviewer actually reads can be tested directly rather than inferred from the
 * strings feeding it (#2392 review, L12).
 */

/** The Membership Cancellation settings page — note the singular; the queue this
 * panel appears on is the plural URL, one character apart. */
const CANCELLATION_SETTINGS_PATH = "/admin/membership-cancellation";

/**
 * Rows shown before the panel stops listing. A contact with two hundred open
 * invoices would otherwise render a two-hundred-item amber wall per participant
 * (#2392 review, L8) — and the tail is not information a reviewer can act on
 * one row at a time anyway, which is what the contact link is for.
 */
const PANEL_BLOCKER_LIMIT = 20;

/**
 * A blocker's dates are CALENDAR DAYS - a booking's `@db.Date` lodge nights and
 * an invoice due date - so they take no timezone at all (CT-4, #2870;
 * INV-DATE-010). The kernel's calendar-date formatter pins UTC over the
 * UTC-midnight encoding, which makes the projection the identity.
 *
 * WHAT THIS REPLACES read the day through a zone: the same answer for a club
 * east of Greenwich, the PREVIOUS DAY for any club west of it.
 */
function formatDateOnly(value: string) {
  return formatClubDate(calendarDateOfSerialisedDbDate(value));
}

/** Stable list key across every blocker kind. */
function blockerKey(blocker: MembershipCancellationBlocker) {
  if (blocker.type === "unpaid_invoice") {
    return `unpaid_invoice-${blocker.invoiceId}`;
  }
  if (blocker.type === "invoice_check_unavailable") {
    return `invoice_check_unavailable-${blocker.reason}`;
  }
  return `${blocker.type}-${blocker.bookingId}-${blocker.guestAppearanceId ?? "owner"}`;
}

/**
 * One blocker line. An invoice line is hyperlinked at its label — to the invoice
 * itself where Xero has a URL for it, and to the contact otherwise, which is
 * what makes a bill or an unnumbered invoice findable at all: the link is
 * computed server-side and was, until this fix, shipped to the browser and
 * never rendered (#2392 review, H1).
 */
function BlockerLine({ blocker }: { blocker: MembershipCancellationBlocker }) {
  if (!isUnpaidInvoiceBlocker(blocker)) {
    return <>{describeMembershipCancellationBlocker(blocker, { formatDate: formatDateOnly })}</>;
  }

  const { label, detail, href } = describeUnpaidInvoiceBlockerParts(blocker, {
    formatDate: formatDateOnly,
  });

  return (
    <>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="font-medium underline underline-offset-2"
        >
          {label}
        </a>
      ) : (
        <span className="font-medium">{label}</span>
      )}
      {/* The separator is the server's, imported rather than retyped, so this
          line and the refusal message cannot drift apart (#2392 review). */}
      {`${MEMBERSHIP_CANCELLATION_BLOCKER_DETAIL_SEPARATOR}${detail}`}
    </>
  );
}

/**
 * The "…and N more" line, worded for what is ACTUALLY overflowing.
 *
 * "on this contact" is true of invoices and false of bookings, and the panel
 * lists both: a participant with twenty-five future bookings would otherwise be
 * told their five hidden bookings are on a Xero contact (#2392 review,
 * residual 1). The Xero contact link is offered only when hidden INVOICES are
 * what the reviewer would find there.
 */
function describeOverflow(hidden: MembershipCancellationBlocker[]): string {
  const invoices = hidden.filter(isUnpaidInvoiceBlocker).length;
  if (invoices === hidden.length) {
    return `…and ${hidden.length} more on this contact.`;
  }
  if (hidden.every(isBookingBlocker)) {
    return `…and ${hidden.length} more future bookings or guest appearances.`;
  }
  return `…and ${hidden.length} more not shown here.`;
}

export function MembershipCancellationBlockerNotice({
  blockers,
  returnTo,
}: {
  blockers: MembershipCancellationBlocker[];
  returnTo: string;
}) {
  if (blockers.length === 0) return null;

  const hint = membershipCancellationBlockerHint(blockers);
  const shown = blockers.slice(0, PANEL_BLOCKER_LIMIT);
  const hidden = blockers.slice(PANEL_BLOCKER_LIMIT);
  // "See them all in Xero" is only an answer when what is hidden is IN Xero.
  const contactUrl =
    hidden.find(isUnpaidInvoiceBlocker)?.xeroContactUrl ?? null;

  return (
    <div className="mt-3 rounded-md border border-warning-6 bg-warning-3 p-3 text-sm text-warning-11">
      <div className="flex gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <p className="font-medium">
            {membershipCancellationBlockerHeading(blockers)}
          </p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {shown.map((blocker) => (
              <li key={blockerKey(blocker)}>
                <BlockerLine blocker={blocker} />
              </li>
            ))}
          </ul>
          {hidden.length > 0 && (
            <p className="mt-1">
              {describeOverflow(hidden)}
              {contactUrl && (
                <>
                  {" "}
                  <a
                    href={contactUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium underline underline-offset-2"
                  >
                    Open the contact in Xero
                  </a>{" "}
                  to see them all.
                </>
              )}
            </p>
          )}
          {hint && (
            <p className="mt-2">
              {hint}{" "}
              {/* The escape hatch is named in the hint but was not reachable
                  from it; the settings live one character away from this
                  queue's own URL (#2392 review, L11). */}
              <Link
                href={buildHrefWithReturnTo(CANCELLATION_SETTINGS_PATH, returnTo)}
                className="font-medium underline underline-offset-2"
              >
                Open Membership Cancellation settings
              </Link>
              .
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
