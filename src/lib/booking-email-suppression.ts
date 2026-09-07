import { EmailLogStatus } from "@prisma/client";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { getEmailTemplateDefinition } from "@/lib/email-message-registry";

/**
 * Per-booking "No emails" switch (#2258, owner decision D10).
 *
 * A booking can be put into a state where the system withholds EVERYTHING it
 * would otherwise send about that booking: confirmation, modification, payment,
 * reminders, arrival information, cancellation, waitlist offers, chore rosters,
 * and even the invoice email Xero would send on our behalf. This module owns the
 * mechanism; the booking-page warning banner that lists what was withheld is
 * issue #2259 and reads {@link getWithheldBookingEmailSummary}.
 *
 * Three rules make this safe:
 *
 *  1. **Keyed strictly on the booking, never on the recipient address.** An
 *     address-keyed shortcut would also swallow two-factor codes, password
 *     resets, magic-link logins and email-change notices (src/lib/email/
 *     account.ts). That is account lockout, not a mail preference.
 *  2. **Admin-audience mail is never withheld.** Admin/system alerts exist so an
 *     operator finds out something went wrong; the registry's
 *     `EmailTemplateDefinition.audience` is the single source of truth
 *     (see {@link isBookingSuppressibleTemplate}).
 *  3. **The read fails CLOSED.** The SES bounce check in `email/core.ts`
 *     deliberately fails OPEN (an unreachable suppression table must not stop
 *     the club's mail). This gate is the opposite: an unreadable switch means we
 *     do not know whether the admin asked for silence, and sending anyway is the
 *     unrecoverable direction.
 */

/**
 * Booking identity for a send. A discriminated union rather than an optional
 * `bookingId?: string`, so every call site — including every future one — has to
 * state which it is and cannot silently default to "not a booking email".
 */
export type { EmailBookingContext } from "@/lib/booking-email-contract";

type EmailBookingSuppressionContext = { bookingId: string } | "none";

/**
 * Pseudo template names for the two messages XERO sends on our behalf. They are
 * not registry templates (we never render or transmit them), but a withheld one
 * still needs a name so #2259's banner can say what was held back.
 */
export const XERO_BOOKING_INVOICE_EMAIL_TEMPLATE = "xero-booking-invoice-email";
export const XERO_GROUP_SETTLEMENT_INVOICE_EMAIL_TEMPLATE =
  "xero-group-settlement-invoice-email";

/**
 * Templates that are ALWAYS about one specific booking — every wrapper that
 * emits one requires a real booking id and cannot be handed `"none"`.
 *
 * This exists for exactly one job: `EmailLog.bookingId` did not exist before the
 * #2258 migration, so every row queued by a previous release has a NULL
 * bookingId — including booking-scoped ones. Those rows are still replayable by
 * the retry cron in the window after deploy, and a NULL bookingId means the
 * cron cannot tell whether their booking is now silenced. Rather than replay
 * blind, the cron refuses to replay a NULL-bookingId row whose template is in
 * this set (see cron-email-retry.ts). The row is left FAILED, so it stays in the
 * operator's email-failure review queue rather than vanishing.
 *
 * Deliberately EXCLUDED, because they are genuinely sent before any booking
 * exists and so can never belong to a silenced one — blocking them would
 * withhold mail for no benefit:
 *   booking-request-verification, booking-request-quote,
 *   booking-request-declined, group-booking-join-verification
 * Also deliberately EXCLUDED, for a different reason worth stating (#2562):
 *   booking-policy-exception-refused — its sender's `bookingContext` is a genuine
 *   union. A refused CHANGE request hangs off a booking and passes that id, so
 *   `isBookingSuppressibleTemplate` (member audience) still lets the switch
 *   withhold it; a refused NEW-booking request has no booking at all and passes
 *   `"none"`. Naming it here would make this set's own statement false, and would
 *   also stop the retry cron replaying a failed new-booking refusal — which is
 *   precisely the message the member has no other way of receiving. The cost is
 *   that `resolveBookingEmailLink` gives it no canonical booking button, which is
 *   why its template carries none and names where to look instead.
 * Also excluded, and this is the point of naming them: every account, security,
 * membership and family template. Nothing in this set touches them.
 */
