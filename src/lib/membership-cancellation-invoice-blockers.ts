/**
 * Unpaid-invoice blocker for membership cancellation approvals (#2392).
 *
 * ## Why this exists
 *
 * Approving a cancellation queues a Xero CONTACT ARCHIVE when
 * `xeroArchiveContactsOnCancellation` is on (`membership-cancellation-xero.ts`).
 * Archiving a contact that still owes the club money takes the contact out of
 * every Xero picker and stops new invoices, credit notes and payments being
 * raised against it — the accounts still need it. The pre-existing approval
 * blockers only looked at future bookings, so nothing stopped that. Since #2383
 * made organisation accounts cancellable this became likelier still, because an
 * organisation is usually the billing contact for its booking invoices rather
 * than just its own membership.
 *
 * The owner's decision (recorded on #2392) is to BLOCK the approval while
 * anything is owing, not merely to warn.
 *
 * ## What "unpaid" means here
 *
 * An invoice blocks when Xero says it is **AUTHORISED or SUBMITTED with an
 * amount still due**. That is the same "open invoice" definition the finance
 * dashboard already uses (`FINANCE_AGED_INVOICE_STATUSES`), so the club has one
 * meaning of "open" across the app, and it is what an operator means by "the
 * accounts still need this contact":
 *
 * - **DRAFT does not block.** A draft has never been issued, creates no
 *   obligation on either side, and does not appear in Xero's receivables. The
 *   app's own pipelines leave drafts around; blocking on them would refuse
 *   cancellations for no financial reason.
 * - **SUBMITTED blocks.** It is an issued invoice awaiting internal approval,
 *   with a real balance, and Xero ages it as a receivable.
 * - **VOIDED and DELETED never block.** They are cancelled documents with
 *   nothing due — and voiding is one of the three resolutions this blocker
 *   tells the approver to use.
 * - **PAID never blocks**, because Xero flips an invoice to PAID once payments
 *   and credit notes fully settle it, taking the amount due to zero.
 * - **A credit note that only partly offsets an invoice still blocks**, on the
 *   residual balance. Xero subtracts `AmountCredited` from `AmountDue` and
 *   leaves the invoice AUTHORISED while anything remains, and the residual is
 *   exactly what the accounts are still waiting for — so that, not the original
 *   total, is the figure shown to the approver.
 * - **Bills (ACCPAY) block too.** The question is "does the ledger still need
 *   this contact", which does not care which way the money flows: archiving a
 *   contact the club still owes is the same mistake.
 *
 * ## What is deliberately NOT counted
 *
 * The member's own current-season subscription invoice, when the cancellation
 * itself is about to credit it IN FULL. `queueApprovedMembershipCancellationXeroOperations`
 * raises an allocated credit note against an UNPAID/OVERDUE subscription invoice
 * on approval — that is the documented refund policy. Counting it would deadlock
 * the single most common cancellation there is: the thing that clears the
 * invoice is the very approval being refused. The exclusion mirrors that queue's
 * own rule (current season, status UNPAID or OVERDUE, invoice linked) and is
 * applied per member, so one member's subscription invoice never excuses another
 * member who happens to share the same Xero contact.
 *
 * "In full" is load-bearing, and is the whole reason #2400 had to move with this
 * module. A family invoice covers everybody in the group, and since #2400 the
 * cancellation raises NO credit note at all while other covered members are
 * staying — crediting the full balance would wipe their share of the bill too.
 * An invoice nobody is going to credit is a real balance, so it must not be
 * excused here: excusing it would let the approval archive a Xero contact with
 * money still owing on it, which is precisely the harm this module exists to
 * prevent. The exclusion is therefore decided by
 * `loadMembershipCancellationSubscriptionCreditPlansByMemberId`, the same module
 * the credit note itself consults, so the set excluded here is exactly the set
 * that will be cleared. That is the invariant: **this check excuses an invoice
 * if and only if the approval is STILL about to credit its full balance.**
 *
 * "Still" is not decoration. The credit-note operation is one-shot: it completes
 * SUCCEEDED even when it deliberately skips, and is never retried. Once a whole
 * family has been cancelled, "would this cancellation credit in full?" answers
 * YES again for every one of them — although each of their credit notes already
 * ran and skipped while siblings were live. The archive re-check below runs at
 * exactly that moment, so recomputing that question there would excuse an
 * invoice nobody is ever going to credit and archive the contact over a live
 * balance — the very harm #2392 exists to prevent. The exclusion therefore reads
 * `excusesUnpaidInvoiceBlocker`, which also consults the credit operation's
 * RECORDED OUTCOME, not `creditsInFull` on its own (#2400 review, F3).
 *
 * ## When the check runs at all
 *
 * Only when BOTH are true:
 *
 * 1. `xeroArchiveContactsOnCancellation` is ON. With it off, approval never
 *    archives anything — the contact and every invoice on it stay exactly as
 *    they are — so there is nothing to protect and blocking would be pure
 *    friction. It also means a Xero outage cannot stop cancellations at a club
 *    that chose not to archive. The setting is read through
 *    `loadMembershipCancellationSettingsStrict`, so a failed read is an unknown
 *    (check runs) rather than a silent "off" (check skipped).
 * 2. The member actually has a linked Xero contact. With none,
 *    `syncXeroMembershipCancellationContact` skips with
 *    `member_has_no_xero_contact` and no Xero object is touched, so a club that
 *    does not use Xero is never blocked and never triggers a Xero call.
 *
 * Neither gate is the last word, because the archive is an OUTBOX operation
 * drained later: a club can approve with archiving off and switch it on
 * afterwards, and the queued operation would then archive a contact this check
 * never ran for. `syncXeroMembershipCancellationContact` therefore re-runs this
 * same check immediately before it archives, and defers rather than archives if
 * anything is owing (#2392 review, NEW-1). This module is the gate an admin
 * sees; that one is the gate that actually protects the ledger.
 *
 * ## One known hole, stated rather than papered over
 *
 * The read passes `includeArchived: false`, matching every other Xero read in
 * the app. A contact that is ALREADY archived in Xero and still carries open
 * invoices therefore reports nothing owing and approves. Nothing new is archived
 * in that case — the contact is archived already — so no ledger state changes
 * that was not already true; but it does mean the promise "you will be told
 * about open invoices before you approve" has this one exception.
 *
 * ## Fail-safe: an unknown answer BLOCKS
 *
 * If Xero cannot be asked — disconnected, rate limited, or unreachable — the
 * approval is refused with an `invoice_check_unavailable` blocker rather than
 * allowed through. "We could not find out" is not "nothing is owing", and the
 * two outcomes are not symmetrical: a refusal is temporary, reversible and
 * loses nothing (the request stays in the queue and approves the moment Xero
 * answers), whereas letting it through queues an archive that runs later,
 * silently, against a contact the accounts still need — found weeks afterwards
 * by whoever chases the debt. During a Xero outage the archive would fail and
 * sit in the outbox anyway, so waiting costs the club almost nothing.
 *
 * Each failure gets its own words because each needs a different action: a
 * disconnected Xero needs reconnecting, an unreachable one needs another try in
 * a few minutes, a rejected request means the stored contact is gone and will
 * never come back on its own, and a truncated read means the contact has more
 * open invoices than the check can list. Every one of those messages also names
 * the escape hatch — turning the archive setting off — because a refusal whose
 * only advice is "wait" is the cancellation-held-hostage the owner chose
 * "block" specifically to avoid (#2392 review, H2/M3).
 */

