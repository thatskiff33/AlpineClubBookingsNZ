import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { isFullAdmin } from "@/lib/access-roles";
import { parseJsonRequestBody } from "@/lib/api-json";
import { OWNED_CENTRAL_LODGE_ID_MAX } from "@/lib/other-lodges";
import { runLodgeLinkStep, saveLodgeLinkChoices } from "@/lib/servernz-lodge-link-step";
import { respondToSyncError } from "@/lib/servernz-sync-response";
import { requireAdmin } from "@/lib/session-guards";

// /api/admin/alpine-server/lodge-links — the setup page's step after an API
// key is saved: POST downloads the central server's lodges and links this
// club's lodge to the one it owns when that is the only choice, or hands back
// the choice; PUT saves the choice the administrator made in the dialog.
//
// Full Admin, like the key save it follows: the finance area guards the page,
// and linking lodges is lodge-area work, which a Full Admin holds too.

async function requireFullAdmin() {
  const guard = await requireAdmin({ permission: { area: "finance", level: "edit" } });
  if (!guard.ok) return guard;
  if (!isFullAdmin(guard.session.user)) {
    return {
      ok: false as const,
      response: NextResponse.json({ error: "Full admin access is required." }, { status: 403 }),
    };
  }
  return guard;
}

export async function POST() {
  const guard = await requireFullAdmin();
  if (!guard.ok) return guard.response;
  try {
    return NextResponse.json(await runLodgeLinkStep(guard.session.user.id));
  } catch (error) {
    return respondToSyncError(error, guard.session.user.id, "download");
  }
}

const centralId = z.string().trim().min(1).max(OWNED_CENTRAL_LODGE_ID_MAX).nullable();
const putSchema = z
  .object({
    links: z
      .array(
        z
          .object({
            lodgeId: z.string().min(1).max(64),
            centralLodgeId: centralId,
            // The link the dialog showed: a link saved since then refuses the save.
            expectCurrent: centralId,
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();

export async function PUT(request: Request) {
  const guard = await requireFullAdmin();
  if (!guard.ok) return guard.response;
  const json = await parseJsonRequestBody(request);
  if (!json.ok) return json.response;
  const parsed = putSchema.safeParse(json.body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  let saved;
  try {
    saved = await saveLodgeLinkChoices(parsed.data.links, guard.session.user.id);
  } catch {
    return NextResponse.json({ error: "Could not save the links." }, { status: 500 });
  }
  if (saved.ok) return NextResponse.json({ ok: true });
  switch (saved.reason) {
    case "already-linked":
      return NextResponse.json(
        { error: `A central lodge you chose is already linked to ${saved.holderName ?? "another lodge"}. Unlink it there first.` },
        { status: 409 },
      );
    case "stale":
      return NextResponse.json(
        { error: "A lodge's link was changed while this was open. Close it and check each lodge's Central lodge card under Lodges." },
        { status: 409 },
      );
    case "duplicate":
      return NextResponse.json({ error: "Each central lodge can be linked to one lodge only." }, { status: 400 });
    case "lodge-not-found":
      return NextResponse.json({ error: "One of those lodges no longer exists." }, { status: 404 });
    case "not-owned":
      return NextResponse.json(
        { error: "That is not a lodge the Alpine Central Server says this club owns. Download again, then choose." },
        { status: 400 },
      );
    default: {
      const unhandled: never = saved;
      return unhandled;
    }
  }
}
