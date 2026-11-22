import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import {
  BUILT_IN_DISPLAY_LAYOUTS,
  BUILT_IN_DISPLAY_TEMPLATE_KEYS,
  BUILT_IN_DISPLAY_TEMPLATES,
  ensureBuiltInDisplays,
} from "@/lib/lodge-display/built-in-seeds";

// Restore the built-in lobby-display boards (#2247).
//
// WHY THIS EXISTS. `ensureBuiltInDisplays()` has exactly one other caller —
// `prisma/seed.ts` — and no deploy or upgrade path runs the seed
// (`DEPLOYMENT.md`; the migrate service runs `prisma migrate deploy` only). A
// database created before the lobby-display feature therefore has no
// `builtin-*` rows at all and the Templates gallery is simply empty, with
// nothing an operator can do about it.
//
// WHY IT IS AN EXPLICIT ADMIN ACTION AND NOT A DEPLOY STEP (owner decision,
// #2247). The ensure is a CONVERGENT upsert: its update blocks rewrite the full
// definition of every `builtin-*` row from code (owner decision A, hoppers99/AlpineClubBookingsNZ#111). Wiring
// it into the deploy would silently revert an operator's local edits to a
// built-in on every release, and could overwrite customisations imported through
// config-transfer. Behind a button it is deliberate, auditable, and only ever a
// surprise the operator asked for — the UI states the overwrite before running
// it.
//
// Contract:
//  • WRITE — gated on `lodge:edit`, matching POST /api/admin/display/templates
//    (the sibling reads use `lodge:view`). The route resolves to the `lodge`
//    permission area via the `/api/admin/display` prefix.
//  • ATOMIC — the 14 upserts run inside one `$transaction`, so a database error
//    part-way through rolls the whole restore back rather than leaving a
//    half-restored library that nothing recorded. `ensureBuiltInDisplays` takes
//    a narrow client interface precisely so a transaction client can be passed,
//    and it makes no external provider calls, so nothing slow is held inside the
//    transaction.
//  • Idempotent — upsert by `key`, so a second run changes nothing and returns
//    the same counts. Safe to press twice.
//  • Convergent — an edited `builtin-*` row is rewritten back to its shipped
//    definition. That is the point of the action, and the reason it is audited.
//  • Touches ONLY the reserved `builtin-*` keys; custom templates and layouts,
//    and every device binding, are untouched (devices bind by `templateId`, and
//    an existing built-in keeps its row id through the upsert).

export async function POST() {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  const layouts = BUILT_IN_DISPLAY_LAYOUTS.length;
  const templates = BUILT_IN_DISPLAY_TEMPLATES.length;

  try {
    // 14 upserts of sizeable authored HTML/CSS; the default 5s interactive
    // timeout is tight enough on a loaded box to fail a restore that would
    // otherwise succeed, so give it room. Nothing external runs inside.
    await prisma.$transaction((tx) => ensureBuiltInDisplays(tx), {
      timeout: 30_000,
    });
  } catch {
    // The transaction rolled back, so the library is exactly as it was — say
    // so, because this string is what the operator reads verbatim.
    return NextResponse.json(
      {
        error:
          "Could not restore the built-in boards — nothing was changed. " +
          "Safe to try again.",
      },
      { status: 500 }
    );
  }

  // Audited because it is a bulk overwrite of shared, device-bound rows: a
  // later "who reverted our edited built-in?" must have an answer.
  logAudit({
    action: "DISPLAY_BUILT_INS_RESTORED",
    entityType: "DisplayTemplate",
    actorMemberId: guard.session.user.id,
    category: "lodge",
    severity: "important",
    // The reserved keys are NAMED rather than described as "builtin-*": that
    // prefix is the seeded row id, and matches no key at all, so a later
    // "was our board overwritten?" could not be answered from it.
    details:
      `Restored the built-in lobby display boards from code: ${layouts} ` +
      `layouts and ${templates} templates re-seeded under the reserved keys ` +
      `${BUILT_IN_DISPLAY_TEMPLATE_KEYS.join(", ")}. Anything saved under ` +
      `those keys was overwritten — including a built-in customised in place ` +
      `or by an imported configuration bundle. Layouts and templates under ` +
      `any other key were untouched.`,
  });

  return NextResponse.json({ layouts, templates });
}