import type { Invoice } from "xero-node";
import {
  toOptionalDateOnlyText,
  toOptionalText,
} from "@/lib/finance-sync-xero-datasets/date-format";
import {
  getInvoiceAmountDue,
  getInvoiceCurrency,
} from "@/lib/finance-sync-xero-datasets/invoice-helpers";
import logger from "@/lib/logger";
import { providerAmountToCents, providerAmountToTenThousandths } from "@/lib/money-provider-amount";
import type {
  MembershipCancellationInvoiceBlocker,
  MembershipCancellationInvoiceCheckUnavailableReason,
  MembershipCancellationUnpaidInvoiceBlocker,
} from "@/lib/membership-cancellation-blocker-messages";
import { loadMembershipCancellationSettingsStrict } from "@/lib/membership-cancellation-settings";
import {
  loadMembershipCancellationSubscriptionCreditPlansByMemberId,
  type MembershipCancellationSubscriptionCreditPlan,
} from "@/lib/membership-cancellation-subscription-credit";
import { prisma } from "@/lib/prisma";
import {
  callXeroApi,
  getAuthenticatedXeroClient,
} from "@/lib/xero-api-client";
import { getXeroErrorStatusCode } from "@/lib/xero-error-shape";
import { buildXeroContactUrl, buildXeroInvoiceUrl } from "@/lib/xero-links";

