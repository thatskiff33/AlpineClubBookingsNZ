import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";

const VALID_KEYS = ["hutFeesIncome", "hutFeeRefunds", "stripeBankAccount", "stripeFees", "subscriptionIncome"] as const;

/**
 * GET /api/admin/xero/account-mappings
 * Returns all Xero account code mappings.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  try {
    const mappings = await prisma.xeroAccountMapping.findMany({
      select: { key: true, code: true },
    });

    // Return as a key→code object for easy consumption
    const result: Record<string, string | null> = {};
    for (const key of VALID_KEYS) {
      result[key] = null;
    }
    for (const m of mappings) {
      result[m.key] = m.code;
    }

    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch account mappings";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

const UpdateMappingsSchema = z.object({
  hutFeesIncome: z.string().nullable().optional(),
  hutFeeRefunds: z.string().nullable().optional(),
  stripeBankAccount: z.string().nullable().optional(),
  stripeFees: z.string().nullable().optional(),
  subscriptionIncome: z.string().nullable().optional(),
});

/**
 * PUT /api/admin/xero/account-mappings
 * Updates Xero account code mappings. Accepts partial updates.
 */
export async function PUT(request: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
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
    const ops = (Object.entries(updates) as [typeof VALID_KEYS[number], string | null | undefined][])
      .filter(([, val]) => val !== undefined)
      .map(([key, code]) =>
        prisma.xeroAccountMapping.upsert({
          where: { key },
          update: { code: code ?? null },
          create: { key, code: code ?? null },
        })
      );

    await Promise.all(ops);

    await logAudit({
      action: "xero_account_mappings_updated",
      memberId: session.user.id,
      details: JSON.stringify(updates),
    });

    // Return the full updated set
    const all = await prisma.xeroAccountMapping.findMany({
      select: { key: true, code: true },
    });
    const result: Record<string, string | null> = {};
    for (const key of VALID_KEYS) {
      result[key] = null;
    }
    for (const m of all) {
      result[m.key] = m.code;
    }

    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update account mappings";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
