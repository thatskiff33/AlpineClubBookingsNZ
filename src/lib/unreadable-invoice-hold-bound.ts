/**
 * How long past its deadline an Internet Banking hold whose Xero invoice
 * cannot be read is kept before it is released unchecked (#3643, #3642,
 * `INV-PAY-107`, `INV-PAY-105`). ONE bound for the single-booking hold job
 * (`internet-banking-hold-kept.ts`) and the group settlement reaper
 * (`cron-group-settlement-reaper.ts`), so the two can never drift (#3635).
 * A stay that starts inside the bound is never released by either: it is kept
 * and the treasurer alerted once (`INV-PAY-016`).
 */
export const UNREADABLE_INVOICE_HOLD_BOUND_MS = 7 * 24 * 60 * 60 * 1000;