/**
 * The same "open invoice" statuses the finance dashboard ages
 * (`FINANCE_AGED_INVOICE_STATUSES`). One definition of open across the app.
 */
export const MEMBERSHIP_CANCELLATION_OPEN_INVOICE_STATUSES = [
  "AUTHORISED",
  "SUBMITTED",
] as const;

const XERO_PAGE_SIZE = 100;
/**
 * A contact with more than this many open invoices is emphatically blocked
 * already; the cap only stops a pathological contact from walking Xero forever
 * while an admin waits on a page render.
 *
 * That reasoning is per CONTACT, and it only holds because a batch that hits the
 * cap is treated as an UNKNOWN answer rather than a clean one — see
 * `fetchOpenInvoicePages`. Xero orders the batch `DueDate ASC` across every
 * contact in it, so one high-volume contact can otherwise consume all 500 rows
 * and leave a different member with an empty bucket that reads as "nothing
 * owing" (#2392 review, M5).
 */
const MAX_INVOICE_PAGES = 5;

/**
 * Contact ids per `getInvoices` call. The repo already settled on 50 for the
 * same kind of id-list read (`xero-contact-cache.ts`), and this one is stricter
 * because the review queue's page size goes up to 100 REQUESTS, each of which
 * can carry several participants: a few hundred GUIDs comma-joined into one
 * query string is untested ground against Xero's URL-length limits, and it fails
 * in a self-disguising way — the whole queue reports "Xero could not be
 * reached" while single-member approvals keep working (#2392 review, M4).
 */
const XERO_CONTACT_ID_BATCH_SIZE = 40;

/**
 * Contacts held in the memo at once. Entries are pruned when they expire, but a
 * long-lived process that checks thousands of contacts should not grow a map
 * forever; past this many the memo is simply dropped and refilled.
 */
const INVOICE_CHECK_CACHE_MAX_ENTRIES = 500;

/** An `unknown` answer dressed as an empty one is the one thing this must never return. */
const INVOICE_CHECK_TRUNCATED_ERROR_NAME =
  "MembershipCancellationInvoiceCheckTruncatedError";

/**
 * The review queue re-reads this on every page load, filter change and refresh.
 * A short in-process memo keeps that off Xero's quota, in the same spirit as the
 * connection probe's 45s cache. The approval guard passes `fresh` and never
 * reads it, so an approval is always decided on a live answer; a stale entry can
 * therefore only make the queue's advisory panel briefly out of date, never let
 * an approval through on stale data. Failures are never cached, so a transient
 * blip clears on the next attempt.
 */
const INVOICE_CHECK_CACHE_TTL_MS = 60_000;

type InvoiceCheckCacheEntry = {
  expiresAtMs: number;
  blockers: MembershipCancellationUnpaidInvoiceBlocker[];
};

/**
 * Keyed on the Xero contact id alone. Contact ids are per-tenant GUIDs, so a
 * collision across two tenants is not a real possibility, and the 60s TTL bounds
 * it regardless.
 */
const invoiceCheckCache = new Map<string, InvoiceCheckCacheEntry>();

/** test seam */
export function resetMembershipCancellationInvoiceBlockerCacheForTests(): void {
  invoiceCheckCache.clear();
}

/** test seam — the memo is bounded, and that is only checkable from outside. */
export function membershipCancellationInvoiceCheckCacheSizeForTests(): number {
  return invoiceCheckCache.size;
}

export interface MembershipCancellationInvoiceBlockerOptions {
  /** Bypass and refresh the memo. The approval guard always sets this. */
  fresh?: boolean;
  /** Injectable clock, for the memo TTL and the current season year. */
  nowMs?: number;
  /**
   * The credit plans, already loaded by the caller.
   *
   * The review queue needs the same map twice — once here for the exclusion,
   * once for the shared-invoice notice — and it reaches
   * `MemberSubscription.xeroInvoiceId` with an `in` list, so computing it twice
   * per page load doubled that read for nothing. Passing it in makes the queue
   * load it exactly once (#2400 review, F8). Omit it and this loads its own,
   * which is what the archive-time re-check does.
   */
  creditPlansByMemberId?: ReadonlyMap<
    string,
    MembershipCancellationSubscriptionCreditPlan | null
  >;
}

