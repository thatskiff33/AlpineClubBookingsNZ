import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { requireAdmin } from "@/lib/session-guards";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { holdsHutRateRows } from "@/lib/membership-type-rate-coverage";

const AGE_TIERS = ["INFANT", "CHILD", "YOUTH", "ADULT"] as const;
const SEASON_TYPES = ["WINTER", "SUMMER"] as const;
const ENTRANCE_FEE_CATEGORIES = ["ADULT", "YOUTH", "CHILD", "FAMILY"] as const;
const FLAT_KEY = "FLAT";

type AgeTierValue = (typeof AGE_TIERS)[number];
type SeasonTypeValue = (typeof SEASON_TYPES)[number];

// One parsed hut-fee composite key (#1930, E4):
// `${membershipTypeId}_${seasonType}_${ageTier|FLAT}`. `ageTier` null = the
// flat (all-ages) cell of an ageGroupsApply=false membership type.
interface HutFeeKeyParts {
  membershipTypeId: string;
  seasonType: SeasonTypeValue;
  ageTier: AgeTierValue | null;
}

/**
 * Parse a hut-fee composite key. Returns null for malformed keys — including
 * the retired `${ageTier}_${seasonType}_${isMember}` shape, which this endpoint
 * no longer reads or writes. The `isMember` column itself was dropped by the
 * #2130 STEP 2 contract migration
 * (20260721130000_contract_drop_ismember_and_agetier_xero_columns), so nothing
 * can write that shape any more; parsing it still returns null so an old
 * client or a hand-crafted key fails cleanly rather than half-matching.
 */
function parseHutFeeKey(compositeKey: string): HutFeeKeyParts | null {
  const parts = compositeKey.split("_");
  if (parts.length !== 3) return null;
  const [membershipTypeId, seasonTypeStr, tierStr] = parts;
  if (!membershipTypeId) return null;
  if (!SEASON_TYPES.includes(seasonTypeStr as SeasonTypeValue)) return null;
  if (tierStr !== FLAT_KEY && !AGE_TIERS.includes(tierStr as AgeTierValue)) {
    return null;
  }
  return {
    membershipTypeId,
    seasonType: seasonTypeStr as SeasonTypeValue,
    ageTier: tierStr === FLAT_KEY ? null : (tierStr as AgeTierValue),
  };
}

type ItemCodeMappingRow = {
  category: string;
  ageTier: string | null;
  seasonType: string | null;
  membershipTypeId: string | null;
  entranceFeeCategory: string | null;
  itemCode: string | null;
  amountCents: number | null;
};

// Blue/green runtime-prep (#2130): name ONLY the columns buildResponseBody
// reads so the deployed client stops SELECTing XeroItemCodeMapping.isMember
// before the #2130 contract migration drops that legacy key column. Matches
// ItemCodeMappingRow field-for-field, so the serialised response is unchanged.
const ITEM_CODE_MAPPING_SELECT = {
  category: true,
  ageTier: true,
  seasonType: true,
  membershipTypeId: true,
  entranceFeeCategory: true,
  itemCode: true,
  amountCents: true,
} as const;

// Blue/green runtime-prep (#2130), WRITE half. Prisma emits `RETURNING` over
// every scalar column of a create/update/upsert unless a `select` narrows it,
// so an unnarrowed mutation still names `isMember` even though the reads above
// no longer do — a draining old colour would keep issuing that SQL. Every
// mutation in this route discards its return value, so the minimal `id`
// projection is the correct narrowing: reusing the wider
// ITEM_CODE_MAPPING_SELECT would name columns no caller reads.
const ITEM_CODE_MAPPING_WRITE_SELECT = { id: true } as const;

/**
 * Serialise DB rows into the response shape. Hut fees are keyed by membership
 * type (#1930, E4); `membershipTypeId`-less HUT_FEE rows are hidden. The #2130
 * STEP 2 contract migration deleted the last of them along with the `isMember`
 * column, but the check is kept defensively — a fork's database or an older
 * bundle can still present one.
 */
function buildResponseBody(rows: ItemCodeMappingRow[]) {
  const hutFees: Record<string, { itemCode: string }> = {};
  const entranceFees: Record<string, { itemCode: string | null; amountCents: number | null }> = {};
  for (const row of rows) {
    if (
      row.category === "HUT_FEE" &&
      row.membershipTypeId &&
      row.seasonType &&
      row.itemCode
    ) {
      const key = `${row.membershipTypeId}_${row.seasonType}_${row.ageTier ?? FLAT_KEY}`;
      hutFees[key] = { itemCode: row.itemCode };
    } else if (row.category === "JOINING_FEE" && row.entranceFeeCategory) {
      entranceFees[row.entranceFeeCategory] = {
        itemCode: row.itemCode ?? null,
        amountCents: row.amountCents,
      };
    }
  }
  return { hutFees, entranceFees };
}

