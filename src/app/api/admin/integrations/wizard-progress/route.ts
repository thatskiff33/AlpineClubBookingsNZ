import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { parseJsonRequestBody } from "@/lib/api-json";
import { requireAdmin } from "@/lib/session-guards";
import {
  getIntegrationWizardProgress,
  saveIntegrationWizardProgress,
} from "@/lib/integration-wizard-progress";

// Cursor persistence for the reusable guided-provider setup shell (#2080).
//
// This stores ONLY a resume cursor (which step, which steps acknowledged) — it
// never stores credentials or verification truth. Verification is always
// re-derived from server state by the wizard config on load. So the finance
// area (which already governs /admin/xero and /admin/integrations) gates it:
//   - GET  → finance VIEW (any finance-area admin can resume where they left off)
//   - POST → finance EDIT (advancing the cursor is a low-sensitivity write;
//            credential writes themselves remain Full-Admin-only in the C1 API).

// The stored row is keyed by `wizardId` ALONE (`IntegrationWizardProgress.
// wizardId` is `@unique` globally), so the cursor is INSTALL-WIDE, not
// per-admin: two admins running the same wizard share one position and the
// later save wins. That was accepted deliberately for the Lodge Display wizard
// (#2249, owner decision 28 Jul 2026) rather than adding a per-admin schema
// change — the cursor is a resume hint, every step re-derives its own gate from
// live server truth, so a clobbered cursor can only change which step opens
// first. The wizard UI states this in plain English on every step.
//
// Allowlist of wizard ids the shell may persist. Keeps arbitrary rows out and
// mirrors the provider namespace. C4/C5 add "stripe" / "google"; "display" is
// the Lodge Display guided setup wizard (#2249).
//
// "display" deliberately does NOT widen this route's finance gate (owner
// decision, 28 Jul 2026). A lodge-area admin without finance access therefore
// gets 403 on both verbs — and that is safe by construction: `useWizardCursor`
// fails OPEN (a failed GET means "start at the gate", a failed POST is
// swallowed), so the display wizard still works end to end for them; it just
// does not remember where they were between visits. Widening the area to make
// the cursor writable would hand every lodge admin write access to a route that
// also governs the Xero/Stripe/Google cursors, which is a far worse trade for a
// resume hint.
const ALLOWED_WIZARD_IDS = ["xero", "stripe", "google", "display"] as const;
type AllowedWizardId = (typeof ALLOWED_WIZARD_IDS)[number];

function isAllowedWizardId(value: string): value is AllowedWizardId {
  return (ALLOWED_WIZARD_IDS as readonly string[]).includes(value);
}

export async function GET(request: Request) {
  const guard = await requireAdmin({
    permission: { area: "finance", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const wizardId = new URL(request.url).searchParams.get("wizardId") ?? "";
  if (!isAllowedWizardId(wizardId)) {
    return NextResponse.json({ error: "Unknown wizard." }, { status: 400 });
  }

  const progress = await getIntegrationWizardProgress(wizardId);
  return NextResponse.json({ wizardId, progress });
}

const bodySchema = z.object({
  wizardId: z.string().min(1).max(64),
  currentStepId: z.string().min(1).max(64),
  completedStepIds: z.array(z.string().min(1).max(64)).max(32),
});

export async function POST(request: Request) {
  const guard = await requireAdmin({
    permission: { area: "finance", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  const json = await parseJsonRequestBody(request);
  if (!json.ok) return json.response;
  const parsed = bodySchema.safeParse(json.body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { wizardId, currentStepId, completedStepIds } = parsed.data;
  if (!isAllowedWizardId(wizardId)) {
    return NextResponse.json({ error: "Unknown wizard." }, { status: 400 });
  }

  const progress = await saveIntegrationWizardProgress({
    wizardId,
    currentStepId,
    completedStepIds,
    updatedByMemberId: guard.session.user.id,
  });

  return NextResponse.json({ ok: true, wizardId, progress });
}