/**
 * Classify why the check could not run. Name-keyed like the connection probe, so
 * the classification does not depend on `instanceof` surviving module mocking.
 */
export function classifyMembershipCancellationInvoiceCheckFailure(
  error: unknown,
): MembershipCancellationInvoiceCheckUnavailableReason {
  if (error instanceof Error) {
    if (error.name === "XeroDailyLimitError") {
      return "rate_limited";
    }
    if (
      error.name === "XeroReconnectRequiredError" ||
      // A stored token that no longer decrypts is a reconnect, not an outage.
      error.name === "XeroTokenDecryptError"
    ) {
      return "disconnected";
    }
    if (error.name === INVOICE_CHECK_TRUNCATED_ERROR_NAME) {
      return "too_many_invoices";
    }
  }

  const statusCode = getXeroErrorStatusCode(error);
  if (statusCode === 401 || statusCode === 403) {
    return "disconnected";
  }
  if (statusCode === 429) {
    return "rate_limited";
  }
  // 400 and 404 are Xero rejecting the REQUEST, not failing to serve it: the
  // usual cause is a stored contact id that has since been merged or deleted
  // there. Retrying an unchanged request cannot help, so it must not be reported
  // as "try again in a few minutes" — that is an approval with no route forward
  // (#2392 review, M3).
  if (statusCode === 400 || statusCode === 404) {
    return "invalid_request";
  }

  return "unavailable";
}

function normaliseContactKey(contactId: string): string {
  return contactId.trim().toLowerCase();
}

function toUnpaidInvoiceBlocker(
  invoice: Invoice,
): MembershipCancellationUnpaidInvoiceBlocker | null {
  const invoiceId = toOptionalText(invoice.invoiceID);
  if (!invoiceId) {
    return null;
  }
  const contactId = toOptionalText(invoice.contact?.contactID);

  const status = toOptionalText(invoice.status)?.toUpperCase() ?? "";
  // Belt and braces: the API call already filters by status, but a blocker that
  // can refuse a lifecycle action should not depend on a remote filter alone.
  if (
    !(MEMBERSHIP_CANCELLATION_OPEN_INVOICE_STATUSES as readonly string[]).includes(
      status,
    )
  ) {
    return null;
  }

  // getInvoiceAmountDue reports major units, falling back to total - paid -
  // credited when Xero omits AmountDue, so a part-credited invoice leaves its
  // residual and a settled one zero. "Owing" is asked of Xero's own figure, not
  // of rounded hundredths: KWD 0.004 is zero cents, and reading it as nothing
  // owing would archive a contact with money still on it (#3724).
  const amountDue = getInvoiceAmountDue(invoice);
  const amountDueTenThousandths = providerAmountToTenThousandths(amountDue);
  const amountDueCents = providerAmountToCents(amountDue);
  if (amountDueTenThousandths === null || amountDueCents === null || amountDueTenThousandths <= 0) {
    return null;
  }

  const direction =
    toOptionalText(invoice.type)?.toUpperCase() === "ACCPAY"
      ? "payable"
      : "receivable";

  return {
    type: "unpaid_invoice",
    invoiceId,
    invoiceNumber: toOptionalText(invoice.invoiceNumber),
    invoiceStatus: status,
    direction,
    amountDueCents,
    amountDueTenThousandths,
    currency: getInvoiceCurrency(invoice),
    dueDate: toOptionalDateOnlyText(invoice.dueDate),
    // The deep-link path is the receivables one; a bill has no equivalent
    // helper, so it is left without a link rather than pointed somewhere wrong.
    xeroUrl: direction === "receivable" ? buildXeroInvoiceUrl(invoiceId) : null,
    // ...and the contact page picks up what the invoice link cannot: a bill, and
    // any invoice Xero never numbered. A treasurer cannot search Xero by GUID,
    // so without a link those rows name something they cannot find (#2392
    // review, H1).
    xeroContactUrl: contactId ? buildXeroContactUrl(contactId) : null,
  };
}