/**
 * GET /api/admin/xero/item-code-mappings
 * Returns all granular Xero item code mappings grouped by category. Hut-fee
 * keys are `${membershipTypeId}_${seasonType}_${ageTier|FLAT}` (#1930, E4).
 */
export async function GET() {
  const guard = await requireAdmin({
    permission: { area: "finance", level: "view" },
  });
  if (!guard.ok) return guard.response;
  try {
    const rows = await prisma.xeroItemCodeMapping.findMany({
      select: ITEM_CODE_MAPPING_SELECT,
    });
    return NextResponse.json(buildResponseBody(rows));
  } catch (error) {
    logger.error({ err: error }, "Failed to fetch item code mappings");
    return NextResponse.json({ error: "Failed to fetch item code mappings" }, { status: 500 });
  }
}

// -- Zod schemas for PUT --

const HutFeeEntrySchema = z.object({
  itemCode: z.string().min(1, "Item code is required"),
});

// amountCents is OPTIONAL and deprecated (#1931, E5): joining-fee amounts are
// authoritative in the JoiningFee schedule and this column is no longer read
// at runtime. The admin panel is item-code-only and omits it; when omitted the
// stored value is left untouched (never silently written), and the explicit
// null/null pair keeps its historical "clear the row" meaning.
const EntranceFeeEntrySchema = z.object({
  itemCode: z.string().min(1, "Item code is required").nullable(),
  amountCents: z.number().int().min(0).nullable().optional(),
});

const UpdateItemCodeMappingsSchema = z.object({
  hutFees: z.record(z.string(), HutFeeEntrySchema.nullable()).optional(),
  entranceFees: z.partialRecord(
    z.enum(ENTRANCE_FEE_CATEGORIES),
    EntranceFeeEntrySchema.nullable()
  ).optional(),
});

/**
 * PUT /api/admin/xero/item-code-mappings
 * Upserts granular Xero item code mappings. Accepts partial updates.
 *
 * Body shape (#1930, E4):
 * {
 *   hutFees: { "<membershipTypeId>_WINTER_ADULT": { itemCode: "HUTFEE-001" },
 *              "<membershipTypeId>_SUMMER_FLAT": { itemCode: "HUTFEE-002" }, ... },
 *   entranceFees: { "ADULT": { itemCode: "ENTFEE-001" | null }, ... }
 * }
 *
 * Hut-fee keys must reference a rate-bearing membership type (a MEMBER_RATE
 * type or the built-in NON_MEMBER type — the D2 invariant). The `FLAT` tier is
 * the single all-ages cell of an ageGroupsApply=false type. Sending null for a
 * key deletes that mapping. For joining fees, `amountCents` is optional and
 * deprecated (#1931 — amounts are authoritative in the JoiningFee schedule):
 * omitting it leaves the stored value untouched; sending both `itemCode` and
 * `amountCents` as explicit nulls clears the row; a null `itemCode` with no
 * `amountCents` blanks only the code.
 */
