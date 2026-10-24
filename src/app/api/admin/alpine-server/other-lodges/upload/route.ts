import "server-only";

import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/session-guards";
import { createAuditLog } from "@/lib/audit";
import { loadServerNzSettings } from "@/lib/servernz-settings";
import { uploadOtherClubsToServer } from "@/lib/servernz-other-lodges-sync";
import { respondSyncRunning, respondToSyncError } from "@/lib/servernz-sync-response";
import { withOtherLodgesSyncClaim } from "@/lib/servernz-sync-claim";
import { assertStoredServerVersionMatches } from "@/lib/servernz-api";

// POST /api/admin/alpine-server/other-lodges/upload — push this club's Other
// Clubs registry up to the central server using the stored API key.
export async function POST() {
  const guard = await requireAdmin({
    permission: { area: "finance", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  const settings = await loadServerNzSettings();
  if (!settings.otherLodgesEnabled) {
    return NextResponse.json(
      { error: "Other Clubs sync is disabled. Enable it first." },
      { status: 409 },
    );
  }

  try {
    // The recorded version FIRST (#66), as the nightly pass does: a pause is
    // answered as a pause, and never takes the claim. Only once a server
    // address is set, also as the nightly pass does, so a site with no usable
    // connection still hears "not configured" from the sync below.
    if (settings.baseUrl) assertStoredServerVersionMatches(settings.serverVersion);
    // Single-flight with the nightly pass and any other press (#66): a held
    // claim is refused with nothing sent, rather than run alongside it.
    const result = await withOtherLodgesSyncClaim(() => uploadOtherClubsToServer());
    if (result === null) return respondSyncRunning();
    await createAuditLog({
      action: "alpine_server.other_lodges.upload",
      category: "lodge",
      severity: "info",
      outcome: "success",
      memberId: guard.session.user.id,
      summary: "Uploaded Other Clubs to Alpine Central Server",
      details: `created ${result.created}, updated ${result.updated}, skipped ${result.skipped}`,
    });
    return NextResponse.json(result);
  } catch (error) {
    return respondToSyncError(error, guard.session.user.id, "upload");
  }
}