function compareInvoiceBlockers(
  left: MembershipCancellationUnpaidInvoiceBlocker,
  right: MembershipCancellationUnpaidInvoiceBlocker,
): number {
  const leftDue = left.dueDate ?? "9999-12-31";
  const rightDue = right.dueDate ?? "9999-12-31";
  if (leftDue !== rightDue) {
    return leftDue < rightDue ? -1 : 1;
  }
  const leftNumber = left.invoiceNumber ?? "";
  const rightNumber = right.invoiceNumber ?? "";
  if (leftNumber !== rightNumber) {
    return leftNumber < rightNumber ? -1 : 1;
  }
  return left.invoiceId < right.invoiceId ? -1 : 1;
}

/**
 * One batch of contact ids, paged. Throws on any Xero failure — and treats
 * hitting the page cap as a failure too, because the alternative is returning
 * a truncated list that is indistinguishable from a complete one.
 */
async function fetchOpenInvoicePages(
  xero: Awaited<ReturnType<typeof getAuthenticatedXeroClient>>["xero"],
  tenantId: string,
  contactIds: readonly string[],
  batchLabel: string,
): Promise<Invoice[]> {
  const invoices: Invoice[] = [];

  for (let page = 1; page <= MAX_INVOICE_PAGES; page += 1) {
    const response = await callXeroApi(
      () =>
        xero.accountingApi.getInvoices(
          tenantId,
          undefined, // ifModifiedSince
          undefined, // where — statuses below are the whole filter
          "DueDate ASC", // order
          undefined, // iDs
          undefined, // invoiceNumbers
          [...contactIds], // contactIDs
          [...MEMBERSHIP_CANCELLATION_OPEN_INVOICE_STATUSES], // statuses
          page,
          false, // includeArchived
          false, // createdByMyApp
          undefined, // unitdp
          false, // summaryOnly
          XERO_PAGE_SIZE,
        ),
      {
        operation: "getInvoices",
        resourceType: "INVOICE",
        workflow: "membershipCancellationInvoiceBlockers",
        context: `membershipCancellationInvoiceBlockers(${batchLabel}, page ${page})`,
        // An admin is waiting on this, and a slow answer is worse than a
        // "try again" they can act on: fail fast into the unavailable branch
        // rather than sitting in callXeroApi's default two-minute rate-limit
        // wait while the review queue hangs.
        maxRetries: 1,
        maxWaitSec: 15,
      },
    );

    const pageInvoices = response.body.invoices ?? [];
    invoices.push(...pageInvoices);
    if (pageInvoices.length < XERO_PAGE_SIZE) {
      return invoices;
    }
  }

  // Ran out of pages with Xero still offering more. Whatever we hold is a
  // prefix of the contacts' invoices in due-date order, so a contact further
  // down the batch may well owe money and show none of it. "We could not find
  // out" is the honest answer, and this module's rule is that it blocks.
  const truncated = new Error(
    `Membership cancellation unpaid-invoice check hit its ${MAX_INVOICE_PAGES}-page cap for ${contactIds.length} Xero contact(s) (${batchLabel}); the result is incomplete and cannot be reported as "nothing owing".`,
  );
  truncated.name = INVOICE_CHECK_TRUNCATED_ERROR_NAME;
  throw truncated;
}

/**
 * Fetch open invoices for a batch of Xero contacts. Throws on any Xero failure;
 * the caller classifies it. Contact ids are chunked so the review queue's page
 * of requests cannot build one enormous query string.
 */
