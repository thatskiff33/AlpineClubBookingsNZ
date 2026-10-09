import "server-only";
import {
  uploadOtherClubsToServer,
  downloadOtherClubsFromServer,
  type UploadSummary,
  type DownloadSummary,
} from "@/lib/servernz-other-lodges-sync";
import { loadServerNzSettings } from "@/lib/servernz-settings";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { withOtherLodgesSyncClaim } from "@/lib/servernz-sync-claim";
import {
  ServerNzNotConfiguredError,
  ServerNzVersionMismatchError,
} from "@/lib/servernz-api";
import { SERVER_VERSION_MISMATCH_CODE } from "@/lib/servernz-api-version";
import { checkServerVersion } from "@/lib/servernz-version-check";
import logger from "@/lib/logger";

/**
 * Daily bidirectional Other Clubs sync with the Alpine Central Server.
 *
 * Runs upload then download so a single pass reconciles both ends: the upload
 * pushes local rows changed since the last upload watermark, and the download
 * pulls the centrally-distributed rows changed since the last cursor. Both
 * directions are incremental (see servernz-other-lodges-sync), so a quiet day
 * makes at most one cheap request per direction and writes nothing.
 *
 * Scheduled at 03:00 daily by the cron leader (POST /api/cron/alpine-server-sync).
 */

export interface AlpineServerSyncResult {
  status: "synced" | "skipped";
  reason?: string;
  upload?: UploadSummary;
  download?: DownloadSummary;
}

export async function syncOtherClubsWithServer(): Promise<AlpineServerSyncResult> {
  // The module flag is checked HERE as well as on the admin routes, because this
  // path never passes through the route-feature gate: the cron endpoint is
  // authenticated with CRON_SECRET, not a session, so no prefix rule can cover
  // it. Without this check, switching the module off in Admin -> Modules would
  // 404 the setup page while the nightly job carried on uploading — which for a
  // feature that sends contact details to a third party is the failure that
  // matters most (INV-CONFIG-001).
  const flags = await loadEffectiveModuleFlags();
  if (!flags.alpineCentralServer) {
    return { status: "skipped", reason: "module-disabled" };
  }

  const settings = await loadServerNzSettings();

  if (!settings.baseUrl) {
    return { status: "skipped", reason: "central-server-not-configured" };
  }

  // THE VERSION CHECK RUNS FIRST (#49, `INV-INT-027`) - before the per-item
  // enable gate, so a club that has the module on and a key stored gets a
  // fresh answer every night whether or not the Other Clubs item is enabled
  // (the message board rides the same version), and BEFORE the single-flight
  // claim below, so a mismatch never takes or wedges a claim. This is also how
  // syncing resumes by itself: once this site is upgraded, the next nightly
  // check records a matching answer and the pass carries on. With no key
  // stored the check makes no request and reports `no-key`, which falls
  // through to the not-configured skip below. A check that could not reach
  // the server keeps the last answer and does not pause anything.
  const version = await checkServerVersion();
  if (version.status === "mismatch") {
    logger.info(
      {
        job: "alpine-server-other-lodges-sync",
        expected: version.expected,
        serverVersion: version.serverVersion,
      },
      "Alpine Central Server sync skipped: server API version differs",
    );
    // The same fact the Upload/Download routes answer with, under one name.
    return { status: "skipped", reason: SERVER_VERSION_MISMATCH_CODE };
  }

  // Only sync clubs that have opted in and pointed at a server. Missing API key
  // surfaces below as ServerNzNotConfiguredError and is treated the same way.
  if (!settings.otherLodgesEnabled) {
    return { status: "skipped", reason: "other-lodges-sync-disabled" };
  }

  try {
    // Single-flight across containers and across the cron/admin-button pair. The
    // in-process boolean in instrumentation.node.ts covers neither.
    const pass = await withOtherLodgesSyncClaim(async () => {
      // Upload first so any local edits land centrally before we pull the merged
      // distributed set back down.
      const upload = await uploadOtherClubsToServer();
      const download = await downloadOtherClubsFromServer();
      return { upload, download };
    });

    if (!pass) {
      return { status: "skipped", reason: "sync-already-running" };
    }
    const { upload, download } = pass;
    logger.info(
      {
        job: "alpine-server-other-lodges-sync",
        uploadSent: upload.sent,
        uploadCreated: upload.created,
        uploadUpdated: upload.updated,
        downloadFetched: download.fetched,
        downloadCreated: download.created,
        downloadUpdated: download.updated,
      },
      "Alpine Central Server Other Clubs sync complete",
    );
    return { status: "synced", upload, download };
  } catch (err) {
    if (err instanceof ServerNzNotConfiguredError) {
      return { status: "skipped", reason: "central-server-not-configured" };
    }
    // The gate inside resolveConnection can still refuse a request that the
    // pre-check above allowed - the inline self-heal on a never-asked row, or
    // a version recorded by another container between the two. Same answer:
    // a skip with its reason, never a red cron run an operator cannot act on.
    if (err instanceof ServerNzVersionMismatchError) {
      return { status: "skipped", reason: SERVER_VERSION_MISMATCH_CODE };
    }
    throw err;
  }
}
