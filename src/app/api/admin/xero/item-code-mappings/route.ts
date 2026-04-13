import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";

const AGE_TIERS = ["INFANT", "CHILD", "YOUTH", "ADULT"] as const;
const SEASON_TYPES = ["WINTER", "SUMMER"] as const;
const ENTRANCE_FEE_CATEGORIES = ["ADULT", "YOUTH", "CHILD", "FAMILY"] as const;

/**
 * GET /api/admin/xero/item-code-mappings
 * Returns all granular Xero item code mappings grouped by category.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  try {
    const rows = await prisma.xeroItemCodeMapping.findMany();

    // Build hut fee matrix: key = "ADULT_WINTER_true" → { itemCode }
    const hutFees: Record<string, { itemCode: string }> = {};
    // Build entrance fee map: key = "ADULT" → { itemCode, amountCents }
    const entranceFees: Record<string, { itemCode: string; amountCents: number | null }> = {};

    for (const row of rows) {
      if (row.category === "HUT_FEE" && row.ageTier && row.seasonType && row.isMember !== null) {
        const key = `${row.ageTier}_${row.seasonType}_${row.isMember}`;
        hutFees[key] = { itemCode: row.itemCode };
      } else if (row.category === "ENTRANCE_FEE" && row.entranceFeeCategory) {
        entranceFees[row.entranceFeeCategory] = {
          itemCode: row.itemCode,
          amountCents: row.amountCents,
        };
      }
    }

    return NextResponse.json({ hutFees, entranceFees });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch item code mappings";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// -- Zod schemas for PUT --

const HutFeeEntrySchema = z.object({
  itemCode: z.string().min(1, "Item code is required"),
});

const EntranceFeeEntrySchema = z.object({
  itemCode: z.string().min(1, "Item code is required"),
  amountCents: z.number().int().min(0).nullable(),
});

const UpdateItemCodeMappingsSchema = z.object({
  hutFees: z.record(z.string(), HutFeeEntrySchema.nullable()).optional(),
  entranceFees: z.record(z.enum(ENTRANCE_FEE_CATEGORIES), EntranceFeeEntrySchema.nullable()).optional(),
});

/**
 * PUT /api/admin/xero/item-code-mappings
 * Upserts granular Xero item code mappings. Accepts partial updates.
 *
 * Body shape:
 * {
 *   hutFees: { "ADULT_WINTER_true": { itemCode: "HUTFEE-001" }, ... },
 *   entranceFees: { "ADULT": { itemCode: "ENTFEE-001", amountCents: 5000 }, ... }
 * }
 *
 * Sending null for a key deletes that mapping.
 */
export async function PUT(request: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

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

  try {
    const ops: Promise<unknown>[] = [];

    // Process hut fee entries
    if (hutFees) {
      for (const [compositeKey, value] of Object.entries(hutFees)) {
        // Parse composite key: "ADULT_WINTER_true"
        const parts = compositeKey.split("_");
        if (parts.length !== 3) continue;
        const [ageTierStr, seasonTypeStr, isMemberStr] = parts;
        if (!AGE_TIERS.includes(ageTierStr as typeof AGE_TIERS[number])) continue;
        if (!SEASON_TYPES.includes(seasonTypeStr as typeof SEASON_TYPES[number])) continue;
        if (isMemberStr !== "true" && isMemberStr !== "false") continue;

        const ageTier = ageTierStr as typeof AGE_TIERS[number];
        const seasonType = seasonTypeStr as typeof SEASON_TYPES[number];
        const isMember = isMemberStr === "true";

        if (value === null) {
          // Delete this mapping
          ops.push(
            prisma.xeroItemCodeMapping.deleteMany({
              where: { category: "HUT_FEE", ageTier, seasonType, isMember },
            })
          );
        } else {
          ops.push(
            prisma.xeroItemCodeMapping.upsert({
              where: {
                category_ageTier_seasonType_isMember: {
                  category: "HUT_FEE",
                  ageTier,
                  seasonType,
                  isMember,
                },
              },
              update: { itemCode: value.itemCode },
              create: {
                category: "HUT_FEE",
                ageTier,
                seasonType,
                isMember,
                itemCode: value.itemCode,
              },
            })
          );
        }
      }
    }

    // Process entrance fee entries
    if (entranceFees) {
      for (const [category, value] of Object.entries(entranceFees)) {
        const entranceFeeCategory = category as typeof ENTRANCE_FEE_CATEGORIES[number];
        if (!ENTRANCE_FEE_CATEGORIES.includes(entranceFeeCategory)) continue;

        if (value === null) {
          ops.push(
            prisma.xeroItemCodeMapping.deleteMany({
              where: { category: "ENTRANCE_FEE", entranceFeeCategory },
            })
          );
        } else {
          ops.push(
            prisma.xeroItemCodeMapping.upsert({
              where: {
                category_entranceFeeCategory: {
                  category: "ENTRANCE_FEE",
                  entranceFeeCategory,
                },
              },
              update: {
                itemCode: value.itemCode,
                amountCents: value.amountCents,
              },
              create: {
                category: "ENTRANCE_FEE",
                entranceFeeCategory,
                itemCode: value.itemCode,
                amountCents: value.amountCents,
              },
            })
          );
        }
      }
    }

    await Promise.all(ops);

    await logAudit({
      action: "xero_item_code_mappings_updated",
      memberId: session.user.id,
      details: JSON.stringify({ hutFees, entranceFees }),
    });

    // Return the full updated set (reuse GET logic)
    const rows = await prisma.xeroItemCodeMapping.findMany();
    const resultHutFees: Record<string, { itemCode: string }> = {};
    const resultEntranceFees: Record<string, { itemCode: string; amountCents: number | null }> = {};
    for (const row of rows) {
      if (row.category === "HUT_FEE" && row.ageTier && row.seasonType && row.isMember !== null) {
        resultHutFees[`${row.ageTier}_${row.seasonType}_${row.isMember}`] = { itemCode: row.itemCode };
      } else if (row.category === "ENTRANCE_FEE" && row.entranceFeeCategory) {
        resultEntranceFees[row.entranceFeeCategory] = {
          itemCode: row.itemCode,
          amountCents: row.amountCents,
        };
      }
    }

    return NextResponse.json({ hutFees: resultHutFees, entranceFees: resultEntranceFees });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update item code mappings";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
