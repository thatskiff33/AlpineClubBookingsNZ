import { NextResponse } from "next/server";
import { z } from "zod";

import { parseJsonRequestBody } from "@/lib/api-json";
import logger from "@/lib/logger";
import { isSingletonUpsertContention } from "@/lib/prisma-errors";
import { requireAdmin } from "@/lib/session-guards";
import { MAPPED_XERO_TAX_CATEGORIES, type MappedXeroTaxCategory } from "@/lib/xero-tax-categories";
import { readXeroTaxCategoryAdminState } from "@/lib/xero-tax-category-admin-state";
import {
  clearXeroTaxCategory,
  mapXeroTaxCategory,
  type XeroTaxCategoryWriteOutcome,
  type XeroTaxCategoryWriteRefusal,
} from "@/lib/xero-tax-category-write";

/**
 * The club's tax categories mapped to its Xero organisation's tax rates (#5209;
 * `INV-CONFIG-008`), behind the "Tax categories" card on the Xero screens.
 *
 * FINANCE READS; ONLY A FULL ADMIN CHANGES, exactly as `/api/admin/club-tax`:
 * `GET` is `finance:view`, the area `/api/admin/xero` is registered under;
 * `PUT` and `DELETE` are `requireAdmin({ permission: false })`, stricter than
 * the map's `finance:edit`, and declared in `REVIEWED_PERMISSION_DIVERGENCES`.
 * A wrong mapping changes the tax code on every line Xero receives in that
 * category. The rules on what may be saved are `xero-tax-category-write.ts`.
 */

const category = z.enum(MAPPED_XERO_TAX_CATEGORIES as [MappedXeroTaxCategory, ...MappedXeroTaxCategory[]]);
const mapSchema = z.object({ category, taxType: z.string().trim().min(1).max(50) }).strict();
const clearSchema = z.object({ category }).strict();

export async function GET() {
  const guard = await requireAdmin({ permission: { area: "finance", level: "view" } });
  if (!guard.ok) return guard.response;
  return NextResponse.json({ state: await readXeroTaxCategoryAdminState() });
}

function refusalResponse(refusal: XeroTaxCategoryWriteRefusal) {
  switch (refusal.refused) {
    case "not-connected":
      return NextResponse.json(
        { error: "Xero is not connected, or was reconnected to another organisation. Reload the page and try again." },
        { status: 409 },
      );
    case "xero-unreadable":
      return NextResponse.json(
        { error: "Xero's tax rates could not be read, so the rate cannot be checked. Check the Xero connection and try again." },
        { status: 503 },
      );
    case "xero-code":
      return NextResponse.json({ error: refusal.message }, { status: 400 });
    case "unchanged":
      return NextResponse.json({ error: "That category is already mapped to that rate." }, { status: 400 });
    case "not-found":
      return NextResponse.json({ error: "That category is not mapped." }, { status: 404 });
    case "in-use":
      // #4988: Exempt while the Opening Credits account is mapped.
      return NextResponse.json({ error: refusal.message }, { status: 409 });
  }
}

async function answerWrite(run: () => Promise<XeroTaxCategoryWriteOutcome>) {
  try {
    const outcome = await run();
    if ("refused" in outcome) return refusalResponse(outcome);
    return NextResponse.json({ changed: true, state: await readXeroTaxCategoryAdminState() });
  } catch (error) {
    // Retryable, answered 503: Prisma's transaction contention, and P2002. The
    // only unique keys `xero-tax-category-write.ts` can hit are
    // XeroTaxCategoryMapping's `category` (two racing first saves of one
    // category; the Serializable loser wrote nothing) and the per-row cuids on
    // that table and AuditLog, which has no other unique constraint. The clear
    // path only deletes from the mapping.
    if (!isSingletonUpsertContention(error)) throw error;
    logger.warn({ err: error }, "Xero tax category mapping save hit write contention");
    return NextResponse.json({ error: "Another update is in progress — try again shortly." }, { status: 503 });
  }
}

export async function PUT(request: Request) {
  const guard = await requireAdmin({ permission: false });
  if (!guard.ok) return guard.response;

  const jsonBody = await parseJsonRequestBody(request, { error: "Invalid JSON" });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;
  const parsed = mapSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  return answerWrite(() => mapXeroTaxCategory({ ...parsed.data, actingMemberId: guard.session.user.id, request }));
}

export async function DELETE(request: Request) {
  const guard = await requireAdmin({ permission: false });
  if (!guard.ok) return guard.response;

  const jsonBody = await parseJsonRequestBody(request, { error: "Invalid JSON" });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;
  const parsed = clearSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  return answerWrite(() => clearXeroTaxCategory({ ...parsed.data, actingMemberId: guard.session.user.id, request }));
}
