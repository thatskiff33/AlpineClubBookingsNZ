import { revalidatePath } from "next/cache";
import { NextRequest, NextResponse } from "next/server";
import type { ZodError } from "zod";
import { parseJsonRequestBody } from "@/lib/api-json";
import { logAudit } from "@/lib/audit";
import {
  MissingLogoImageError,
  UncleanLogoError,
  getClubThemeForAdmin,
  saveClubTheme,
  saveClubThemeStyle,
} from "@/lib/club-theme";
import {
  LOGO_DATA_URL_WRITE_BUDGET_MESSAGE,
  clubThemeConnectionUpdateSchema,
  clubThemeUpdateSchema,
  isLogoDataUrlWithinWriteBudget,
  type ClubThemeStyleInput,
  type ClubThemeUpdateInput,
} from "@/lib/club-theme-update-schema";
import { CLUB_THEME_ID } from "@/lib/club-theme-schema";
import { prisma } from "@/lib/prisma";
import { primeEmailPalette } from "@/lib/email-theme";
import logger from "@/lib/logger";
import { requireAdmin } from "@/lib/session-guards";
import { PUBLIC_LAYOUT_CACHE_TAGS } from "@/lib/public-layout-cache";
import { revalidatePublicSite } from "@/lib/public-content-revalidation";
import { isTransactionContention } from "@/lib/prisma-errors";
import { arrivesAsMcpConnection, connectionJson } from "@/lib/mcp-connection-request";
import { SITE_STYLE_CONNECTION_SHAPE } from "@/lib/connection-shapes/content-settings";

/**
 * The save as the route applies it. A browser sends the whole theme. An AI
 * app connection (ALP-723) sends only the colours, fonts and custom CSS
 * (`clubThemeConnectionUpdateSchema`), saved by `saveClubThemeStyle`, which
 * never writes the logo or completes setup.
 */
type ThemeSave =
  | { readonly from: "browser"; readonly data: ClubThemeUpdateInput }
  | { readonly from: "connection"; readonly data: ClubThemeStyleInput };

function parseThemeSave(request: Request, body: unknown): { ok: true; save: ThemeSave } | { ok: false; error: ZodError } {
  if (arrivesAsMcpConnection(request)) {
    const parsed = clubThemeConnectionUpdateSchema.safeParse(body);
    return parsed.success ? { ok: true, save: { from: "connection", data: parsed.data } } : { ok: false, error: parsed.error };
  }
  const parsed = clubThemeUpdateSchema.safeParse(body);
  return parsed.success ? { ok: true, save: { from: "browser", data: parsed.data } } : { ok: false, error: parsed.error };
}

export async function GET(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "content", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const theme = await getClubThemeForAdmin();
  return connectionJson(request, { theme }, SITE_STYLE_CONNECTION_SHAPE);
}

