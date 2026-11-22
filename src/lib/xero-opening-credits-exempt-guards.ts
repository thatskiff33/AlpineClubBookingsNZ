import { loadClubTaxSchedule, type ClubTaxSchedule } from "@/lib/club-tax-settings";
import type { Prisma } from "@prisma/client";
import { clubToday, type CalendarDate } from "@/lib/club-time";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { prisma } from "@/lib/prisma";
import {
  MAPPING_LABELS,
  OPENING_CREDITS_MAPPING_KEY,
  isCodeExplicitlyConfigured,
  normalizeMappingCode,
} from "@/lib/xero-account-mapping-keys";
import {
  loadXeroTaxCategoryMappings,
  mappedTaxTypeFor,
  type XeroTaxCategoryMappings,
} from "@/lib/xero-tax-category-mappings";
import {
  exemptPrerequisiteProblem,
  openingCreditsAccountConflicts,
  registeredNowOrLater,
} from "@/lib/xero-tax-category-prerequisites";
import type { XeroTaxRateOption } from "@/lib/xero-tax-rate-options";
import { readXeroTaxRates } from "@/lib/xero-tax-rates";

/**
 * WHAT THE SETTINGS SCREENS REFUSE SO THE EXEMPT LINE CAN ALWAYS BE SENT
 * (#4988, on #5209's rules in `xero-tax-category-prerequisites.ts`;
 * `INV-PAY-162`, `INV-CONFIG-008`). A spent opening credit coded to the mapped
 * Opening Credits account is its own line in the Exempt tax category. Three
 * saves could leave that line unsendable or ambiguous, and each is refused with
 * a sentence saying what to do instead:
 *
 * 1. Opening Credits sharing its Xero account with another mapped role (owner
 *    decision, 21 Nov 2026, recorded on PR #5150: refuse the save).
 * 2. Mapping Opening Credits while the club is, or is scheduled to be,
 *    GST-registered and the Exempt category is not mapped to a rate Xero can
 *    carry (`exemptPrerequisiteProblem`; owner decision, 22 Nov 2026, #5375
 *    item 6: required only while a registered period is in force or scheduled).
 * 3. Clearing the Exempt mapping while Opening Credits is mapped and the club
 *    is, or is scheduled to be, GST-registered: the reverse of 2. Refused while
 *    Xero is disconnected too; only a mapping the connected organisation does
 *    not own may be cleared.
 *
 * A GST REGISTRATION IS NEVER REFUSED for this (owner decision, 22 Nov 2026,
 * https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/4988#issuecomment-7070628422:
 * "allow, warn instead"). A club that mapped Opening Credits while unregistered
 * needed no Exempt mapping, and may schedule a registration without one. The
 * warning is the Xero health check, which carries a problem while Opening
 * Credits is mapped, a registered period applies or is scheduled, and Exempt
 * has no usable rate (`openingCreditsExemptHealthProblem`), and the outbox
 * hold, under which each spent opening credit waits until Exempt is mapped. On
 * a card booking the mint runs inside the booking's invoice operation, which
 * fails instead and is retried by an officer (`CARD_BOOKING_FAILS_INSTEAD`).
 *
 * The decisions are #5209's pure functions; this module only reads what they
 * need, outside any transaction (`INV-LOCK-004`; the config import's plan is
 * the stated exception, on `openingCreditsImportFindings`). The sender's own
 * refusal (`XeroTaxCategoryUnavailableError`, held by the outbox) stays the
 * backstop for what a screen cannot stop: a rate edited in Xero, a reconnect
 * to another organisation, or two saves racing. Two racing saves can also
 * leave refusal 1's shared account stored (the save is not atomic, #5391);
 * the health check reports that state (`openingCreditsSharedAccountHealthProblem`).
 */

type MappingCodeRow = { key: string; code: string | null };