export const ALWAYS_BOOKING_SCOPED_TEMPLATE_NAMES: ReadonlySet<string> =
  new Set([
    // src/lib/email/booking.ts — every sender, all take { bookingId }
    "booking-confirmed",
    "booking-pending",
    // #2526: member-facing notice that an approved booking-policy exception has
    // created their booking. Always carries the real bookingId, so the
    // per-booking "No emails" switch withholds it like every other booking mail.
    "booking-policy-exception-approved",
    "booking-bumped",
    "booking-guests-cancelled",
    "booking-cancelled",
    "split-guest-portion-cancelled",
    "booking-review-approved",
    "booking-review-rejected",
    "checkin-reminder",
    "pre-arrival-reminder",
    "additional-payment-reminder",
    "booking-modified",
    "setup-intent-failed",
    // #3268: sibling of setup-intent-failed, sent by the auto-charge cron once
    // it has retired an unusable saved card. Same sender module, same
    // `{ bookingId, recipientMemberId }` context.
    "saved-card-charge-failed",
    // src/lib/email/waitlist.ts — a waitlist entry IS a booking row
    "waitlist-confirmation",
    "waitlist-offer",
    "waitlist-offer-expired",
    // #2649: the restored-place notice an admin's stranded-confirm repair sends.
    // Same sender module, same `{ bookingId, recipientMemberId }` context as its
    // three siblings — a waitlist entry IS a booking row — so the per-booking
    // "No emails" switch withholds it and the retry cron refuses to replay a
    // legacy NULL-bookingId row under this name.
    "waitlist-place-restored",
    // src/lib/email/chores.ts — ChoreAssignment.bookingId is NOT NULL
    "chore-roster",
    // Union-typed wrappers whose every call site passes a real booking id
    "booking-request-approved",
    "split-guest-payment-link",
    "booking-request-payment-expired",
    "school-attendee-confirmation",
    // #2550: the whole-lodge guest-name reminder. Always about one converted
    // booking (the cron reads it off `BookingRequest.convertedBooking`), so the
    // per-booking "No emails" switch withholds it like every other reminder.
    "whole-lodge-guest-names-reminder",
    "group-settlement-receipt",
    "group-join-settled",
    "group-settlement-expired",
    "group-join-released",
    "group-join-cancelled",
    // Admin refund-appeal outcome, sent to the member about their booking.
    // #2321 split one combined template into one per outcome; BOTH stay
    // booking-scoped, so the per-booking "No emails" switch still withholds
    // them and the retry cron still refuses to replay a NULL-bookingId row.
    "refund-request-approved",
    "refund-request-declined",
    // Retired by #2321 but RETAINED here on purpose. This set's one job (see
    // above) is the NULL-bookingId legacy window: a fork that jumps several
    // releases in one deploy can still hold pre-#2258 FAILED rows queued under
    // the old combined name, with no bookingId to check the "No emails" switch
    // against. The retry cron's set membership check (cron-email-retry.ts:128)
    // is what refuses to replay those rows blind — the fail-closed audience
    // gate in isBookingSuppressibleTemplate does not cover them, because an
    // unregistered name only reaches that gate when a caller supplies a REAL
    // bookingId, and these rows by definition have none. No live sender uses
    // this name, so the entry can never withhold current mail.
    "refund-request-resolved",
    // src/lib/email/member-guest.ts (#2307, #2309) — all six take { bookingId }. A
    // member-guest consent request, notice, outcome or lapse notice cannot exist
    // without the booking the guest row hangs off, so `"none"` is not offered by
    // any of the six wrappers. They are member-audience for a load-bearing
    // reason (see isBookingSuppressibleTemplate below): owner decision D-16 has
    // them ignore the per-action notify tick and the member's own notification
    // preferences, so this switch is the ONLY thing that withholds them, and an
    // admin-audience classification would let a silenced booking mail out.
    "member-guest-consent-request",
    "member-guest-added",
    "member-guest-consent-outcome",
    "member-guest-consent-answered",
    "member-guest-consent-expired",
    // MG4 (#2309). Named here for the same reason as the other five, and the
    // reason bites hardest on this one: it tells a member they are OFF a
    // booking. A silenced booking must withhold it — and then say so on the
    // withheld-banner record, so an operator can see that somebody was never
    // told, rather than the send quietly escaping the switch.
    "member-guest-request-withdrawn",
    // #2284 (S2): the family-scope "you were added to a booking" FYI. Named here
    // for the same reason as the member-guest set — it is member-audience and
    // always carries a real bookingId, so the per-booking "No emails" switch is
    // one of the things that withholds it, and the retry cron must refuse to
    // replay a legacy NULL-bookingId row under this name. Unlike the six above
    // it ALSO honours a personal preference, applied before the sender.
    "family-member-added",
    // #2553: the hold-reaper's courtesy notice that a bed-holding
    // policy-exception request lapsed. A POLICY_EXCEPTION modification request
    // hangs off a required Booking FK, so a real bookingId always exists and
    // "none" is never offered by its sender. Member-audience for the same
    // load-bearing reason as the member-guest set: it is not gated on a personal
    // notification preference, so this switch is the only thing that withholds
    // it, and an admin-audience classification would let a silenced booking mail
    // out.
    "policy-exception-request-expired",
    // #2576: the loss-of-cover notice. Always carries a real bookingId (it is a
    // fact about one booking), member-audience, and not gated on a personal
    // preference for the same reason as the two above — so this switch is the only
    // thing that withholds it, and an admin-audience classification would let a
    // silenced booking mail out.
    "hosting-coverage-lost",
  ]);

