import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";

const VALID_KEYS = [
  "hutFeesIncome", "hutFeeRefunds", "stripeBankAccount", "stripeFees", "subscriptionIncome",
  "membershipCancellationCredit", "hutFeeItem", "hutFeeRefundItem", "entranceFeeItem", "entranceFeeAmountCents",
] as const;

/**
 * GET /api/admin/xero/account-mappings
 * Returns all Xero account code and item code mappings.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  try {
    const mappings = await prisma.xeroAccountMapping.findMany({
      select: { key: true, code: true, itemCode: true },
    });

    // Return as a key→{code, itemCode} object for easy consumption
    const result: Record<string, { code: string | null; itemCode: string | null }> = {};
    for (const key of VALID_KEYS) {
      result[key] = { code: null, itemCode: null };
    }
    for (const m of mappings) {
      result[m.key] = { code: m.code, itemCode: m.itemCode };
    }

    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch account mappings";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

const MappingValueSchema = z.object({
  code: z.string().nullable().optional(),
  itemCode: z.string().nullable().optional(),
});

const UpdateMappingsSchema = z.object({
  hutFeesIncome: MappingValueSchema.optional(),
  hutFeeRefunds: MappingValueSchema.optional(),
  stripeBankAccount: MappingValueSchema.optional(),
  stripeFees: MappingValueSchema.optional(),
  subscriptionIncome: MappingValueSchema.optional(),
  membershipCancellationCredit: MappingValueSchema.optional(),
  hutFeeItem: MappingValueSchema.optional(),
  hutFeeRefundItem: MappingValueSchema.optional(),
  entranceFeeItem: MappingValueSchema.optional(),
  entranceFeeAmountCents: MappingValueSchema.optional(),
});

/**
 * PUT /api/admin/xero/account-mappings
 * Updates Xero account code and item code mappings. Accepts partial updates.
 */
export async function PUT(request: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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

  const parsed = UpdateMappingsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }

  const updates = parsed.data;

  try {
    type MappingValue = { code?: string | null; itemCode?: string | null };
    const ops = (Object.entries(updates) as [typeof VALID_KEYS[number], MappingValue | undefined][])
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
      memberId: session.user.id,
      details: JSON.stringify(updates),
    });

    // Return the full updated set
    const all = await prisma.xeroAccountMapping.findMany({
      select: { key: true, code: true, itemCode: true },
    });
    const result: Record<string, { code: string | null; itemCode: string | null }> = {};
    for (const key of VALID_KEYS) {
      result[key] = { code: null, itemCode: null };
    }
    for (const m of all) {
      result[m.key] = { code: m.code, itemCode: m.itemCode };
    }

    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update account mappings";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
