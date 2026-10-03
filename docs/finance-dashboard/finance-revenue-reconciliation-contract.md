# Finance Revenue Reconciliation Contract

This document defines the revenue reconciliation surfaced on the finance revenue
report (`src/lib/finance-revenue-reconciliation.ts`).

## Purpose

For each recent month, compare the hut-fee income recognised in Xero against the
hut-fee revenue the booking system recorded over the same period, so finance can
spot a material gap and investigate.

## Inputs

- Xero income: the latest stored `PROFIT_AND_LOSS_MONTHLY` `FinanceSnapshot` per
  calendar month (newest snapshot per month is kept, so a daily re-sync of the
  current month does not crowd out earlier months).
- Booking hut fees: `BookingGuestNight.priceCents` summed over `stayDate` in the
  period, for realized bookings only (`FINANCE_REALIZED_BOOKING_STATUSES`, and
  never a soft-deleted booking, #3745), split
  into member and non-member via `BookingGuest.isMember`.
- Paid subscription count: `MemberSubscription` rows with status `PAID` and
  `paidAt` in the period.
- Chart of accounts: the latest `CHART_OF_ACCOUNTS` `FinanceSnapshot`
  (AccountID-to-GL-code map) for GL-code matching.

## Matching P&L income lines

P&L income lines are matched to hut-fee and subscription income by GL code:

- Each P&L row carries the account's Xero AccountID in an "account" cell
  attribute. The chart-of-accounts snapshot maps AccountID to GL code.
- The matched GL code is compared against the configured `hutFeesIncome`
  (default `200`) and `subscriptionIncome` (default `203`) account codes from
  `src/lib/xero-mappings.ts` (`getAccountMapping`).
- Label keyword matching (hut fee keywords; subscription/membership keywords) is
  the documented fallback, used only when the chart-of-accounts snapshot is
  unavailable or a P&L snapshot predates account-id capture. Label matching is
  brittle (for example the account "Annual Subs" matches neither "subscription"
  nor "membership"), which is why GL-code matching is preferred.

Each reconciliation period records `incomeMatchStrategy` as `GL_CODE` or
`LABEL` so it is clear which path was used.

## Membership income

Membership income is reported from Xero only. The app stores the paid-membership
count, not a local membership fee amount, so no local membership revenue figure
is fabricated.

## Status and tolerance

Per period the variance is `Xero hut-fee income − booking hut fees`. Status:

- `TIES` when the absolute variance is within tolerance (the greater of $50 or
  1% of the Xero hut-fee figure).
- `DOES_NOT_TIE` when the variance exceeds tolerance.
- `XERO_UNAVAILABLE` when no hut-fee income can be identified from the snapshot
  (no snapshot, no income section, or no matching line). Booking-system figures
  are still reported for context.

The overall status is `DOES_NOT_TIE` if any period does not tie, else
`XERO_UNAVAILABLE` if every period is unavailable, else `TIES`.

## Expected reconciling items

- Timing: booking revenue is recognised by stay night, whereas Xero income
  follows invoice/accrual timing.
- Gross vs net: booking guest-night prices are gross, whereas Xero income may be
  net of refunds/discounts (and contra/reversal accounts).
- Currency: NZD is assumed. Non-NZD lines are not separated out.

These are why a small, persistent variance can be normal; the tolerance absorbs
minor timing differences.
