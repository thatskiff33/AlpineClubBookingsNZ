/**
 * AI Diagnostics — RESTRICTED record projections for page context (AID-4,
 * #2373).
 *
 * Each reader is a fixed, typed, parameterised read of ONE record by id, with an
 * explicit column allowlist. There is no dynamic column selection, no filter the
 * caller can influence beyond the id, and no model-authored query anywhere —
 * ADR-001 §2 forbids all three.
 *
 * THE OPT-IN SPLIT (ADR-004 §1) is structural, not conditional formatting: each
 * reader produces a `base` fact list that is non-identifying by construction
 * (states, counts, dates, integer cents) and an `identifying` list that is
 * produced ONLY when the operator opted this record in. When they did not, the
 * identifying fields are not merely hidden from the output — they are never
 * assembled, and the caller adds an explicit omission notice instead.
 *
 * REDACTION AND BOUNDS. EVERY value, sensitive or not, is hard-bounded, and
 * every free-text value also passes `redactSensitiveText` first — so an API key
 * pasted into a booking note cannot ride out on the evidence channel (ADR-004
 * §2), and an unbounded admin-editable column (a lodge name is a plain `String`)
 * cannot swell the projection until the rendered evidence has to be truncated.
 * There are exactly three constructors and no fourth way to add a fact:
 * `derivedFact` (closed-vocabulary server values), `textFact` (non-identifying
 * free text) and `sensitiveFact` (identifying free text, opt-in only).
 *
 * DATABASE ROLE. These reads run on the application's Prisma client. AID-5
 * (#2374) shipped ADR-007's dedicated SELECT-only role for the tool substrate,
 * but this separate page-context path did not move onto it. Its controls remain
 * the fixed projections here and the fresh `area:view` gate in `resolve.ts`;
 * moving it would require a new hardening design, not completion of AID-5
 * (ADR-007 §2).
 */

import "server-only";

import { bookingOwner } from "@/lib/booking-owner";
import { formatDateOnly } from "@/lib/date-only";
import { prisma } from "@/lib/prisma";

import { boundedRedacted } from "./bound";
import {
  type DiagnosticsPageContextFact,
  type DiagnosticsRecordKind,
} from "./types";

/** `null` means "no such record" — distinct from "a record with no facts". */
export type RecordProjection = DiagnosticsPageContextFact[] | null;

export interface RecordProjectionInput {
  id: string;
  /** ADR-004 §1: true ONLY when the operator opted this specific record in. */
  includeSensitive: boolean;
}

/**
 * The EXHAUSTIVE list of shapes a server-derived value may have — one per kind of
 * value the readers below actually produce. It is a union of tight shapes rather
 * than one permissive character class on purpose: a class wide enough to cover a
 * date, an instant and an enum in a single pattern (letters, digits, space, `_`,
 * `.`, `:`, `+`, `-`) also covers `sk_live_…`, `whsec_…` and `Bearer …`, so the
 * one mistake this guard exists to catch — using `derivedFact` for a free-text
 * column — would have shipped a secret verbatim.
 *
 * Add a shape here only for a value the server itself constructs, never to make a
 * database column fit — and keep every shape a CLOSED character class between
 * strict anchors, which is what also keeps control characters out of the raw path.
 * (A JavaScript `$` without the `m` flag matches only at the end of input, so a
 * trailing newline genuinely fails these; the tests pin that property.)
 */
/**
 * A hard length bound on top of the shapes below, because several of them are
 * unbounded by construction (`^[A-Z][A-Z0-9_]*$` accepts a 9000-character run of
 * capitals, `^-?\d+$` any number of digits). Nothing the server builds comes close:
 * the longest real value is a 24-character ISO instant. Without this, a hostile or
 * corrupt column that happens to be enum-shaped would travel unbounded and consume
 * the whole rendered evidence budget.
 */
const DERIVED_VALUE_MAX_CHARS = 64;

const DERIVED_VALUE_SHAPES: readonly RegExp[] = [
  /** A Prisma enum token: `CONFIRMED`, `PAYMENT_PENDING`, `NOT_APPLICABLE`. */
  /^[A-Z][A-Z0-9_]*$/,
  /** A count or an integer-cents amount, signed for a reversal. */
  /^-?\d+$/,
  /** A boolean, as rendered by `yesNo`. */
  /^(?:yes|no)$/,
  /** An NZ date-only lodge day, as rendered by `formatDateOnly`. */
  /^\d{4}-\d{2}-\d{2}$/,
  /** An ISO-8601 instant, as rendered by `Date.prototype.toISOString`. */
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
];

