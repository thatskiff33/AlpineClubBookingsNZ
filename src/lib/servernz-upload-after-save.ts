import "server-only";
import { hasAdminAreaAccess, type AdminAccessRequirement, type AdminPermissionInput } from "@/lib/admin-permissions";
import logger from "@/lib/logger";
import { ServerNzNotConfiguredError, ServerNzVersionMismatchError, assertStoredServerVersionMatches } from "@/lib/servernz-api";
import { uploadOtherClubsToServer } from "@/lib/servernz-other-lodges-sync";
import { loadServerNzSettings } from "@/lib/servernz-settings";
import { auditSyncFailure, auditUpload } from "@/lib/servernz-sync-response";
import { withOtherLodgesSyncClaim } from "@/lib/servernz-sync-claim";

/**
 * Who may send this club's lodges to the central server on demand: the Upload
 * button's guard, and the save that uploads straight away (#4720 review). Lodges
 * edit alone saves the lodge; the nightly sync then sends it.
 */
export const OTHER_LODGES_UPLOAD_PERMISSION: AdminAccessRequirement = { area: "finance", level: "edit" };

/**
 * What uploading straight after an "Edit my Lodge" save came to, for the
 * panel to show. Every outcome but `uploaded` leaves the change for the
 * nightly sync, which uploads whatever is newer than its watermark. `sent`
 * counts the lodges sent and `accepted` those the server took; a lodge it
 * refused stays below the watermark and is sent again by the nightly sync.
 */
export type UploadAfterSave =
  | { status: "uploaded"; sent: number; accepted: number }
  | { status: "no-upload-permission" }
  | { status: "sharing-off" }
  | { status: "not-configured" }
  | { status: "running" }
  | { status: "paused" }
  | { status: "owned-unknown" }
  | { status: "owned-unreadable" }
  | { status: "failed" };

/**
 * Upload this club's changed Other lodges after an administrator saved their
 * own lodge, so the central server has the change now rather than at 03:00.
 * Called AFTER the save has committed, never inside its transaction
 * (INV-INT-003), under the same single-flight claim as the Upload button and
 * the nightly pass (#66). Idempotent: the upload sends only rows newer than its
 * watermark, so a repeat sends nothing, and is audited only when it sent
 * something. Only an administrator who may press Upload uploads here
 * (`OTHER_LODGES_UPLOAD_PERMISSION`). Never throws: the save has succeeded
 * whatever this comes to.
 */
export async function uploadOtherClubsAfterSave(
  user: AdminPermissionInput & { id: string },
): Promise<UploadAfterSave> {
  if (!hasAdminAreaAccess(user, OTHER_LODGES_UPLOAD_PERMISSION)) return { status: "no-upload-permission" };
  const memberId = user.id;
  try {
    const settings = await loadServerNzSettings();
    if (!settings.otherLodgesEnabled) return { status: "sharing-off" };
    // The recorded version first, as the Upload button does (#66).
    if (settings.baseUrl) assertStoredServerVersionMatches(settings.serverVersion);
    const result = await withOtherLodgesSyncClaim(() => uploadOtherClubsToServer());
    if (result === null) return { status: "running" };
    if (result.ownedUnknown) return { status: "owned-unknown" };
    if (result.ownedUnreadable) return { status: "owned-unreadable" };
    if (result.sent > 0) {
      await auditUpload(result, memberId, "Uploaded Other Clubs to Alpine Central Server after the lodge was saved");
    }
    return { status: "uploaded", sent: result.sent, accepted: result.accepted };
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
