/**
 * Which email templates are admin/system notices, and which of those admins may
 * not mute. Split out of `email-message-registry.ts` (PR #5143), which was past
 * its hard size ceiling (#4926); the registry reads both sets from here.
 */

import type { EmailAuditTemplateName } from "@/lib/email-message-audit-defaults";

export const ADMIN_SYSTEM_TEMPLATE_NAMES = new Set<EmailAuditTemplateName>([
  "admin-membership-application-pending",
  "admin-minors-review",
  "admin-owner-substitution",
  "admin-partner-share-swept",
  "admin-new-booking",
  "admin-payment-failure",
  // #1992/#2007: duplicate-capture auto-refund alert. Ships via sendToAdmins, so
  // it classifies as an admin alert. Deliberately NOT delivery-locked — the
  // #1994 adjudication: muting causes no direct money loss because the refund
  // already happened inline or is durably queued for the recovery cron. Still
  // gated by the adminPaymentFailure notification preference at send time, like
  // its siblings.
  "admin-duplicate-capture-refund",
  // #3672: paid-group joiners switched to paying for themselves mid-stay, for
  // the treasurer to collect by hand. sendToAdmins on the adminPaymentFailure
  // preference like its reconcile-by-hand siblings; not delivery-locked,
  // because no money moved.
  "admin-group-joiner-started-stay",
  // #5433: a waitlist email owed to a member passed its cut-off unsent.
  // sendToAdmins on the adminWaitlistOffer preference; not delivery-locked,
  // because no money moved.
  "admin-waitlist-notice-unsent",
  // #3663: an expired internet banking hold left alone because the stay has
  // started. sendToAdmins on the adminPaymentFailure preference like its
  // reconcile-by-hand siblings; not delivery-locked, because no money moved.
  "admin-internet-banking-hold-started-stay",
  // B5 (#2262): the reciprocal fence's conflict alert and the cash-cancellation
  // hand-back task alert. Both ship via sendToAdmins, so admin audience, and
  // both are operator nudges rather than money movers — the conflict alert
  // reports a state the pipeline deliberately refused to act on, and the
  // hand-back task is durable in the database whether or not the mail lands —
  // so neither is delivery-locked. Both are gated by the adminPaymentFailure
  // notification preference at send time, like their siblings.
  "admin-manual-settlement-conflict",
  "admin-manual-refund-task",
  // #3643: an expired internet banking hold kept because money may be paid
  // against its invoice. sendToAdmins on the adminPaymentFailure preference like
  // its reconcile-by-hand siblings; not delivery-locked, because no money moved
  // and the booking is still visibly held.
  "admin-internet-banking-hold-kept",
  // #3639 (delta D7): a late capture held for a treasurer's approval. Same
  // channel and preference as the hand-back task alert: a nudge for a durable
  // task, moving no money, so not delivery-locked.
  "admin-late-capture-held",
  // #3638: the second-instrument conflict — a card payment and a Xero payment
  // on one booking. Admin audience, sent through the unmuteable sender and
  // delivery-locked below, because the system refunds nothing on its own and
  // this mail is the only thing that pulls a person to reconcile it.
  "admin-second-instrument-settlement-conflict",
  // #3979: a bank transfer the inbound settle recorded whose amount needs a
  // person - the stored figure kept, or the cash not what the booking owes.
  // Admin audience, unmuteable sender, delivery-locked below, for #3638's reason.
  "admin-bank-transfer-settlement-figure",
  // #4211: a card capture the duplicate-capture guard kept on a paid booking with
  // no usable record of which payment settled it. Same audience, sender and lock.
  "admin-duplicate-capture-kept",
  // #4300: a card capture the settle refused as superseded. Same audience, sender and lock.
  "admin-superseded-capture-refused",
  // #2761: the alert for an automatically refunded late capture on a cancelled
  // booking. Ships to admins, so admin audience — but through the unmuteable
  // sender rather than sendToAdmins, because it reports an automatic MONEY
  // MOVEMENT. It is delivery-locked below, and its send path reads no per-member
  // notification preference at all. It REPLACES the generic payment-failure mail
  // this path used to send; it is not a second notification (`INV-ADDPAY-037`).
  "admin-late-capture-auto-refund",
  // #2774: the sibling notice for the same event class when the capture collides
  // with a hand-back an operator had already made - either the automatic refund
  // was withheld to stop a second payment, or it went out anyway inside the
  // fence's blind window and the member may have been paid twice. Same admin
  // audience and the same unmuteable sender, and delivery-locked below: this is
  // the one mail on the path that says money may have left the club twice.
  "admin-late-capture-hand-back-conflict",
  // #4170: a late capture refunded OUTSIDE the app - no record, no Xero note the
  // app could raise. Same admin audience, unmuteable sender, delivery-locked below.
  "admin-late-capture-refunded-outside-app",
  // #4532: a Stripe payment the app did not create (a Payment Link, Checkout or
  // dashboard charge) - nothing reaches Xero. Same audience, sender and lock.
  "admin-unrecognised-stripe-payment",
  // #4624: the app's own booking payment that matches no payment record.
  "admin-unmatched-app-stripe-payment",
  // #4911: a cardholder's dispute (chargeback) of a card payment, when it opens
  // and when it closes. Same audience, sender and lock.
  "admin-stripe-dispute",
  "admin-pending-deadline",
  "admin-booking-bumped",
  "admin-capacity-warning",
  "admin-daily-digest",
  "admin-xero-sync-error",
  "admin-xero-repeated-failure",
  "admin-xero-reconciliation-report",
  // #2501: the credit-sync checker's drift warning. Ships via sendToAdmins, so
  // admin audience. NOT delivery-locked (an operator nudge — the drift is
  // durable in the ledger and re-detected each pass, so muting loses no money),
  // and content-only by default so it only mails when a real drift exists.
  "admin-credit-sync-drift",
  "admin-refund-request",
  "admin-booking-change-request",
  "admin-issue-report",
  // #2780: a maintenance report was lodged. Ordinary admin alert plumbing -
  // sendToAdmins, gated by the adminMaintenanceReport preference (Lodge
  // Operations edit) and by the club-wide delivery rules. Deliberately NOT in
  // LOCKED_DELIVERY_TEMPLATE_NAMES: no money moves, and a club that would rather
  // read the queue than the mail must be allowed to mute it.
  "admin-maintenance-report",
  // Fork triyder/AlpineClubBookingsNZ#121: a food order, to the Food Orders settings address. Mutable, not
  // delivery-locked: no money moves and every order stays in the history.
  "food-order-placed",
  // #49 (owner decision "second template"): the version-only notice a Lodge
  // Operations editor who does not receive the Daily digest is sent while
  // syncing with the Alpine Central Server is paused. Its own template so a
  // club's override of the digest cannot garble or hide it; sendAdminAlertTo
  // under the adminServerVersion preference and the club-wide delivery rules.
  // Not delivery-locked: no money moves.
  "admin-server-version-paused",
  "admin-membership-cancellation-request",
  "admin-account-deletion-requested",
  "admin-member-archive-requested",
  "admin-member-delete-requested",
  "admin-member-delete-approved",
  "admin-member-delete-rejected",
  "admin-waitlist-offer",
  "admin-family-group-request",
  "admin-email-failure",
  "website-contact",
  "admin-booking-request-pending",
  "admin-booking-request-hold-expired",
  // #2012: terminal one-off notice when a request-origin booking is
  // auto-cancelled past check-in (its held beds released). Its own registry
  // entry (not a variant of the recurring hold-expired alert) so an admin
  // override of the recurring alert cannot rewrite this terminal notice, and
  // muting the recurring alert does not mute this one. Same admin-alert
  // plumbing: sendToAdmins, adminBookingRequest gating, NOT delivery-locked.
  "admin-booking-request-hold-cancelled",
  "admin-school-manual-invoice",
  // #2263: the same money-critical alert for an approved MEMBER whole-lodge
  // request converted while the Xero module is off. Its own registry entry
  // rather than a variant of the school one — the wording names a member, not a
  // school — and delivery-locked on the same grounds (see below).
  "admin-whole-lodge-manual-invoice",
  // #1967/#1994: split non-member guest portion unpaid at hold expiry (no card
  // on file). Ships via sendToAdmins, so it classifies as an admin alert.
  // Deliberately NOT in LOCKED_DELIVERY_TEMPLATE_NAMES — it is an operational
  // nudge (the member already has their payment link; no money is lost if an
  // admin mutes it), so admins keep full delivery-mode control. Still gated by
  // the adminPaymentFailure notification preference at send time (#1422).
  "admin-split-settlement-unpaid",
  // #1993 Part A: terminal one-off notice when that guest portion is
  // auto-cancelled past check-in. Its own registry entry (not a variant of the
  // recurring alert) so an admin override of the noisy recurring alert cannot
  // rewrite this terminal notice, and muting the recurring alert does not mute
  // this one. Same admin-alert plumbing: sendToAdmins, adminPaymentFailure
  // gating, NOT delivery-locked.
  "admin-split-settlement-cancelled",
]);