export async function PUT(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "finance", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = UpdateItemCodeMappingsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }

  const { hutFees, entranceFees } = parsed.data;

  // Parse + validate every hut-fee key BEFORE any write, so a bad payload
  // never half-applies.
  const hutFeeWrites: Array<{
    key: HutFeeKeyParts;
    value: { itemCode: string } | null;
  }> = [];
  const seenHutFeeCells = new Set<string>();
  for (const [compositeKey, value] of Object.entries(hutFees ?? {})) {
    const key = parseHutFeeKey(compositeKey);
    if (!key) {
      return NextResponse.json(
        {
          error: `Invalid hut fee mapping key "${compositeKey}". Expected "<membershipTypeId>_<WINTER|SUMMER>_<${AGE_TIERS.join("|")}|${FLAT_KEY}>".`,
        },
        { status: 400 }
      );
    }
    // App-side duplicate check (defensive: distinct raw keys cannot collide
    // after parsing, but the flat partial unique makes dupes a hard DB error,
    // so surface a friendly message instead).
    const cell = `${key.membershipTypeId}::${key.seasonType}::${key.ageTier ?? FLAT_KEY}`;
    if (seenHutFeeCells.has(cell)) {
      return NextResponse.json(
        { error: "Duplicate hut fee mapping for the same membership type, season, and age tier." },
        { status: 400 }
      );
    }
    seenHutFeeCells.add(cell);
    hutFeeWrites.push({ key, value });
  }

  try {
    // Referenced membership types must exist and must own hut rate rows: every
    // MEMBER_RATE type plus the two the engine resolves BY KEY (NON_MEMBER,
    // FULL), whose rows are read whatever the row itself says (D2 invariant,
    // `INV-MOD-007`; one home, `holdsHutRateRows`, #2933).
    const referencedTypeIds = [
      ...new Set(hutFeeWrites.map((write) => write.key.membershipTypeId)),
    ];
    if (referencedTypeIds.length > 0) {
      const types = await prisma.membershipType.findMany({
        where: { id: { in: referencedTypeIds } },
        select: { id: true, key: true, name: true, bookingBehavior: true },
      });
      const typeById = new Map(types.map((type) => [type.id, type]));
      for (const id of referencedTypeIds) {
        const type = typeById.get(id);
        if (!type) {
          return NextResponse.json(
            { error: `Unknown membership type: ${id}` },
            { status: 400 }
          );
        }
        if (!holdsHutRateRows(type)) {
          return NextResponse.json(
            { error: `Membership type "${type.name}" does not carry its own hut fees, so it cannot have hut fee item codes.` },
            { status: 400 }
          );
        }
      }
    }

    // Hut-fee writes. Tiered cells upsert on the composite unique; the flat
    // (NULL-ageTier) cell cannot use a compound-unique selector with null, so
    // it does an app-side find-then-write — races are backstopped by the
    // raw-SQL HUT_FEE flat partial unique index (P2002 -> friendly 400 below).
    for (const { key, value } of hutFeeWrites) {
      const { membershipTypeId, seasonType, ageTier } = key;
      if (value === null) {
        await prisma.xeroItemCodeMapping.deleteMany({
          where: { category: "HUT_FEE", membershipTypeId, seasonType, ageTier },
        });
      } else if (ageTier !== null) {
        await prisma.xeroItemCodeMapping.upsert({
          where: {
            category_membershipTypeId_seasonType_ageTier: {
              category: "HUT_FEE",
              membershipTypeId,
              seasonType,
              ageTier,
            },
          },
          update: { itemCode: value.itemCode },
          create: {
            category: "HUT_FEE",
            membershipTypeId,
            seasonType,
            ageTier,
            itemCode: value.itemCode,
          },
          select: ITEM_CODE_MAPPING_WRITE_SELECT,
        });
      } else {
        const existing = await prisma.xeroItemCodeMapping.findFirst({
          where: { category: "HUT_FEE", membershipTypeId, seasonType, ageTier: null },
          select: { id: true },
        });
        if (existing) {
          await prisma.xeroItemCodeMapping.update({
            where: { id: existing.id },
            data: { itemCode: value.itemCode },
            select: ITEM_CODE_MAPPING_WRITE_SELECT,
          });
        } else {
          await prisma.xeroItemCodeMapping.create({
            data: {
              category: "HUT_FEE",
              membershipTypeId,
              seasonType,
              ageTier: null,
              itemCode: value.itemCode,
            },
            select: ITEM_CODE_MAPPING_WRITE_SELECT,
          });
        }
      }
    }

    // Joining fee entries: item-code writes only unless an amount is sent
    // explicitly (#1931, E5 — amounts are authoritative in JoiningFee and the
    // panel no longer edits them; an omitted amountCents must never overwrite
    // the stored historical value).
    for (const [category, value] of Object.entries(entranceFees ?? {})) {
      const entranceFeeCategory = category as typeof ENTRANCE_FEE_CATEGORIES[number];
      if (!ENTRANCE_FEE_CATEGORIES.includes(entranceFeeCategory)) continue;

      if (value === null || (value.itemCode === null && value.amountCents === null)) {
        await prisma.xeroItemCodeMapping.deleteMany({
          where: { category: "JOINING_FEE", entranceFeeCategory },
        });
      } else if (value.itemCode === null && value.amountCents === undefined) {
        // Item-code-only clear: blank the code but keep the row (and its
        // frozen historical amount, still exported by config transfer).
        await prisma.xeroItemCodeMapping.updateMany({
          where: { category: "JOINING_FEE", entranceFeeCategory },
          data: { itemCode: null },
        });
      } else {
        const write: { itemCode: string | null; amountCents?: number | null } = {
          itemCode: value.itemCode,
        };
        if (value.amountCents !== undefined) write.amountCents = value.amountCents;
        await prisma.xeroItemCodeMapping.upsert({
          where: {
            category_entranceFeeCategory: {
              category: "JOINING_FEE",
              entranceFeeCategory,
            },
          },
          update: write,
          create: {
            category: "JOINING_FEE",
            entranceFeeCategory,
            ...write,
          },
          select: ITEM_CODE_MAPPING_WRITE_SELECT,
        });
      }
    }

    await logAudit({
      action: "xero_item_code_mappings_updated",
      category: "xero",
      memberId: session.user.id,
      details: JSON.stringify({ hutFees, entranceFees }),
    });

    // Return the full updated set (reuse GET logic)
    const rows = await prisma.xeroItemCodeMapping.findMany({
      select: ITEM_CODE_MAPPING_SELECT,
    });
    return NextResponse.json(buildResponseBody(rows));
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return NextResponse.json(
        { error: "Duplicate hut fee mapping for the same membership type, season, and age tier." },
        { status: 400 }
      );
    }
    logger.error({ err: error }, "Failed to update item code mappings");
    return NextResponse.json({ error: "Failed to update item code mappings" }, { status: 500 });
  }
}
