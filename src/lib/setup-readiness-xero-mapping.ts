import { getAdminPage } from "@/lib/admin-hubs";
import { xeroMappingHref } from "@/lib/admin-hubs/xero-setup";
import {
  ACCOUNT_MAPPING_FALLBACK_KEYS,
  ACCOUNT_MAPPING_KEYS,
  ACCOUNT_MAPPING_KEYS_ASKING_WHILE_UNSET,
  describeMappingOwnWhileUnset,
  isCodeExplicitlyConfigured,
  mappingCodeClassViolation,
  MAPPING_LABELS,
  type AccountMappingKey,
} from "@/lib/xero-account-mapping-keys";

/**
 * The setup checklist's Xero Mappings step: what it reads from the stored
 * mapping rows and what it says about them. Split out of `setup-readiness.ts`
 * (#5235) so the step's rules sit in one place beside the registry they read.
 */

/** The part of the setup database snapshot the Xero Mappings step reads. */
export interface XeroMappingSetupSnapshot {
  xeroAccountMappingCount: number;
  /**
   * Labels of the mapping keys that have a registered fallback and are still
   * unset (#2717, `INV-INT-021`). The count above says nothing about them — it
   * counts any row carrying a code, so an upgrading club reads "configured" on
   * the very day a new key ships, which is the silence the owner rejected.
   * Optional for callers that took no database snapshot.
   */
  xeroUnsetFallbackMappingLabels?: string[];
  /**
   * `INV-INT-021`, #3529: one sentence per unset asking key — "Label: what the
   * system does without it" — so the checklist can say WHY a choice is waiting
   * for a key that has no fallback (a bank-transfer refund note raised without
   * a settling payment) as well as for one that does. Same population as the
   * labels above, in the same order.
   */
  xeroUnsetMappingConsequences?: string[];
  /**
   * #5235: one sentence per stored account code that the cached chart of
   * accounts shows is the wrong kind of account for its mapping. The save and
   * the configuration import refuse such a code when it is set or changed
   * (`mappingCodeClassViolation`, the source of each sentence); this reports
   * one stored before that check, written while no chart was cached, or whose
   * account changed in Xero since. Entries keep posting to it until an officer
   * chooses another account.
   */
  xeroMappingAccountKindProblems?: string[];
  xeroHutFeeItemMappingCount: number;
  xeroEntranceFeeMappingCount: number;
}

/**
 * The mapping keys that are asking to be decided while they are unset
 * (`INV-INT-021`), in two kinds the checklist must NOT conflate: one working
 * off another key's mapping (`ACCOUNT_MAPPING_FALLBACK_KEYS`, "using a
 * fallback"), and one that declares what the system does without it and has
 * no fallback (#3529: its own `whileUnset` sentence). Both straight off the
 * registry, so a new key of either kind is surfaced without anybody
 * remembering to add it — and a key of the second kind is never described as
 * falling back, which its registry entry says it does not.
 */
const ACCOUNT_MAPPING_KEYS_ASKING = ACCOUNT_MAPPING_KEYS_ASKING_WHILE_UNSET;
const ACCOUNT_MAPPING_KEYS_WITH_FALLBACK = Object.keys(
  ACCOUNT_MAPPING_FALLBACK_KEYS,
) as AccountMappingKey[];

/**
 * What the stored mapping rows say to the checklist: which keys are still
 * undecided, and which hold a code the chart shows is the wrong kind of
 * account. `chart` is the cached chart of accounts, or null when none is
 * cached, in which case no code is judged.
 */
export function describeStoredXeroMappings(
  rows: readonly { key: string; code: string | null }[],
  chart: Parameters<typeof mappingCodeClassViolation>[2],
): Required<
  Pick<
    XeroMappingSetupSnapshot,
    "xeroUnsetFallbackMappingLabels" | "xeroUnsetMappingConsequences" | "xeroMappingAccountKindProblems"
  >
