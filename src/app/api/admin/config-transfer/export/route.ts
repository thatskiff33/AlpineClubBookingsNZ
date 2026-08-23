import { NextResponse } from "next/server";
import { z } from "zod";

import { parseJsonRequestBody } from "@/lib/api-json";
import { createAuditLog } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { buildConfigExport } from "@/lib/config-transfer/export";
import { requireFullAdminForConfigTransfer } from "@/lib/config-transfer/route-helpers";
import { configTransferErrorResponse } from "@/lib/config-transfer/route-error";
import { CONFIG_TRANSFER_CATEGORIES } from "@/lib/config-transfer/manifest";
import { clubTime } from "@/lib/club-time/server";

// POST /api/admin/config-transfer/export — full-admin only.
// Builds a configuration bundle (zip) for the selected categories and returns it
// as a download. Read-only; no mutation. See docs/config-transfer.

const bodySchema = z.object({
  categories: z.array(z.enum(CONFIG_TRANSFER_CATEGORIES)).min(1),
  includeDoorCodes: z.boolean().default(false),
});

export async function POST(request: Request) {
  const guard = await requireFullAdminForConfigTransfer();
  if (!guard.ok) return guard.response;

  const json = await parseJsonRequestBody(request);
  if (!json.ok) return json.response;
  const parsed = bodySchema.safeParse(json.body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    // The source Xero org id is stamped by the Xero exporter into
    // xero-config/source.json (no longer the manifest), so the route no longer
    // needs to resolve it here.
    const result = await buildConfigExport({
      db: prisma,
      categories: parsed.data.categories,
      includeDoorCodes: parsed.data.includeDoorCodes,
      appVersion: process.env.npm_package_version ?? "unknown",
      prismaMigration: null,
      generatedAt: new Date().toISOString(),
    });

    await createAuditLog({
      action: "configuration.exported",
      memberId: guard.memberId,
      category: "admin",
      severity: "info",
      outcome: "success",
      summary: `Exported configuration bundle (${result.categories.join(", ") || "empty"})`,
      metadata: {
        categories: result.categories,
        includeDoorCodes: parsed.data.includeDoorCodes,
        entryCount: result.entryCount,
        imageCount: result.imageCount,
      },
    });

    // The club's calendar day, from the PERSISTED club timezone rather than the
    // container's `TZ` (CT-4, #2870; INV-CONFIG-002).
    const stamp = (await clubTime()).today();
    return new NextResponse(new Uint8Array(result.zip), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="config-transfer-${stamp}.zip"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return configTransferErrorResponse("Export", error);
  }
}
