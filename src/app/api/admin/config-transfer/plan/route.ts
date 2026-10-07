import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { buildImportPlan } from "@/lib/config-transfer/import";
import {
  readBundleUpload,
  requireFullAdminForConfigTransfer,
} from "@/lib/config-transfer/route-helpers";
import { configTransferErrorResponse } from "@/lib/config-transfer/route-error";
import { clubFormatValues } from "@/lib/club-format-server";

// POST /api/admin/config-transfer/plan — full-admin only.
// Dry-run: accepts an uploaded bundle (multipart 'bundle' file, plus mode /
// categories / resolutions) and returns the import plan (create/update/delete/unchanged
// per entity + fingerprint + warnings + blocking errors). Read-only. ADR-002.

export async function POST(request: Request) {
  const guard = await requireFullAdminForConfigTransfer();
  if (!guard.ok) return guard.response;

  const uploaded = await readBundleUpload(request);
  if (!uploaded.ok) return uploaded.response;
  const { bytes, mode, selectedCategories, resolutions } = uploaded.upload;

  // The club's format (#3565), resolved once per request.
  const format = await clubFormatValues();

  try {
    const plan = await buildImportPlan(prisma, bytes, {
      mode,
      selectedCategories,
      resolutions,
      format,
    });
    return NextResponse.json({ plan });
  } catch (error) {
    return configTransferErrorResponse("Preview", error);
  }
}
