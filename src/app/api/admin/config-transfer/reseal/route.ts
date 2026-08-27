import { NextResponse } from "next/server";

import { resealBundle } from "@/lib/config-transfer/bundle";
import {
  readBundleUpload,
  requireFullAdminForConfigTransfer,
} from "@/lib/config-transfer/route-helpers";
import { configTransferErrorResponse } from "@/lib/config-transfer/route-error";
import { clubTime } from "@/lib/club-time/server";

// POST /api/admin/config-transfer/reseal — full-admin only.
// Accepts a hand-edited bundle (multipart 'bundle' file) and returns a copy with
// its manifest regenerated (fresh checksums, row counts, includedCategories,
// and a doorCodesIncluded flag recomputed from the actual files), so it imports
// without integrity warnings. Read-only; no DB mutation. ADR-001 "hand-edit".

export async function POST(request: Request) {
  const guard = await requireFullAdminForConfigTransfer();
  if (!guard.ok) return guard.response;

  const uploaded = await readBundleUpload(request);
  if (!uploaded.ok) return uploaded.response;

  try {
    const zip = resealBundle(uploaded.upload.bytes);
    // The club's calendar day, from the PERSISTED club timezone (CT-4, #2870).
    const stamp = (await clubTime()).today();
    return new NextResponse(new Uint8Array(zip), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="config-transfer-resealed-${stamp}.zip"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return configTransferErrorResponse("Reseal", error);
  }
}