async function loadOpenInvoicesByContactKey(
  contactIds: readonly string[],
  options: MembershipCancellationInvoiceBlockerOptions,
): Promise<Map<string, MembershipCancellationUnpaidInvoiceBlocker[]>> {
  const nowMs = options.nowMs ?? Date.now();
  const byContactKey = new Map<
    string,
    MembershipCancellationUnpaidInvoiceBlocker[]
  >();
  const contactIdsToFetch: string[] = [];

  for (const contactId of contactIds) {
    const key = normaliseContactKey(contactId);
    if (!options.fresh) {
      const cached = invoiceCheckCache.get(key);
      if (cached && cached.expiresAtMs > nowMs) {
        byContactKey.set(key, cached.blockers);
        continue;
      }
    }
    contactIdsToFetch.push(contactId);
  }

  if (contactIdsToFetch.length === 0) {
    return byContactKey;
  }

  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const invoices: Invoice[] = [];

  for (
    let index = 0;
    index < contactIdsToFetch.length;
    index += XERO_CONTACT_ID_BATCH_SIZE
  ) {
    const batch = contactIdsToFetch.slice(
      index,
      index + XERO_CONTACT_ID_BATCH_SIZE,
    );
    invoices.push(
      ...(await fetchOpenInvoicePages(
        xero,
        tenantId,
        batch,
        `batch ${Math.floor(index / XERO_CONTACT_ID_BATCH_SIZE) + 1}`,
      )),
    );
  }

  const fetched = new Map<
    string,
    MembershipCancellationUnpaidInvoiceBlocker[]
  >();
  for (const contactId of contactIdsToFetch) {
    fetched.set(normaliseContactKey(contactId), []);
  }

  for (const invoice of invoices) {
    const contactId = toOptionalText(invoice.contact?.contactID);
    if (!contactId) continue;
    const bucket = fetched.get(normaliseContactKey(contactId));
    if (!bucket) continue;
    const blocker = toUnpaidInvoiceBlocker(invoice);
    if (blocker) {
      bucket.push(blocker);
    }
  }

  pruneInvoiceCheckCache(nowMs);

  const expiresAtMs = nowMs + INVOICE_CHECK_CACHE_TTL_MS;
  for (const [key, blockers] of fetched) {
    blockers.sort(compareInvoiceBlockers);
    invoiceCheckCache.set(key, { expiresAtMs, blockers });
    byContactKey.set(key, blockers);
  }

  return byContactKey;
}

/**
 * Keep the memo bounded. Expired entries are dead weight the TTL check alone
 * never removes, and a long-lived process should not accumulate one entry per
 * contact ever checked; past the ceiling the whole memo is dropped, which costs
 * one round of Xero reads and nothing else.
 */
function pruneInvoiceCheckCache(nowMs: number): void {
  for (const [key, entry] of invoiceCheckCache) {
    if (entry.expiresAtMs <= nowMs) {
      invoiceCheckCache.delete(key);
    }
  }
  if (invoiceCheckCache.size > INVOICE_CHECK_CACHE_MAX_ENTRIES) {
    invoiceCheckCache.clear();
  }
}

/**
 * Per-member unpaid-invoice blockers. Always returns an entry for every member
 * asked about, so a caller can never mistake "no key" for "nothing owing".
 */
