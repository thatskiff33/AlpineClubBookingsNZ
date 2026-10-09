import "server-only";
import { NextResponse } from "next/server";
import { createAuditLog } from "@/lib/audit";
import {
  ServerNzApiError,
  ServerNzNotConfiguredError,
  ServerNzVersionMismatchError,
} from "@/lib/servernz-api";
import { SERVER_VERSION_MISMATCH_CODE } from "@/lib/servernz-api-version";

/**
 * Map a ServerNZ sync failure to an audited HTTP response. Shared by the upload
 * and download routes. Not a route file, so it may export freely.
 *
 * ONE audit write site for every refused or failed press of the button. A
 * version pause (#49) is refused LOCALLY, before any request is built, and is
 * still recorded here as a failure: an admin pressed a button and nothing
 * happened. Its details name only the two versions (INV-INT-005).
 */
export async function respondToSyncError(
  error: unknown,
  memberId: string,
  direction: "upload" | "download",
): Promise<NextResponse> {
  if (error instanceof ServerNzNotConfiguredError) {
    return NextResponse.json({ error: error.message }, { status: 409 });
  }
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
