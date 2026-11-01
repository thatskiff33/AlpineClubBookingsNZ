import "server-only";

import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/session-guards";
import { createAuditLog } from "@/lib/audit";
import { loadServerNzSettings } from "@/lib/servernz-settings";
import { downloadOtherClubsFromServer } from "@/lib/servernz-other-lodges-sync";
import { respondSyncRunning, respondToSyncError } from "@/lib/servernz-sync-response";
import { withOtherLodgesSyncClaim } from "@/lib/servernz-sync-claim";
import { assertStoredServerVersionMatches } from "@/lib/servernz-api";

// POST /api/admin/alpine-server/other-lodges/download — pull the distributed
// Other Clubs set from the central server and merge it into the local registry.
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
    const result = await withOtherLodgesSyncClaim(() => downloadOtherClubsFromServer());
    if (result === null) return respondSyncRunning();
    // A download that stopped (#4262 review) is its own outcome, with the
    // reason, never a plain success.
    await createAuditLog({
      action: "alpine_server.other_lodges.download",
      category: "lodge",
      severity: result.stopped ? "important" : "info",
      outcome: result.stopped ? "failure" : "success",
      memberId: guard.session.user.id,
      summary: result.stopped
        ? `Download from Alpine Central Server stopped (${result.stopped}); its cursor was not recorded`
        : "Downloaded Other Clubs from Alpine Central Server",
      // Hidden (#58): lodges the central server deleted, now kept only for
      // the bookings and requests that name them.
      details: `fetched ${result.fetched}, added ${result.created}, updated ${result.updated}, hidden ${result.hiddenLodges.length}${result.hiddenLodges.length ? ` (${result.hiddenLodges.join(", ")})` : ""}`,
    });
    return NextResponse.json(result);
  } catch (error) {
    return respondToSyncError(error, guard.session.user.id, "download");
  }
}
