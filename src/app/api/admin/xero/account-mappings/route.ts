import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/session-guards";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import {
  XERO_MAPPING_WRITABLE_KEYS,
  normalizeMappingCode,
  type XeroMappingWritableKey,
} from "@/lib/xero-account-mapping-keys";

// The writable key set comes from the ONE registry (#2717): adding a mapping
// key used to mean editing this allowlist, this zod schema, the admin picker's
// key list and the runtime defaults, with nothing failing if you edited three.
// entranceFeeAmountCents is deliberately absent from that registry (#1931, E5):
// the legacy flat joining-fee amount is no longer read at runtime (amounts are
// authoritative in the JoiningFee schedule, migrated on upgrade), so exposing
// it as a writable mapping would accept edits that silently have no effect. The
// stored row (if any) is retained untouched for provenance until E13.
const VALID_KEYS = XERO_MAPPING_WRITABLE_KEYS;

type SerialisedMapping = {
  /**
   * Normalised (#2717): a blank stored code is reported as `null`, because
   * blank is not a choice. The Xero setup screen asks
   * `isCodeExplicitlyConfigured` of the code it is SHOWING — which during an
   * edit is the staged one — rather than reading a configuredness flag from
   * here, which would describe the saved code and go stale the moment an
   * officer cleared the field.
   */
  code: string | null;
  itemCode: string | null;
};

/** Every writable key, present whether or not a row exists for it. */
function serialiseMappings(
  rows: Array<{ key: string; code: string | null; itemCode: string | null }>,
): Record<string, SerialisedMapping> {
  const result: Record<string, SerialisedMapping> = {};
  for (const key of VALID_KEYS) {
    result[key] = { code: null, itemCode: null };
  }
  for (const row of rows) {
    result[row.key] = {
      code: normalizeMappingCode(row.code),
      itemCode: row.itemCode,
    };
  }
  return result;
}

/**
 * GET /api/admin/xero/account-mappings
 * Returns all Xero account code and item code mappings.
 */
export async function GET() {
  const guard = await requireAdmin({
    permission: { area: "finance", level: "view" },
  });
  if (!guard.ok) return guard.response;
  try {
    const mappings = await prisma.xeroAccountMapping.findMany({
      select: { key: true, code: true, itemCode: true },
    });

    return NextResponse.json(serialiseMappings(mappings));
  } catch (error) {
    logger.error({ err: error }, "Failed to fetch account mappings");
    return NextResponse.json({ error: "Failed to fetch account mappings" }, { status: 500 });
  }
}

const MappingValueSchema = z.object({
  // A blank code is refused rather than stored (#2717). Stored blank, it read as
  // an explicit choice, which disengaged the key's fallback and sent an empty
  // accountCode to Xero — which rejects it, so the outbox retried for ever.
  // Clearing a mapping is `null`, which is a different and supported thing.
  code: z.string().trim().min(1).nullable().optional(),
  itemCode: z.string().trim().min(1).nullable().optional(),
});

const UpdateMappingsSchema = z.object(
  Object.fromEntries(
    VALID_KEYS.map((key) => [key, MappingValueSchema.optional()]),
  ) as Record<XeroMappingWritableKey, z.ZodOptional<typeof MappingValueSchema>>,
);

/**
 * PUT /api/admin/xero/account-mappings
 * Updates Xero account code and item code mappings. Accepts partial updates.
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

  const parsed = UpdateMappingsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }

  const updates = parsed.data;

  try {
    type MappingValue = { code?: string | null; itemCode?: string | null };
    const ops = (Object.entries(updates) as [XeroMappingWritableKey, MappingValue | undefined][])
      .filter(([, val]) => val !== undefined)
      .map(([key, val]) => {
        const updateData: { code?: string | null; itemCode?: string | null } = {};
        if (val!.code !== undefined) updateData.code = val!.code ?? null;
        if (val!.itemCode !== undefined) updateData.itemCode = val!.itemCode ?? null;
        return prisma.xeroAccountMapping.upsert({
          where: { key },
          update: updateData,
          create: { key, code: updateData.code ?? null, itemCode: updateData.itemCode ?? null },
        });
      });

    await Promise.all(ops);

    await logAudit({
      action: "xero_account_mappings_updated",
      category: "xero",
      memberId: session.user.id,
      details: JSON.stringify(updates),
    });

    // Return the full updated set
    const all = await prisma.xeroAccountMapping.findMany({
      select: { key: true, code: true, itemCode: true },
    });

    return NextResponse.json(serialiseMappings(all));
  } catch (error) {
    logger.error({ err: error }, "Failed to update account mappings");
    return NextResponse.json({ error: "Failed to update account mappings" }, { status: 500 });
  }
}
