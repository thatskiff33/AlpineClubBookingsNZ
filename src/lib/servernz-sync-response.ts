import "server-only";
import { NextResponse } from "next/server";
import { createAuditLog } from "@/lib/audit";
import {
  ServerNzApiError,
  ServerNzNotConfiguredError,
  ServerNzVersionMismatchError,
} from "@/lib/servernz-api";
import type { DownloadSummary, UploadSummary } from "@/lib/servernz-other-lodges-sync";
import {
  OTHER_LODGES_SYNC_RUNNING_CODE,
  SERVER_VERSION_MISMATCH_CODE,
} from "@/lib/servernz-api-version";

/**
 * The answer to an Upload or Download press while another pass — the nightly
 * job, or another administrator's press — holds the sync claim (#66). Nothing
 * was attempted, so nothing is audited: the press is refused before any
 * request is built, and the administrator is told to try again. A container
 * killed mid-pass leaves the claim until it is reaped as stale (15 minutes),
 * which the message says.
 */
export function respondSyncRunning(): NextResponse {
  return NextResponse.json(
    {
      error:
        "Another sync with the Alpine Central Server is running (the nightly sync, or a press in another window). Try again in a minute; if it was cut off by a restart, it clears within 15 minutes.",
      code: OTHER_LODGES_SYNC_RUNNING_CODE,
    },
    { status: 409 },
  );
}

/**
 * The audit row for a download an administrator started, by the Download
 * button or by the setup page's step after a key save. A download that
 * stopped (#4262 review) is its own outcome, with the reason. Hidden (#58):
 * lodges the central server deleted, now kept only for what names them.
 */
export async function auditDownload(
  result: Pick<DownloadSummary, "stopped" | "fetched" | "created" | "updated" | "hiddenLodges">,
  memberId: string,
  summary: string,
): Promise<void> {
  const hidden = result.hiddenLodges;
  await createAuditLog({
    action: "alpine_server.other_lodges.download",
    category: "lodge",
    severity: result.stopped ? "important" : "info",
    outcome: result.stopped ? "failure" : "success",
    memberId,
    summary: result.stopped
      ? `Download from Alpine Central Server stopped (${result.stopped}); its cursor was not recorded`
      : summary,
    details: `fetched ${result.fetched}, added ${result.created}, updated ${result.updated}, hidden ${hidden.length}${hidden.length ? ` (${hidden.join(", ")})` : ""}`,
  });
}

/** The audit row for an upload an administrator started (button, or a lodge save). */
export async function auditUpload(
  result: Pick<UploadSummary, "created" | "updated" | "skipped">,
  memberId: string,
  summary: string,
): Promise<void> {
  await createAuditLog({
    action: "alpine_server.other_lodges.upload",
    category: "lodge",
    severity: "info",
    outcome: "success",
    memberId,
    summary,
    details: `created ${result.created}, updated ${result.updated}, skipped ${result.skipped}`,
  });
}

/**
 * The audit row for a failed or paused sync an administrator started, by a
 * press of Upload or Download or by a save that uploads straight away.
 * Details name only the two versions or the server's status (INV-INT-005).
 */
export async function auditSyncFailure(
  error: unknown,
  memberId: string,
  direction: "upload" | "download",
): Promise<void> {
  const paused = error instanceof ServerNzVersionMismatchError;
  await createAuditLog({
    action: `alpine_server.other_lodges.${direction}`,
    category: "lodge",
    severity: "important",
    outcome: "failure",
    memberId,
    summary: paused
      ? `Alpine Central Server ${direction} paused: server API version differs`
      : `Alpine Central Server ${direction} failed`,
    details: paused
      ? `this site is built for ${error.expected}; the server reports ${error.serverVersion}`
      : error instanceof ServerNzApiError
        ? `server responded ${error.status}: ${error.message}`
        : "connection error",
  });
}

/**
 * Map a ServerNZ sync failure to an audited HTTP response. Shared by the upload
 * and download routes. Not a route file, so it may export freely.
 *
 * ONE audit write site for every refused or failed press of the button. A
 * version pause (#49) is refused LOCALLY, before any request is built, and is
 * still recorded here as a failure: an admin pressed a button and nothing
 * happened. Its details name only the two versions (INV-INT-005). The one
 * press NOT recorded is the one another pass is already running for
 * (`respondSyncRunning`, #66): that pass is the sync, and nothing failed.
 */
export async function respondToSyncError(
  error: unknown,
  memberId: string,
  direction: "upload" | "download",
): Promise<NextResponse> {
  if (error instanceof ServerNzNotConfiguredError) {
    return NextResponse.json({ error: error.message }, { status: 409 });
  }
  await auditSyncFailure(error, memberId, direction);
  const paused = error instanceof ServerNzVersionMismatchError;
  if (paused) {
    return NextResponse.json(
      {
        error: error.message,
        code: SERVER_VERSION_MISMATCH_CODE,
        expected: error.expected,
        serverVersion: error.serverVersion,
      },
      { status: 409 },
    );
  }
  if (error instanceof ServerNzApiError) {
    return NextResponse.json(
      { error: `Central server error: ${error.message}` },
      { status: 502 },
    );
  }
  return NextResponse.json(
    { error: "Could not reach the Alpine Central Server." },
    { status: 502 },
  );
}
