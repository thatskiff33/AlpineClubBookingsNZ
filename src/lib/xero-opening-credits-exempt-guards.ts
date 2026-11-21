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
 *    is, or is scheduled to be, GST-registered: the reverse of 2.
 *
 * A GST REGISTRATION IS NEVER REFUSED for this (owner decision, 22 Nov 2026,
 * https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/4988#issuecomment-7070628422:
 * "allow, warn instead"). A club that mapped Opening Credits while unregistered
 * needed no Exempt mapping, and may schedule a registration without one. The
 * warning is the Xero health check, which carries a problem while Opening
 * Credits is mapped, a registered period applies or is scheduled, and Exempt
 * has no usable rate (`openingCreditsExemptHealthProblem`), and the outbox
 * hold, under which each spent opening credit waits until Exempt is mapped.
 *
 * The decisions are #5209's pure functions; this module only reads what they
 * need, outside any transaction (`INV-LOCK-004`). The sender's own refusal
 * (`XeroTaxCategoryUnavailableError`, held by the outbox) stays the backstop
 * for what a screen cannot stop: a rate edited in Xero, a reconnect to another
 * organisation, or two saves racing.
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
 * (`openingCreditsAccountConflicts`, which never counts the key itself).
 *
 * The message names roles, never the account code: the mapping screen reads a
 * bare "403" in a refusal as "not permitted", and an account can carry that code.
 */
export function openingCreditsSharedAccountProblem(rows: readonly MappingCodeRow[]): string | null {
  const conflicts = openingCreditsAccountConflicts({
    openingCreditsCode: rows.find((row) => row.key === OPENING_CREDITS_MAPPING_KEY)?.code,
    mappings: rows,
  });
  if (conflicts.length === 0) return null;
  const roles = listInWords(conflicts.map((key) => MAPPING_LABELS[key] ?? key));
  return `Opening Credits cannot use the same Xero account as ${roles}. Choose an account for Opening Credits that no other mapping uses, or change the other mapping first. Nothing was saved.`;
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
 * The config import's warning (`config-transfer/categories/xero-config.ts`), or
 * null: the bundle sets or changes the Opening Credits account, the club is, or
 * is scheduled to be, GST-registered, and no Exempt mapping exists in the
 * connected Xero organisation. A warning, not a refusal: the import still
 * applies, and the health check and the outbox hold cover the state.
 *
 * The plan runs a second time inside the apply's transaction, so every read
 * goes through the caller's client (`INV-LOCK-004`) and Xero is not asked. A
 * mapped rate that Xero has since changed is therefore not judged here; the
 * health check reports that.
 */
export async function openingCreditsImportExemptWarning({
  db,
  stored,
  after,
  today,
}: {
  db: Pick<Prisma.TransactionClient, "clubTaxSettings" | "xeroConnection" | "xeroTaxCategoryMapping">;
  stored: readonly MappingCodeRow[];
  after: readonly MappingCodeRow[];
  today: CalendarDate;
}): Promise<string | null> {
  if (!setsOrChangesOpeningCredits(stored, after)) return null;
  const [schedule, mappings] = await Promise.all([loadClubTaxSchedule(db), loadXeroTaxCategoryMappings(db)]);
  if (mappedTaxTypeFor(mappings, "EXEMPT") !== null) return null;
  const problem = exemptPrerequisiteProblem({ schedule, today, exemptTaxType: null, rates: null });
  if (problem === null) return null;
  return `${OPENING_CREDITS_NEEDS_EXEMPT} ${problem} The import still sets the account; until Exempt is mapped, spent opening credits wait in the Xero queue.`;
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
 * Why the Exempt mapping may not be cleared, or null when it may
 * (`clearXeroTaxCategory`). While the Opening Credits account is mapped and the
 * club is, or is scheduled to be, GST-registered, every spent opening credit
 * needs the Exempt rate; without it each one would wait in the Xero queue.
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
  // A row chosen in another Xero organisation already reads as unmapped: no
  // line is sent with it, so clearing it strands nothing and is allowed.
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
  return "Opening Credits is mapped and the club is, or is scheduled to be, GST-registered, but the Exempt tax category has no usable Xero tax rate, so spent opening credits wait, or will wait, in the Xero queue. A Full Admin maps Exempt to a 0% rate on the Xero setup screen, or unmaps the Opening Credits account under Account Mappings.";
}