function isDerivedValueShape(value: string): boolean {
  if (value.length > DERIVED_VALUE_MAX_CHARS) return false;
  return DERIVED_VALUE_SHAPES.some((shape) => shape.test(value));
}

/**
 * A fact whose value comes from a CLOSED vocabulary the server owns (enum,
 * boolean, count, integer cents, date). Deliberately not passed through
 * `redactSensitiveText`: its phone-like digit-run heuristic would rewrite an
 * eight-digit integer-cents amount to `[REDACTED]`, corrupting money.
 *
 * The shape is therefore VERIFIED rather than trusted: a value matching none of
 * the closed-vocabulary shapes falls back to the redact-and-bound path instead of
 * travelling raw, which is what keeps a NAMED secret shape (`sk_live_…`,
 * `whsec_…`, `Bearer …`) off the raw path.
 *
 * WHAT THAT CHECK DOES NOT DO. It is not a general safety net for misusing this
 * constructor. Two classes of free-text value match the shapes above and so do
 * travel RAW, bounded only by `DERIVED_VALUE_MAX_CHARS`: an uppercase
 * alphanumeric value (the `^[A-Z][A-Z0-9_]*$` enum shape also fits an AWS
 * access-key id or a base32 TOTP secret) and an all-digit value (the integer
 * shape also fits a phone number, an IRD number or a card number). That is
 * unavoidable by design, because redaction cannot run on this path at all — its
 * phone-like digit-run heuristic would rewrite an eight-digit cents amount.
 *
 * The real control is therefore each reader's explicit column ALLOWLIST
 * (`readBooking` / `readMember` / `readPayment` below): a free-text column reaches
 * this constructor only if someone adds it there. A column whose values can be
 * uppercase alphanumeric or all digits must use `textFact` or `sensitiveFact`.
 */
function derivedFact(key: string, value: string): DiagnosticsPageContextFact {
  return {
    key,
    value: isDerivedValueShape(value) ? value : boundedRedacted(value),
    sensitive: false,
  };
}

/**
 * A NON-identifying free-text column (a lodge name). Redacted and bounded on the
 * same path as a sensitive fact — the opt-in split governs WHICH fields are
 * assembled, never whether a free-text value is cleaned up.
 */
function textFact(key: string, value: string): DiagnosticsPageContextFact {
  return { key, value: boundedRedacted(value), sensitive: false };
}