export async function loadMembershipCancellationInvoiceBlockersByMemberId(
  memberIds: readonly string[],
  options: MembershipCancellationInvoiceBlockerOptions = {},
): Promise<Map<string, MembershipCancellationInvoiceBlocker[]>> {
  const uniqueMemberIds = [...new Set(memberIds)].filter(Boolean);
  const blockersByMemberId = new Map<
    string,
    MembershipCancellationInvoiceBlocker[]
  >(uniqueMemberIds.map((memberId) => [memberId, []]));

  if (uniqueMemberIds.length === 0) {
    return blockersByMemberId;
  }

  // Gate 1: nothing is archived, so nothing is at risk. No Xero call at all,
  // which is also what keeps a Xero outage from blocking a club that has
  // deliberately turned archiving off.
  //
  // The setting is read STRICTLY here. The ordinary loader swallows a failed
  // read and returns the defaults, whose archive flag is OFF — which would tell
  // this gate "nothing will be archived, skip the check" on the strength of a
  // database blip, while the archive itself is an outbox operation drained
  // minutes later off a read that succeeds. A module whose doctrine is "an
  // unknown answer blocks" must not fail open on the very condition that
  // decides whether it runs, so an unreadable setting is treated as archiving
  // ON: the check then runs and answers truthfully, blocking only if money is
  // actually owing (#2392 review, NEW-1).
  let archiveContactsOnCancellation: boolean;
  try {
    archiveContactsOnCancellation = (
      await loadMembershipCancellationSettingsStrict()
    ).xeroArchiveContactsOnCancellation;
  } catch (error) {
    logger.warn(
      { err: error },
      "Membership cancellation settings could not be read; assuming Xero contact archiving is ON so the unpaid-invoice check still runs",
    );
    archiveContactsOnCancellation = true;
  }
  if (!archiveContactsOnCancellation) {
    return blockersByMemberId;
  }

  // Gate 2: no linked Xero contact means the contact operation skips with
  // `member_has_no_xero_contact` — there is no Xero object to endanger.
  const members = await prisma.member.findMany({
    where: { id: { in: uniqueMemberIds } },
    select: { id: true, xeroContactId: true },
  });
  const contactIdByMemberId = new Map<string, string>();
  for (const member of members) {
    if (member.xeroContactId) {
      contactIdByMemberId.set(member.id, member.xeroContactId);
    }
  }
  const memberIdsWithContact = [...contactIdByMemberId.keys()];
  if (memberIdsWithContact.length === 0) {
    return blockersByMemberId;
  }

  // The invoice this approval will itself credit IN FULL, per member — see the
  // module note: counting it would deadlock the ordinary unpaid-subscription
  // case, and excusing one that will NOT be credited would archive a contact
  // with a real balance behind it (#2400).
  //
  // The season is read from NOW, which matters for the archive-time re-check in
  // `membership-cancellation-xero.ts`: an outbox operation still draining after
  // a season rollover asks about the NEW season, so a previous season's
  // subscription invoice would no longer be excluded here. That cannot deadlock
  // the archive in practice, because by then the credit note has already been
  // raised — the archive is not even attempted until
  // `isMembershipCancellationCreditNoteSettled` says so — and where it WAS
  // raised it was raised for the invoice's full `amountDue`, which takes the
  // invoice to PAID in Xero and out of the open-invoice read this check
  // performs. Where it was not raised, because the invoice covers members who
  // are staying, the balance is real and blocking the archive is the correct
  // outcome, not a deadlock: the invoice belongs to the members who remain and
  // an admin settles it in Xero. Written down because that safety depends on
  // another module's behaviour, not on anything visible here (#2392 review,
  // #2400).
  //
  // At archive time the exclusion is decided almost entirely by the RECORDED
  // outcome rather than by the live covered set: by then this member's credit
  // note has settled (the archive is not attempted until it has), so
  // `excusesUnpaidInvoiceBlocker` is false and nothing is excused. That is the
  // point — see the "Still" paragraph in the module note (#2400 review, F3).
  const creditPlansByMemberId =
    options.creditPlansByMemberId ??
    (await loadMembershipCancellationSubscriptionCreditPlansByMemberId(
      memberIdsWithContact,
      { nowMs: options.nowMs },
    ));
  const selfCreditedByMemberId = new Map<string, Set<string>>();
  for (const memberId of memberIdsWithContact) {
    const plan = creditPlansByMemberId.get(memberId);
    // Only a plan that is STILL going to clear the WHOLE balance earns the
    // exclusion — a credit note that already ran and skipped never does.
    if (!plan?.excusesUnpaidInvoiceBlocker) continue;
    selfCreditedByMemberId.set(memberId, new Set([plan.invoiceId]));
  }

  const contactIds = [...new Set(contactIdByMemberId.values())];
  let openInvoicesByContactKey: Map<
    string,
    MembershipCancellationUnpaidInvoiceBlocker[]
  >;
  try {
    openInvoicesByContactKey = await loadOpenInvoicesByContactKey(
      contactIds,
      options,
    );
  } catch (error) {
    const reason = classifyMembershipCancellationInvoiceCheckFailure(error);
    logger.warn(
      { err: error, reason, contactCount: contactIds.length },
      "Membership cancellation unpaid-invoice check could not be completed; approvals for these members are blocked until it can",
    );
    for (const memberId of memberIdsWithContact) {
      blockersByMemberId.set(memberId, [
        { type: "invoice_check_unavailable", reason },
      ]);
    }
    return blockersByMemberId;
  }

  for (const memberId of memberIdsWithContact) {
    const contactId = contactIdByMemberId.get(memberId);
    if (!contactId) continue;
    const selfCredited = selfCreditedByMemberId.get(memberId);
    const openInvoices =
      openInvoicesByContactKey.get(normaliseContactKey(contactId)) ?? [];
    blockersByMemberId.set(
      memberId,
      selfCredited
        ? openInvoices.filter((blocker) => !selfCredited.has(blocker.invoiceId))
        : [...openInvoices],
    );
  }

  return blockersByMemberId;
}