/**
 * Whether the "No emails" switch may withhold this template at all.
 *
 * Admin- and system-audience templates are exempt without exception (rule 2
 * above). An UNREGISTERED template name is treated as suppressible: reaching the
 * gate at all required the caller to hand us a real bookingId, so an ad-hoc
 * booking-scoped send should honour the switch rather than escape it.
 */
export function isBookingSuppressibleTemplate(templateName: string): boolean {
  const definition = getEmailTemplateDefinition(templateName);
  if (!definition) return true;
  return definition.audience === "member";
}

/**
 * Read the switch. THROWS on any database error — callers must fail closed
 * rather than treat an unreadable flag as "off".
 */
export async function readBookingNoEmails(bookingId: string): Promise<boolean> {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: { noEmails: true },
  });
  // A missing booking is not an error state for the mailer (the row may have
  // been hard-deleted between queueing and sending); nothing is suppressed.
  return booking?.noEmails === true;
}

export type BookingEmailGateDecision =
  // Nothing withholds this message.
  | { decision: "send" }
  // The switch is on: withhold and record it.
  | { decision: "withhold"; bookingId: string }
  // The switch could not be read: withhold anyway (fail closed) and record the
  // send as a transport failure so the retry cron re-evaluates it later.
  | { decision: "unknown"; bookingId: string };

/**
 * Resolve the gate for one send. Never throws.
 */
export async function resolveBookingEmailGate(
  bookingContext: EmailBookingSuppressionContext,
  templateName: string,
): Promise<BookingEmailGateDecision> {
  if (bookingContext === "none") return { decision: "send" };
  if (!isBookingSuppressibleTemplate(templateName)) return { decision: "send" };

  const { bookingId } = bookingContext;
  try {
    const suppressed = await readBookingNoEmails(bookingId);
    return suppressed ? { decision: "withhold", bookingId } : { decision: "send" };
  } catch (err) {
    logger.error(
      { err, bookingId, templateName },
      'Failed to read the booking "No emails" switch; withholding the email (fail closed)',
    );
    return { decision: "unknown", bookingId };
  }
}

/**
 * Record that a message was deliberately withheld, without ever transmitting it.
 *
 * Most booking sends are un-awaited `.catch(log)` calls (waitlist.ts,
 * booking-create.ts, the crons), so the outcome cannot be returned to the caller
 * and be relied on — the MAILER records it. Used by `email/core.ts` for the
 * templates we render ourselves and directly by the two Xero paths, where the
 * provider (not this system) would have done the sending.
 *
 * The rendered body is deliberately NOT retained: nothing was sent, and the
 * retry cron only ever replays rows with a retained body.
 */
