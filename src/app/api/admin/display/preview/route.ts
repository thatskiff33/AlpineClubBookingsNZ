import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { buildDisplayState } from "@/lib/lodge-display-state";
import { resolveDisplayTemplate } from "@/lib/lodge-display/template-resolution";

// Admin display preview (fork issue hoppers99/AlpineClubBookingsNZ#34): the same read-only discipline as
// the kiosk per-account preview (upstream #1721) — GET-only, admin-only, and
// it renders from the SAME privacy-reduced serialiser the real display uses,
// so a preview can never show more than a lobby wall would (AC3). No write
// occurs on this path. Resolves the code built-ins only (LTV-024).

export async function GET(req: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const templateKey = req.nextUrl.searchParams.get("templateKey");
  if (!templateKey) {
    return NextResponse.json({ error: "templateKey is required" }, { status: 400 });
  }

  const resolved = resolveDisplayTemplate(templateKey);
  if (!resolved) {
    return NextResponse.json({ error: "Template not found" }, { status: 404 });
  }

  const lodgeId = req.nextUrl.searchParams.get("lodgeId");
  if (!lodgeId) {
    return NextResponse.json({ error: "lodgeId is required" }, { status: 400 });
  }
  const state = await buildDisplayState(lodgeId);
  if (!state) {
    return NextResponse.json({ error: "Lodge not found" }, { status: 404 });
  }

  return NextResponse.json({ template: resolved.definition, state });
}
