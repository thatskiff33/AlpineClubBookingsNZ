import {
  BED_ALLOCATION_PRIORITY_VOCABULARY,
  DEFAULT_BED_ALLOCATION_SETTINGS,
} from "@/config/club-settings-defaults";

export { BED_ALLOCATION_PRIORITY_VOCABULARY };

export type BedAllocationPriority =
  (typeof BED_ALLOCATION_PRIORITY_VOCABULARY)[number];

export class BedAllocationSettingsValidationError extends Error {
  constructor(
    message: string,
    readonly status = 500,
  ) {
    super(message);
    this.name = "BedAllocationSettingsValidationError";
  }
}

const prioritySet = new Set<string>(BED_ALLOCATION_PRIORITY_VOCABULARY);

/**
 * The single closed-vocabulary boundary for saved/imported/planner priority
 * order. Omission is handled by the caller because it has different semantics
 * for a missing database row, an older bundle field, and an explicit payload.
 */
export function parseBedAllocationPriorityOrder(
  value: unknown,
  context = "allocationPriorityOrder",
  status = 500,
): BedAllocationPriority[] {
  if (!Array.isArray(value)) {
    throw new BedAllocationSettingsValidationError(
      `${context} must be an array of bed-allocation priorities.`, status,
    );
  }

  const parsed: BedAllocationPriority[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || !prioritySet.has(entry)) {
      throw new BedAllocationSettingsValidationError(
        `${context} contains an unknown bed-allocation priority.`, status,
      );
    }
    if (seen.has(entry)) {
      throw new BedAllocationSettingsValidationError(
        `${context} contains a duplicate bed-allocation priority.`, status,
      );
    }
    seen.add(entry);
    parsed.push(entry as BedAllocationPriority);
  }
  return parsed;
}

export interface BedAllocationSettingsRow {
  id: string;
  autoAllocationEnabled: boolean;
  allocationPriorityOrder: unknown;
  lodgeId?: string | null;
  updatedByMemberId?: string | null;
  updatedAt?: Date | null;
}

export interface EffectiveBedAllocationSettings {
  autoAllocationEnabled: boolean;
  allocationPriorityOrder: BedAllocationPriority[];
  authoritativeLodgeId: string | null;
  settingsId: string | null;
  source: "LODGE" | "LEGACY" | "DEFAULT";
  fallback:
    | "NONE"
    | "LEGACY_UNLINKED"
    | "LEGACY_LINKED"
    | "NO_RECORD"
    | "LEGACY_LINKED_ELSEWHERE";
  updatedByMemberId: string | null;
  updatedAt: string | null;
}

interface BedAllocationSettingsReadDb {
  bedAllocationSettings: {
    findUnique: (args: {
      where: { id: string };
    }) => Promise<BedAllocationSettingsRow | null>;
  };
}

function fromRow(
  row: BedAllocationSettingsRow,
  lodgeId: string | null,
  source: EffectiveBedAllocationSettings["source"],
  fallback: EffectiveBedAllocationSettings["fallback"],
): EffectiveBedAllocationSettings {
  return {
    autoAllocationEnabled: row.autoAllocationEnabled,
    allocationPriorityOrder: parseBedAllocationPriorityOrder(
      row.allocationPriorityOrder,
      `BedAllocationSettings(${row.id}).allocationPriorityOrder`,
    ),
    authoritativeLodgeId: lodgeId,
    settingsId: row.id,
    source,
    fallback,
    updatedByMemberId: row.updatedByMemberId ?? null,
    updatedAt: row.updatedAt?.toISOString() ?? null,
  };
}

/** Authoritative per-lodge resolver shared by board, settings, and lifecycle. */
export async function resolveEffectiveBedAllocationSettings(
  db: BedAllocationSettingsReadDb,
  lodgeId?: string | null,
): Promise<EffectiveBedAllocationSettings> {
  const authoritativeLodgeId = lodgeId ?? null;
  if (lodgeId && lodgeId !== "default") {
    const ownRow = await db.bedAllocationSettings.findUnique({
      where: { id: lodgeId },
    });
    if (ownRow) return fromRow(ownRow, lodgeId, "LODGE", "NONE");
  }

  const legacy = await db.bedAllocationSettings.findUnique({
    where: { id: "default" },
  });
  if (legacy && (!lodgeId || !legacy.lodgeId || legacy.lodgeId === lodgeId)) {
    return fromRow(
      legacy,
      authoritativeLodgeId,
      "LEGACY",
      legacy.lodgeId ? "LEGACY_LINKED" : "LEGACY_UNLINKED",
    );
  }

  return {
    autoAllocationEnabled: DEFAULT_BED_ALLOCATION_SETTINGS.autoAllocationEnabled,
    allocationPriorityOrder: [...DEFAULT_BED_ALLOCATION_SETTINGS.allocationPriorityOrder],
    authoritativeLodgeId,
    settingsId: null,
    source: "DEFAULT",
    fallback: legacy ? "LEGACY_LINKED_ELSEWHERE" : "NO_RECORD",
    updatedByMemberId: null,
    updatedAt: null,
  };
}
