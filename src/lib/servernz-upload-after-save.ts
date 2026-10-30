import "server-only";
import logger from "@/lib/logger";
import { ServerNzNotConfiguredError, ServerNzVersionMismatchError, assertStoredServerVersionMatches } from "@/lib/servernz-api";
import { uploadOtherClubsToServer } from "@/lib/servernz-other-lodges-sync";
import { loadServerNzSettings } from "@/lib/servernz-settings";
import { auditSyncFailure, auditUpload } from "@/lib/servernz-sync-response";
import { withOtherLodgesSyncClaim } from "@/lib/servernz-sync-claim";

/**
 * What uploading straight after an "Edit my Lodge" save came to, for the
 * panel to show. Every outcome but `uploaded` leaves the change for the
 * nightly sync, which uploads whatever is newer than its watermark.
 */
export type UploadAfterSave =
  | { status: "uploaded"; sent: number }
  | { status: "sharing-off" }
  | { status: "not-configured" }
  | { status: "running" }
  | { status: "paused" }
  | { status: "owned-unknown" }
  | { status: "failed" };

/**
 * Upload this club's changed Other lodges after an administrator saved their
 * own lodge, so the central server has the change now rather than at 03:00.
 * Called AFTER the save has committed, never inside its transaction
 * (INV-INT-003), under the same single-flight claim as the Upload button and
 * the nightly pass (#66). Idempotent: the upload sends only rows newer than its
 * watermark, so a repeat sends nothing. Never throws: the save has succeeded
 * whatever this comes to.
 */
export async function uploadOtherClubsAfterSave(memberId: string): Promise<UploadAfterSave> {
  try {
    const settings = await loadServerNzSettings();
    if (!settings.otherLodgesEnabled) return { status: "sharing-off" };
    // The recorded version first, as the Upload button does (#66).
    if (settings.baseUrl) assertStoredServerVersionMatches(settings.serverVersion);
    const result = await withOtherLodgesSyncClaim(() => uploadOtherClubsToServer());
    if (result === null) return { status: "running" };
    if (result.ownedUnknown) return { status: "owned-unknown" };
    await auditUpload(result, memberId, "Uploaded Other Clubs to Alpine Central Server after the lodge was saved");
    return { status: "uploaded", sent: result.sent };
  } catch (error) {
    if (error instanceof ServerNzNotConfiguredError) return { status: "not-configured" };
    try {
      await auditSyncFailure(error, memberId, "upload");
    } catch (auditError) {
      logger.warn({ err: auditError }, "Could not audit the upload after a lodge save");
    }
    return { status: error instanceof ServerNzVersionMismatchError ? "paused" : "failed" };
  }
}
