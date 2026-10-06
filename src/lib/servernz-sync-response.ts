import "server-only";
import { NextResponse } from "next/server";
import { createAuditLog } from "@/lib/audit";
import {
  ServerNzApiError,
  ServerNzNotConfiguredError,
  ServerNzVersionMismatchError,
} from "@/lib/servernz-api";

/**
 * The machine-readable reason the Upload/Download routes answer with when the
 * central server is on a different API version (#49). The setup page reads it
 * to refresh the numbers it shows.
 */
export const SERVER_VERSION_MISMATCH_CODE = "server-version-mismatch";

/**
 * Map a ServerNZ sync failure to an audited HTTP response. Shared by the upload
 * and download routes. Not a route file, so it may export freely.
 */
export async function respondToSyncError(
  error: unknown,
  memberId: string,
  direction: "upload" | "download",
): Promise<NextResponse> {
  if (error instanceof ServerNzNotConfiguredError) {
    return NextResponse.json({ error: error.message }, { status: 409 });
  }
  if (error instanceof ServerNzVersionMismatchError) {
    // Refused LOCALLY, before any request was built: a 409 like the
    // not-configured case, carrying both numbers so the page can show them.
    // Audited as a failure, because an admin pressed a button and nothing
    // happened; the details name only the two versions (INV-INT-005).
    await createAuditLog({
      action: `alpine_server.other_lodges.${direction}`,
      category: "lodge",
      severity: "important",
      outcome: "failure",
      memberId,
      summary: `Alpine Central Server ${direction} paused: server API version differs`,
      details: `this site is built for ${error.expected}; the server reports ${error.serverVersion}`,
    });
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
  await createAuditLog({
    action: `alpine_server.other_lodges.${direction}`,
    category: "lodge",
    severity: "important",
    outcome: "failure",
    memberId,
    summary: `Alpine Central Server ${direction} failed`,
    details:
      error instanceof ServerNzApiError
        ? `server responded ${error.status}: ${error.message}`
        : "connection error",
  });
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