> {
  const stored = (key: AccountMappingKey) => rows.find((row) => row.key === key) ?? null;
  return {
    xeroUnsetFallbackMappingLabels: ACCOUNT_MAPPING_KEYS_WITH_FALLBACK.filter(
      (key) => !isCodeExplicitlyConfigured(stored(key)),
    ).map((key) => MAPPING_LABELS[key] ?? key),
    xeroUnsetMappingConsequences: ACCOUNT_MAPPING_KEYS_ASKING.flatMap((key) => {
      const own = describeMappingOwnWhileUnset(key);
      if (own === null) return [];
      return isCodeExplicitlyConfigured(stored(key)) ? [] : [`${MAPPING_LABELS[key] ?? key}: ${own}`];
    }),
    // The same question the save and the import ask of a new code
    // (`mappingCodeClassViolation`), asked of the codes already stored.
    xeroMappingAccountKindProblems: ACCOUNT_MAPPING_KEYS.flatMap(
      (key) => mappingCodeClassViolation(key, stored(key)?.code, chart) ?? [],
    ),
  };
}

export function buildXeroMappingCheck(db: XeroMappingSetupSnapshot | undefined): {
  id: "xero-mappings";
  title: string;
  description: string;
  status: "complete" | "warning";
  required: false;
  message: string;
  details: string[];
  href: string;
} {
  const base = {
    id: "xero-mappings" as const,
    title: "Xero Mappings",
    description: "Chart of accounts, hut fee item codes, and joining-fee categories.",
    required: false as const,
    href: xeroMappingHref(),
  };
  if (!db) {
    return {
      ...base,
      status: "warning",
      message: "Xero mapping database state was not checked.",
      details: [`Review mappings in ${getAdminPage("xero-setup").label} after connecting Xero.`],
    };
  }

  const accountMappings = db.xeroAccountMappingCount ?? 0;
  const hutFeeMappings = db.xeroHutFeeItemMappingCount ?? 0;
  const entranceFeeMappings = db.xeroEntranceFeeMappingCount ?? 0;
  // A mapping that is falling back is a mapping nobody has decided (#2717,
  // `INV-INT-021`). The owner's decision rejected silence, and the account
  // count cannot see this: it counts rows with a code, so every upgrading club
  // would read "configured" while a new key was quietly unset.
  const unsetFallbackMappings = db.xeroUnsetFallbackMappingLabels ?? [];
  // A key with no fallback that says what happens without it (#3529) is the
  // same undecided state, and is named separately so it is never called a
  // fallback. The label is the text before the first ": ".
  const unsetMappingConsequences = db.xeroUnsetMappingConsequences ?? [];
  const unsetConsequenceLabels = unsetMappingConsequences.map(
    (sentence) => sentence.split(": ")[0] ?? sentence,
  );
  const unsetMappings = [...unsetFallbackMappings, ...unsetConsequenceLabels];
  // A stored code the chart shows is the wrong kind of account (#5235). It is
  // reported ahead of an undecided mapping: entries are posting to it now.
  const accountKindProblems = db.xeroMappingAccountKindProblems ?? [];
  const mapped = accountMappings > 0 && hutFeeMappings > 0 && entranceFeeMappings > 0;
  const complete = mapped && unsetMappings.length === 0 && accountKindProblems.length === 0;

  return {
    ...base,
    status: complete ? "complete" : "warning",
    message: complete
      ? "Xero account and item mappings are configured."
      : !mapped
        ? "Map Xero accounts and item codes before using live Xero sync."
        : accountKindProblems.length > 0
          ? "At least one account mapping uses the wrong kind of Xero account, and entries keep posting to it until you choose another. The details name each one."
          : unsetConsequenceLabels.length === 0
            ? `Choose an account for ${unsetMappings.join(" and ")} — until you do, those entries keep posting where they did before.`
            : `Choose an account for ${unsetMappings.join(" and ")} — the details say what happens until you do.`,
    details: [
      `Account mappings: ${accountMappings}`,
      ...accountKindProblems.map((sentence) => `Wrong kind of account: ${sentence}`),
      ...(unsetFallbackMappings.length > 0
        ? [`Not chosen yet, using a fallback: ${unsetFallbackMappings.join(", ")}`]
        : []),
      ...unsetMappingConsequences.map((sentence) => `Not chosen yet — ${sentence}`),
      `Hut fee item mappings: ${hutFeeMappings}`,
      `Joining fee mappings: ${entranceFeeMappings}`,
    ],
  };
}