/** A fact carrying identifying/personal content. Redacted then hard-bounded. */
function sensitiveFact(
  key: string,
  value: string,
): DiagnosticsPageContextFact {
  return { key, value: boundedRedacted(value), sensitive: true };
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

/**
 * Nights between two date-only lodge days. Both columns are `@db.Date`, so they
 * arrive as UTC midnight and the difference is exact whole days — no DST or
 * time-of-day term exists to round away.
 */
function nightsBetween(checkIn: Date, checkOut: Date): number {
  const days = Math.round(
    (checkOut.getTime() - checkIn.getTime()) / 86_400_000,
  );
  return days > 0 ? days : 0;
}

function displayName(
  // #3369: null when a booking is owned by an `Organisation` and the caller
  // selected no owner projection. The empty string is the honest answer — the
  // pack states no name rather than inventing one.
  person: { firstName: string; lastName: string } | null,
): string {
  return person ? `${person.firstName} ${person.lastName}`.trim() : "";
}

async function readBooking({
  id,
  includeSensitive,
}: RecordProjectionInput): Promise<RecordProjection> {
  const booking = await prisma.booking.findUnique({
    where: { id },
    select: {
      status: true,
      checkIn: true,
      checkOut: true,
      createdAt: true,
      deletedAt: true,
      requiresAdminReview: true,
      adminReviewStatus: true,
      notes: true,
      lodge: { select: { name: true } },
      member: { select: { firstName: true, lastName: true } },
      // #3369: the owner may be an Organisation; bookingOwner() reads both.
      organisation: { select: { name: true, email: true } },
      _count: { select: { guests: true } },
    },
  });
  if (!booking) return null;

  const facts: DiagnosticsPageContextFact[] = [
    derivedFact("booking.status", booking.status),
    derivedFact("booking.check-in", formatDateOnly(booking.checkIn)),
    derivedFact("booking.check-out", formatDateOnly(booking.checkOut)),
    derivedFact(
      "booking.nights",
      String(nightsBetween(booking.checkIn, booking.checkOut)),
    ),
    derivedFact("booking.guest-count", String(booking._count.guests)),
    // `Lodge.name` is a plain `String` an admin types, so it is free text even
    // though it identifies nobody.
    textFact("booking.lodge", booking.lodge.name),
    derivedFact("booking.deleted", yesNo(booking.deletedAt !== null)),
    derivedFact(
      "booking.requires-admin-review",
      yesNo(booking.requiresAdminReview),
    ),
    derivedFact("booking.created-at", booking.createdAt.toISOString()),
  ];
  if (booking.adminReviewStatus) {
    facts.push(
      derivedFact("booking.admin-review-status", booking.adminReviewStatus),
    );
  }

  if (includeSensitive) {
    // The fact KEY is a stable operator-facing string and is NOT an ownership
    // read (#3368): the sweep rewrote it along with the value beside it, which
    // renamed a diagnostics fact. Left as it was.
    facts.push(
      sensitiveFact("booking.member-name", displayName(bookingOwner(booking).member)),
    );
    if (booking.notes) {
      facts.push(sensitiveFact("booking.notes", booking.notes));
    }
  }

  return facts;
}

async function readMember({
  id,
  includeSensitive,
}: RecordProjectionInput): Promise<RecordProjection> {
  const member = await prisma.member.findUnique({
    where: { id },
    select: {
      active: true,
      canLogin: true,
      emailVerified: true,
      ageTier: true,
      createdAt: true,
      firstName: true,
      lastName: true,
    },
  });
  if (!member) return null;

  const facts: DiagnosticsPageContextFact[] = [
    derivedFact("member.active", yesNo(member.active)),
    derivedFact("member.can-login", yesNo(member.canLogin)),
    derivedFact("member.email-verified", yesNo(member.emailVerified)),
    derivedFact("member.age-tier", member.ageTier),
    derivedFact("member.created-at", member.createdAt.toISOString()),
  ];

  // Contact details (email, phone, addresses) are deliberately NOT projected at
  // any opt-in level: nothing a page-context question needs turns on them, and
  // ADR-004 §2 asks for the minimum that answers the question. A membership tool
  // (AID-6B, #2376) is where a genuine contact-detail question belongs.
  if (includeSensitive) {
    facts.push(sensitiveFact("member.name", displayName(member)));
  }

  return facts;
}

async function readPayment({
  id,
  includeSensitive,
}: RecordProjectionInput): Promise<RecordProjection> {
  const payment = await prisma.payment.findUnique({
    where: { id },
    select: {
      status: true,
      source: true,
      amountCents: true,
      refundedAmountCents: true,
      creditAppliedCents: true,
      createdAt: true,
      booking: {
        select: { member: { select: { firstName: true, lastName: true } } },
      },
    },
  });
  if (!payment) return null;

  // Money stays integer cents end to end; the unit is in the fact KEY so the
  // model can never read a cent value as dollars.
  const facts: DiagnosticsPageContextFact[] = [
    derivedFact("payment.status", payment.status),
    derivedFact("payment.source", payment.source),
    derivedFact("payment.amount-cents", String(payment.amountCents)),
    derivedFact("payment.refunded-cents", String(payment.refundedAmountCents)),
    derivedFact(
      "payment.credit-applied-cents",
      String(payment.creditAppliedCents),
    ),
    derivedFact("payment.created-at", payment.createdAt.toISOString()),
  ];

  if (includeSensitive) {
    facts.push(
      sensitiveFact("payment.payer-name", displayName(bookingOwner(payment.booking).member)),
    );
  }

  return facts;
}

const READERS: Record<
  DiagnosticsRecordKind,
  (input: RecordProjectionInput) => Promise<RecordProjection>
> = {
  booking: readBooking,
  member: readMember,
  payment: readPayment,
};

/**
 * Read the restricted projection for one record. The KIND comes from the
 * registry (server-owned), never from the client — which is what makes an
 * id-substitution attempt inert: a member id supplied on a booking page can only
 * fail to find a booking, it can never resolve a member.
 */
export function readRecordProjection(
  kind: DiagnosticsRecordKind,
  input: RecordProjectionInput,
): Promise<RecordProjection> {
  return READERS[kind](input);
}
