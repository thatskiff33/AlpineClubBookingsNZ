import { revalidatePath } from "next/cache";
import { NextRequest, NextResponse } from "next/server";
import { logAudit } from "@/lib/audit";
import {
  getClubThemeForAdmin,
  saveClubTheme,
} from "@/lib/club-theme";
import { clubThemeUpdateSchema } from "@/lib/club-theme-schema";
import logger from "@/lib/logger";
import { requireAdmin } from "@/lib/session-guards";

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const theme = await getClubThemeForAdmin();
  return NextResponse.json({ theme });
}

export async function PUT(request: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = clubThemeUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const theme = await saveClubTheme(parsed.data);
    revalidatePath("/(website)", "layout");

    logAudit({
      action: "site_style.updated",
      memberId: guard.session.user.id,
      targetId: "default",
      category: "admin",
      severity: parsed.data.completeSetup ? "important" : "info",
      summary: parsed.data.completeSetup
        ? "Completed public site style setup"
        : "Updated public site style setup",
      metadata: {
        completed: Boolean(theme.completedAt),
        colours: {
          brandGold: theme.brandGold,
          brandCharcoal: theme.brandCharcoal,
          brandDeep: theme.brandDeep,
          brandRidge: theme.brandRidge,
          brandMist: theme.brandMist,
          brandSnow: theme.brandSnow,
          brandSafety: theme.brandSafety,
        },
        headingFontKey: theme.headingFontKey,
        bodyFontKey: theme.bodyFontKey,
        hasLogo: Boolean(theme.logoDataUrl),
      },
    });

    return NextResponse.json({ theme });
  } catch (error) {
    logger.error({ err: error }, "Failed to save site style settings");
    return NextResponse.json(
      { error: "Failed to save site style settings" },
      { status: 500 },
    );
  }
}