export async function PUT(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "content", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  const jsonBody = await parseJsonRequestBody(request, {
    error: "Invalid JSON",
  });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;

  const parsed = parseThemeSave(request, body);
  if (!parsed.ok) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // #2322: the 64KB inline-logo budget applies to a CHANGED value only. A
  // deployment already storing a large data URI (~860KB in the field) round-trips
  // it on every save — the wizard posts the whole theme — so a stateless check
  // would lock that club out of editing its colours. Byte-identical means
  // "unchanged", and the schema's 900KB read bound still applies to it.
  const { save } = parsed;
  const incomingLogoDataUrl = save.from === "browser" ? save.data.logoDataUrl : null;
  if (incomingLogoDataUrl) {
    const stored = await prisma.clubTheme.findUnique({
      where: { id: CLUB_THEME_ID },
      select: { logoDataUrl: true },
    });
    const unchanged = stored?.logoDataUrl === incomingLogoDataUrl;

    if (!unchanged && !isLogoDataUrlWithinWriteBudget(incomingLogoDataUrl)) {
      return NextResponse.json(
        {
          error: "Invalid input",
          details: {
            formErrors: [],
            fieldErrors: {
              logoDataUrl: [LOGO_DATA_URL_WRITE_BUDGET_MESSAGE],
            },
          },
        },
        { status: 400 },
      );
    }
  }

  // #2187: contrast is now guaranteed BY CONSTRUCTION — the three seeds feed the
  // vendored Radix generator, whose banded 12-step substrate clears the guarantee
  // sweep for every seed (see `@/lib/theme/guarantees`). A pathological pick is
  // adjusted, not rejected, so the old blocking contrast gate is gone; the wizard
  // surfaces the before/after adjustment as a disclosure instead.
  try {
    const theme = save.from === "browser" ? await saveClubTheme(save.data) : await saveClubThemeStyle(save.data);
    const completedSetup = save.from === "browser" && Boolean(save.data.completeSetup);
    // #2352 F3. This save is the COMPLETE-SETUP transition as well as an ordinary
    // theme edit, and both need the full-route store cleared, not just the theme
    // tag:
    //  • an ordinary edit changes the CSS and logo the public layout renders into
    //    every stored page;
    //  • completing setup ends the "Site setup in progress" state, and any page
    //    stored while the layout was painting the holding screen must not outlive
    //    it. (The #2420 proxy gate answers 503 before a render, so this is the
    //    narrow case where the gate's 15-second memo said "complete" while the
    //    layout still read an unfinished row.)
    //
    // The transition half is asserted at the UNIT level only — `site-style-api.test.ts`
    // pins that this PUT issues the call. The pre-setup Playwright project cannot
    // cover it: it flips `ClubTheme` directly, because `saveClubTheme()` never clears
    // `completedAt`, so this handler never runs in that flow. An earlier version of
    // this comment implied otherwise.
    //
    // `revalidatePublicSite()` replaces `revalidatePath("/(website)", "layout")`
    // here: the route-group form was never verified against the full-route store,
    // and one form used everywhere is one thing to verify rather than two.
    revalidatePublicSite(PUBLIC_LAYOUT_CACHE_TAGS.theme);
    revalidatePath("/(authenticated)", "layout");
    revalidatePath("/(admin)", "layout");
    // #1912: HTML emails resolve their brand colours from a cached copy of this
    // theme (see email-theme.ts). Re-prime that cache from the just-saved values
    // so booking/notification emails pick up the new colour scheme immediately
    // rather than only after the cache TTL lapses. Reuses the same persisted
    // ClubTheme source of truth and never throws.
    await primeEmailPalette();

    logAudit({
      action: "site_style.updated",
      memberId: guard.session.user.id,
      targetId: "default",
      category: "admin",
      severity: completedSetup ? "important" : "info",
      summary: completedSetup
        ? "Completed public site style setup"
        : "Updated public site style setup",
      metadata: {
        completed: Boolean(theme.completedAt),
        colours: {
          brandGold: theme.brandGold,
          brandDeep: theme.brandDeep,
          brandSafety: theme.brandSafety,
        },
        headingFontKey: theme.headingFontKey,
        bodyFontKey: theme.bodyFontKey,
        hasLogo: Boolean(theme.logoUrl ?? theme.logoDataUrl),
        logoMode: theme.logoUrl ? "url" : theme.logoDataUrl ? "data-url" : "none",
      },
    });

    return connectionJson(request, { theme }, SITE_STYLE_CONNECTION_SHAPE);
  } catch (error) {
    // A stale tab referencing a logo blob a newer save already replaced. Not a
    // server fault, and retrying the same payload will never work — the admin
    // needs to re-upload.
    if (error instanceof MissingLogoImageError) {
      return NextResponse.json(
        {
          error:
            "That logo is no longer available — re-upload it and save again.",
        },
        { status: 409 },
      );
    }

    // An inline logo that could not be confirmed free of hidden details
    // (#5244): the admin needs a fresh copy, so say why in plain words.
    if (error instanceof UncleanLogoError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    // Config-transfer apply holds the ClubTheme row for its whole bundle
    // transaction, so a save landing mid-import legitimately exhausts the lock
    // wait. That is a "try again", not a 500 (P2028 or P2034, `isTransactionContention`).
    if (isTransactionContention(error)) {
      logger.warn(
        { err: error },
        "Site style save contended with another transaction",
      );
      return NextResponse.json(
        { error: "Another update is in progress — try again shortly." },
        { status: 503 },
      );
    }

    logger.error({ err: error }, "Failed to save site style settings");
    return NextResponse.json(
      { error: "Failed to save site style settings" },
      { status: 500 },
    );
  }
}
