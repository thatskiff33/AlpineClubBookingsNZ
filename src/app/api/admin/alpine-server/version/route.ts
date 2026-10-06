import "server-only";

import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/session-guards";
import { checkServerVersion } from "@/lib/servernz-version-check";

// GET /api/admin/alpine-server/version — ask the central server its API
// version, record the answer and report the computed status (#49). The setup
// page calls this once on entry and again after a key is saved; nothing polls
// it. With no API key stored no request is made and the server version reads
// `0`. Finance VIEW, like the rest of the setup page's read surfaces: the
// response carries two version numbers and a timestamp, never the key or URL.
export async function GET() {
  const guard = await requireAdmin({
    permission: { area: "finance", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const result = await checkServerVersion();
  return NextResponse.json(result);
}