// Admin/system templates whose delivery mode admins must NOT be able to change.
// admin-school-manual-invoice (#1797) is admin-facing so it classifies as an
// admin alert, but disabling it would let an approved school booking go
// un-invoiced — a money risk — so it is locked to always-send like
// admin-email-failure, matching the pre-#1797 hardcoded behaviour.
export const LOCKED_DELIVERY_TEMPLATE_NAMES = new Set<EmailAuditTemplateName>([
  "admin-email-failure",
  "admin-school-manual-invoice",
  // #2263: same money risk, same lock — disabling it would let an approved
  // member whole-lodge booking go un-invoiced while the member has been told an
  // invoice is coming.
  "admin-whole-lodge-manual-invoice",
  // #2761 (owner decision 10 Aug 2026): an automatic money movement must not be
  // silenceable. This alert is the moment-of-event notice for a late capture the
  // webhook refunded on its own, and the club's only other trace is a row on a
  // card and an audit entry — so muting it club-wide is exactly the state the
  // owner ruled out. Locked here AND sent off the per-member preference, because
  // those are two separate mute vectors and the decision closed both.
  "admin-late-capture-auto-refund",
  // #2774 (the orchestrator's call on the Recommended option; the owner has not
  // ruled — `INV-ADDPAY-039`): the same lock, for a stronger reason.
  // This alert reports either a refund the system deliberately did NOT send or a
  // capture that may have been paid back twice; in both directions it is the only
  // thing that pulls a person to reconcile real money, so it must not be
  // silenceable club-wide any more than its sibling.
  "admin-late-capture-hand-back-conflict",
  // #4170: the same lock - money left the club with no record the app wrote.
  "admin-late-capture-refunded-outside-app",
  // #4532: the same lock - money arrived with no record the app wrote and no
  // screen that lists it, so muting it would leave it uncoded in Xero.
  "admin-unrecognised-stripe-payment",
  // #4624: the same lock - a member was charged and the booking does not show it.
  "admin-unmatched-app-stripe-payment",
  // #4911: the same lock - Stripe took the money back outside the app, nothing
  // reaches Xero, and a dispute nobody answers in time is lost.
  "admin-stripe-dispute",
  // #3638: the same lock for the same reason as #2774 — this alert says the
  // club may hold the price twice (a card payment and a Xero payment on one
  // booking), and nothing is refunded or credited automatically, so muting it
  // club-wide would leave the money with nobody to reconcile it.
  "admin-second-instrument-settlement-conflict",
  // #3979: the same lock - a recorded bank-transfer figure that is wrong sizes
  // every later refund and credit, and this mail is what pulls a person to check it.
  "admin-bank-transfer-settlement-figure",
  // #4211: the same lock - nothing was refunded automatically and the club may
  // hold the price twice, so muting it would leave the money with nobody.
  "admin-duplicate-capture-kept",
  // #4300: the same lock - a payment the member made was not applied, and the
  // booking may still owe; muting it would leave both with nobody.
  "admin-superseded-capture-refused",
]);