export async function recordWithheldBookingEmail(params: {
  bookingId: string;
  templateName: string;
  subject: string;
  to: string;
  detail?: string;
  // Write at most ONE row per (booking, template) PER EPISODE. Used by the
  // split-guest payment-link paths, which a cron re-drives every run: without
  // it the withheld list (and the operator's view of it) fills with identical
  // repeats and buries the withholds that matter. Scoped to the episode via
  // `sinceAt` so an off -> on -> off -> on cycle does not keep returning the
  // FIRST episode's row and show #2259 a stale timestamp.
  once?: boolean;
  // When the current episode began (`Booking.noEmailsAt`). Only rows created at
  // or after this are treated as belonging to it.
  sinceAt?: Date | null;
}): Promise<string | null> {
  // Subjects here interpolate provider-controlled strings (a Xero invoice
  // number). EmailLog subjects are read back into operator screens, so strip
  // CR/LF and collapse whitespace the same way the mailer does before storing.
  const subject = params.subject.replace(/[\r\n]+/g, " ").trim();
  try {
    if (params.once) {
      const existing = await prisma.emailLog.findFirst({
        where: {
          bookingId: params.bookingId,
          templateName: params.templateName,
          status: EmailLogStatus.SKIPPED_NO_EMAILS,
          ...(params.sinceAt ? { createdAt: { gte: params.sinceAt } } : {}),
        },
        select: { id: true },
      });
      if (existing) return existing.id;
    }
    const log = await prisma.emailLog.create({
      data: {
        to: params.to,
        subject,
        templateName: params.templateName,
        htmlBody: null,
        status: EmailLogStatus.SKIPPED_NO_EMAILS,
        bookingId: params.bookingId,
        errorMessage:
          params.detail ??
          'Withheld: this booking has the "No emails" switch turned on',
        lastAttemptAt: new Date(),
      },
      select: { id: true },
    });
    return log.id;
  } catch (err) {
    logger.error(
      { err, bookingId: params.bookingId, templateName: params.templateName },
      "Failed to record a withheld booking email",
    );
    return null;
  }
}

/**
 * What an officer actually has to DO about a withheld message (#2259).
 *
 * No body is retained for any withheld send, so "forward it" is never literally
 * possible — but for most kinds the CONTENT is information the officer can
 * simply state ("your booking was cancelled"), and that is the common case. Two
 * kinds carry a freshly-minted, short-lived artefact instead, and they differ
 * from each other in a way the banner must not blur:
 *
 *  - `split-guest-payment-link` — the link is decided BEFORE it is minted, so
 *    none exists; the settlement cron re-mints and re-sends on its next run
 *    once the switch is off. Clearing the switch really is the whole remedy.
 *
 *  - `chore-roster` — NOT the same, and it was wrong to treat it as such.
 *    `admin-roster-service.ts` DELETES the guest's existing chore token, mints
 *    a fresh one, and only then sends. So a live 48-hour link does exist, the
 *    guest's previous link was destroyed, and the guest is currently holding
 *    nothing that works. And `sendChoreRosterEmail` has exactly one caller —
 *    the admin roster action — with no cron behind it, so nothing regenerates
 *    it: the officer must re-send the roster by hand.
 */
export type WithheldEmailRemedy =
  /** The message's content can simply be relayed by the officer. */
  | "relay"
  /** Nothing was minted; a cron re-sends once the switch is off. */
  | "auto-regenerates"
  /** A link exists but was never delivered, and only a manual re-send fixes it. */
  | "resend-roster";

const WITHHELD_EMAIL_REMEDIES: ReadonlyMap<string, WithheldEmailRemedy> =
  new Map([
    ["split-guest-payment-link", "auto-regenerates" as const],
    ["chore-roster", "resend-roster" as const],
  ]);

/**
 * A human name for a withheld message, for #2259's banner.
 *
 * The registry already carries a display `label` for every template we render
 * ourselves. The two Xero pseudo-templates above are NOT registry entries — we
 * never render or transmit them — so they are named here rather than being
 * shown to an operator as a raw slug. Anything else unknown falls back to the
 * template name itself: an honest "we withheld this and here is what it was
 * called" beats inventing a friendly name for a message nobody has registered.
 */
export function withheldEmailDisplayName(templateName: string): string {
  if (templateName === XERO_BOOKING_INVOICE_EMAIL_TEMPLATE) {
    return "Xero invoice email";
  }
  if (templateName === XERO_GROUP_SETTLEMENT_INVOICE_EMAIL_TEMPLATE) {
    return "Xero group settlement invoice email";
  }
  return getEmailTemplateDefinition(templateName)?.label ?? templateName;
}