/** "a", "a and b", "a, b and c". */
function listInWords(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * Why these mapping codes cannot stand together, or null: Opening Credits is
 * mapped and another role's effective account is the same one
 * (`openingCreditsAccountConflicts`, which never counts the key itself). The
 * rule and what to do about it, in the one sentence every place that reports
 * the state opens with; each caller adds its own true ending.
 *
 * The message names roles, never the account code: the mapping screen reads a
 * bare "403" in a refusal as "not permitted", and an account can carry that code.
 */
function openingCreditsSharedAccountRule(rows: readonly MappingCodeRow[]): string | null {
  const conflicts = openingCreditsAccountConflicts({
    openingCreditsCode: rows.find((row) => row.key === OPENING_CREDITS_MAPPING_KEY)?.code,
    mappings: rows,
  });
  if (conflicts.length === 0) return null;
  const roles = listInWords(conflicts.map((key) => MAPPING_LABELS[key] ?? key));
  return `Opening Credits cannot use the same Xero account as ${roles}. Choose an account for Opening Credits that no other mapping uses, or change the other mapping first.`;
}

/** The rule as a refused write says it (the mapping screen's save, the config import's plan): nothing was written. */
function openingCreditsSharedAccountProblem(rows: readonly MappingCodeRow[]): string | null {
  const rule = openingCreditsSharedAccountRule(rows);
  return rule === null ? null : `${rule} No account mapping was saved.`;
}

/** The stored codes as they would read once `updates` is saved over them. */
function codesAfterSave(
  stored: readonly MappingCodeRow[],
  updates: Readonly<Record<string, { code?: string | null } | undefined>>,
): MappingCodeRow[] {
  const codes = new Map(stored.map((row) => [row.key, row.code]));
  for (const [key, update] of Object.entries(updates)) {
    if (update?.code !== undefined) codes.set(key, update.code);
  }
  return [...codes].map(([key, code]) => ({ key, code }));
}

/**
 * `exemptPrerequisiteProblem` over what is stored now. Xero's rates are read
 * fresh, and only when they are needed. `ratesUnreadable` says the problem is
 * that Xero could not be asked, which a retry may cure.
 */
async function readExemptPrerequisiteProblem(): Promise<{ problem: string | null; ratesUnreadable: boolean }> {
  const [schedule, zone, mappings] = await Promise.all([
    loadClubTaxSchedule(prisma),
    readClubTimeZoneOutsideRequest(),
    loadXeroTaxCategoryMappings(),
  ]);
  const today = clubToday(zone);
  const exemptTaxType = mappedTaxTypeFor(mappings, "EXEMPT");
  let rates: XeroTaxRateOption[] | null = null;
  let ratesUnreadable = false;
  if (exemptTaxType !== null && registeredNowOrLater(schedule, today)) {
    try {
      rates = await readXeroTaxRates({ fresh: true });
    } catch {
      ratesUnreadable = true;
    }
  }
  return { problem: exemptPrerequisiteProblem({ schedule, today, exemptTaxType, rates }), ratesUnreadable };
}

/** Whether the codes as they would read set the Opening Credits account, or change it. */
function setsOrChangesOpeningCredits(stored: readonly MappingCodeRow[], after: readonly MappingCodeRow[]): boolean {
  const codeOf = (rows: readonly MappingCodeRow[]) =>
    normalizeMappingCode(rows.find((row) => row.key === OPENING_CREDITS_MAPPING_KEY)?.code);
  const next = codeOf(after);
  return next !== null && next !== codeOf(stored);
}

/** A refused account-mapping save: its sentence, and whether trying again could succeed. */
export interface OpeningCreditsSaveRefusal {
  message: string;
  /** True only when Xero's tax rates could not be read: the same answer the tax category route gives. */
  retryable: boolean;
}

/**
 * Why an account-mapping save is refused, or null when it may be written
 * (`PUT /api/admin/xero/account-mappings`). `stored` is every mapping row as it
 * is now; `updates` is the validated body.
 *
 * The shared-account rule judges the codes as they would read AFTER the save,
 * so it also catches another role being moved onto the Opening Credits account.
 * The Exempt prerequisite is asked only when the save sets or changes the
 * Opening Credits code: the screen sends every key on every save, and a club
 * that mapped the account earlier must still be able to save its other
 * mappings while Xero's rates cannot be read.
 */
export async function openingCreditsMappingSaveRefusal({
  stored,
  updates,
}: {
  stored: readonly MappingCodeRow[];
  updates: Readonly<Record<string, { code?: string | null } | undefined>>;
}): Promise<OpeningCreditsSaveRefusal | null> {
  const after = codesAfterSave(stored, updates);
  const shared = openingCreditsSharedAccountProblem(after);
  if (shared) return { message: shared, retryable: false };

  if (!setsOrChangesOpeningCredits(stored, after)) return null;
  // Named, because the screen saves every mapping at once: the officer must be
  // told which one was refused. The route refuses before its first write.
  const { problem, ratesUnreadable } = await readExemptPrerequisiteProblem();
  if (problem === null) return null;
  return { message: `${OPENING_CREDITS_NEEDS_EXEMPT} ${problem} Nothing was saved.`, retryable: ratesUnreadable };
}

const OPENING_CREDITS_NEEDS_EXEMPT = "Opening Credits needs the Exempt tax category.";

/**
 * What a card booking does where another booking's spent opening credit waits
 * in the Xero queue: the mint runs inside the booking's invoice operation
 * (`settleCardAppliedCreditAllocation`, `xero-booking-invoices.ts`), whose
 * handler fails its own row, so nothing retries it until an officer does. The
 * moving-in guide's sentence (`docs/guides/moving-in.md`), said once here for
 * every message that tells an officer a spent opening credit waits.
 */
const CARD_BOOKING_FAILS_INSTEAD =
  "On a card booking, the booking's Xero invoice operation fails instead; retry it from the Xero Operations list once Exempt is mapped.";

/**
 * WHAT THE CONFIG IMPORT'S PLAN SAYS ABOUT OPENING CREDITS
 * (`config-transfer/categories/xero-config.ts`). An imported bundle writes the
 * same `XeroAccountMapping` rows the account mapping screen saves, so it is
 * held to the same rules, judged over every account code as it would read once
 * the bundle is applied (`after`, keyed by mapping key):
 *
 * - `error`, which blocks the apply: Opening Credits would share its Xero
 *   account with another mapped role. The owner's decision of 21 Nov 2026
 *   (refuse the save), read as covering every writer of these rows, in the
 *   screen's own sentence.
 * - `warning`, which does not: the bundle sets or changes the Opening Credits
 *   account, the club is, or is scheduled to be, GST-registered, and no Exempt
 *   mapping exists in the connected Xero organisation. The import still
 *   applies; the health check and the outbox hold cover the state.
 *
 * The plan runs a second time inside the apply's transaction, so the tax
 * schedule, the connection and the Exempt mapping are read through the
 * caller's client (`INV-LOCK-004`) and Xero is not asked. A mapped rate that
 * Xero has since changed is therefore not judged here; the health check
 * reports that. The club's time zone is the one read that does NOT go through
 * that client: `readClubTimeZoneOutsideRequest()` has no client parameter and
 * reads through the module one, so inside the apply it runs on another
 * connection, outside the transaction's snapshot. `INV-LOCK-004` has the zone
 * resolved before the transaction opens and passed in; the config import's
 * plan and apply contexts carry no zone, and the joining-fee fan-out in the
 * same category reads it the same way (`xero-config.ts`). It is one
 * primary-key read that only decides which day "today" is for the warning.
 * Nothing is read unless the bundle sets or changes the account.
 */
export async function openingCreditsImportFindings(
  db: Pick<Prisma.TransactionClient, "clubTaxSettings" | "xeroConnection" | "xeroTaxCategoryMapping">,
  storedRows: Iterable<MappingCodeRow>,
  after: ReadonlyMap<string, string | null>,
): Promise<{ error: string | null; warning: string | null }> {
  const stored = [...storedRows].map(({ key, code }) => ({ key, code }));
  const afterRows = [...after].map(([key, code]) => ({ key, code }));
  const error = openingCreditsSharedAccountProblem(afterRows);
  if (error || !setsOrChangesOpeningCredits(stored, afterRows)) return { error, warning: null };

  const [schedule, mappings, zone] = await Promise.all([
    loadClubTaxSchedule(db),
    loadXeroTaxCategoryMappings(db),
    readClubTimeZoneOutsideRequest(),
  ]);
  if (mappedTaxTypeFor(mappings, "EXEMPT") !== null) return { error: null, warning: null };
  const problem = exemptPrerequisiteProblem({ schedule, today: clubToday(zone), exemptTaxType: null, rates: null });
  return {
    error: null,
    warning:
      problem === null
        ? null
        : `${OPENING_CREDITS_NEEDS_EXEMPT} ${problem} The import still sets the account; until Exempt is mapped, spent opening credits wait in the Xero queue. ${CARD_BOOKING_FAILS_INSTEAD}`,
  };
}

/** Whether the club chose an Opening Credits account: the one read the checks below share. */
async function openingCreditsAccountIsMapped(): Promise<boolean> {
  const row = await prisma.xeroAccountMapping.findUnique({
    where: { key: OPENING_CREDITS_MAPPING_KEY },
    select: { code: true },
  });
  return isCodeExplicitlyConfigured(row);
}

/**
 * The clear refusal's sentence while Xero is not connected. Nothing is sent to
 * Xero in that state, so it must not say the category "is in use", and both
 * mapping panels are hidden until an organisation is connected, so the way out
 * it names starts with connecting.
 */
export const EXEMPT_CLEAR_REFUSED_WHILE_DISCONNECTED =
  "Xero is not connected, so the app cannot tell whether this Exempt mapping is the one the club will need when it reconnects. The Opening Credits account is mapped, and the club is, or is scheduled to be, GST-registered, so each spent opening credit needs the Exempt rate. Connect Xero first. Once connected, a mapping chosen in a different Xero organisation can be cleared; for the club's own organisation, unmap the Opening Credits account under Account Mappings first, then clear Exempt.";

/**
 * Why the Exempt mapping may not be cleared, or null when it may
 * (`clearXeroTaxCategory`). While the Opening Credits account is mapped and the
 * club is, or is scheduled to be, GST-registered, every spent opening credit
 * needs the Exempt rate; without it each one would wait in the Xero queue, or
 * fail its card booking's invoice operation.
 */
export async function exemptClearRefusalWhileOpeningCreditsMapped(): Promise<string | null> {
  const [mapped, schedule, zone, mappings] = await Promise.all([
    openingCreditsAccountIsMapped(),
    loadClubTaxSchedule(prisma),
    readClubTimeZoneOutsideRequest(),
    loadXeroTaxCategoryMappings(),
  ]);
  if (!mapped) return null;
  if (!registeredNowOrLater(schedule, clubToday(zone))) return null;
  // A row chosen in another Xero organisation than the one connected now
  // already reads as unmapped: no line is sent with it, so clearing it strands
  // nothing and is allowed. Only a connected organisation can show that.
  // Disconnecting deletes the connection row, and every row then reads as
  // unmapped, the club's own included: cleared in that state, it would be
  // missing when the same organisation is connected again, and spent opening
  // credits would stall. So while Xero is disconnected the refusal stands.
  if (mappings.tenantId === null) return EXEMPT_CLEAR_REFUSED_WHILE_DISCONNECTED;
  if (mappedTaxTypeFor(mappings, "EXEMPT") === null) return null;
  return "The Exempt tax category is in use: the Opening Credits account is mapped, and the club is, or is scheduled to be, GST-registered, so each spent opening credit is sent to Xero with the Exempt rate. Unmap the Opening Credits account under Account Mappings first, then clear Exempt.";
}

/**
 * The Xero health check's line for a state no screen refusal rules out
 * (`readXeroTaxHealth`; #5375 item 3): a registration scheduled after Opening
 * Credits was mapped (allowed by the owner's decision above), a rate edited in
 * Xero, a reconnect, or two saves racing. Null, or the line: Opening Credits is mapped, a
 * registered period applies today or is scheduled, and Exempt has no usable
 * rate in the connected organisation. Judged by #5209's rule. Rates that could
 * not be read are "not checked", which the health check already says, so only
 * a known fault is reported.
 */
export async function openingCreditsExemptHealthProblem({
  schedule,
  today,
  mappings,
  rates,
}: {
  schedule: ClubTaxSchedule;
  today: CalendarDate;
  mappings: XeroTaxCategoryMappings;
  rates: readonly XeroTaxRateOption[] | null;
}): Promise<string | null> {
  // Not connected: there is no organisation to judge against, and nothing sends.
  if (mappings.tenantId === null || !registeredNowOrLater(schedule, today)) return null;
  if (!(await openingCreditsAccountIsMapped())) return null;
  const exemptTaxType = mappedTaxTypeFor(mappings, "EXEMPT");
  if (exemptTaxType !== null && rates === null) return null;
  if (exemptPrerequisiteProblem({ schedule, today, exemptTaxType, rates }) === null) return null;
  return `Opening Credits is mapped and the club is, or is scheduled to be, GST-registered, but the Exempt tax category has no usable Xero tax rate, so spent opening credits wait, or will wait, in the Xero queue. ${CARD_BOOKING_FAILS_INSTEAD} A Full Admin maps Exempt to a 0% rate on the Xero setup screen, or unmaps the Opening Credits account under Account Mappings.`;
}

/**
 * The Xero health check's line for a shared Opening Credits account that is
 * already stored (`readXeroTaxHealth`). The mapping screen and the config
 * import refuse to create it, but the screen's check and its writes are not
 * one transaction, so two saves at once, or a save beside an import, can each
 * pass and both land (#5391 makes the save atomic). Null, or the line: the
 * same rule over the stored rows (`openingCreditsSharedAccountRule`), ending
 * with what is true here. Nothing was refused; the mappings are saved.
 *
 * Judged whether or not the club is GST-registered, as the refusal is (owner
 * decision, 21 Nov 2026). Like the health check's other mapping lines it says
 * nothing while Xero is not connected, when nothing is sent.
 */
export async function openingCreditsSharedAccountHealthProblem(mappings: XeroTaxCategoryMappings): Promise<string | null> {
  if (mappings.tenantId === null) return null;
  const rule = openingCreditsSharedAccountRule(
    await prisma.xeroAccountMapping.findMany({ select: { key: true, code: true } }),
  );
  return rule === null ? null : `${rule} The saved account mappings share that account now; change one of them under Account Mappings.`;
}