export interface WithheldBookingEmailGroup {
  templateName: string;
  /**
   * Human name for the kind. The registry label where one exists; for an
   * UNREGISTERED template this is deliberately the raw name — an honest "this
   * was withheld and here is what it was called" beats inventing a friendly
   * name for a message nobody has registered.
   */
  label: string;
  /** How many of this kind were withheld. EXACT — not a page count. */
  count: number;
  /**
   * The most recent one's subject, representative of the group. Empty when the
   * bounded subject read below did not reach this group's row; the group itself
   * is never dropped, because it comes from the aggregate.
   */
  subject: string;
  /** When the most recent one was withheld. */
  latestAt: Date;
  /** What the officer actually has to do about it (see the map above). */
  remedy: WithheldEmailRemedy;
}

export interface WithheldBookingEmailSummary {
  /** Exact total number of withheld messages. */
  total: number;
  /** One entry per KIND of message, most recently withheld first. */
  groups: WithheldBookingEmailGroup[];
}

/**
 * How many rows the representative-subject read may fetch.
 *
 * The subject query matches rows whose `createdAt` is one of the per-template
 * maxima, so it needs one row per group plus headroom for exact-timestamp ties
 * (two templates withheld in the same millisecond, or several rows of one
 * template sharing its maximum). Generous against the registry, which is the
 * real ceiling on distinct templates, and small enough that the bound is a
 * bound rather than a formality.
 */
const WITHHELD_SUBJECT_READ_LIMIT = 256;

/**
 * What was withheld for a booking, grouped by kind — the read behind #2259's
 * persistent "these messages were not sent" warning.
 *
 * Grouped rather than listed one row at a time, and that is a correctness
 * property rather than a presentational one. A chore-roster send fans out to
 * one row per guest per date (a week for a party of eight is ~56 rows), so a
 * flat newest-first list buries the single cancellation the member most needs
 * to hear about under dozens of identical roster lines.
 *
 * Every read here is BOUNDED, which the first version only claimed to be. It
 * used `findMany({ distinct })`, and Prisma applies `distinct` in memory unless
 * it leads the `orderBy` — so ordering by `createdAt` meant fetching every
 * withheld row for the booking and deduping client-side, exactly the unbounded
 * read the removed `take: 100` had been hiding. The groups now come from a
 * database-side `groupBy`, which returns one row per distinct template and
 * nothing else; subjects are then fetched by matching those maxima under an
 * explicit cap. A group is never dropped for want of a subject, because the
 * aggregate — not the row read — is what produces the list.
 */
export async function getWithheldBookingEmailSummary(
  bookingId: string,
): Promise<WithheldBookingEmailSummary> {
  const where = {
    bookingId,
    status: EmailLogStatus.SKIPPED_NO_EMAILS,
  } as const;

  const [total, grouped] = await Promise.all([
    prisma.emailLog.count({ where }),
    prisma.emailLog.groupBy({
      by: ["templateName"],
      where,
      _count: { _all: true },
      _max: { createdAt: true },
    }),
  ]);

  const latestAts = grouped
    .map((row) => row._max.createdAt)
    .filter((value): value is Date => value != null);

  // Representative subjects: only rows sitting on a per-template maximum.
  const subjectRows = latestAts.length
    ? await prisma.emailLog.findMany({
        where: { ...where, createdAt: { in: latestAts } },
        select: { templateName: true, subject: true },
        take: WITHHELD_SUBJECT_READ_LIMIT,
      })
    : [];
  const subjectByTemplate = new Map<string, string>();
  for (const row of subjectRows) {
    if (!subjectByTemplate.has(row.templateName)) {
      subjectByTemplate.set(row.templateName, row.subject);
    }
  }

  return {
    total,
    groups: grouped
      .map((row) => ({
        templateName: row.templateName,
        label: withheldEmailDisplayName(row.templateName),
        // Fall back to 1 rather than 0: the aggregate row proves at least one
        // exists, so a count that came back empty must not render "×0".
        count: row._count._all || 1,
        subject: subjectByTemplate.get(row.templateName) ?? "",
        latestAt: row._max.createdAt ?? new Date(0),
        remedy: WITHHELD_EMAIL_REMEDIES.get(row.templateName) ?? "relay",
      }))
      // groupBy makes no ordering promise; the banner reads newest-first.
      .sort((a, b) => b.latestAt.getTime() - a.latestAt.getTime()),
  };
}
