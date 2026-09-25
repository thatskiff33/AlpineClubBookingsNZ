import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hasAdminAccess } from "@/lib/access-roles";
import { checkDisplayAuth, decodePreviewGrant } from "@/lib/lodge-display-auth";
import { buildDisplayState, type DisplayState } from "@/lib/lodge-display-state";
import { resolveDisplayTemplateForDevice } from "@/lib/lodge-display/template-resolution";
import { buildLayoutRender } from "@/lib/lodge-display/layout-render";
import type { LayoutRenderPayload } from "@/lib/lodge-display/layout-registry";
import { getDraftPreview } from "@/lib/lodge-display/draft-preview-store";
import {
  clampPollSeconds,
  DISPLAY_DEFAULT_POLL_SECONDS,
} from "@/lib/lodge-display/poll-interval";
import { getWebsiteThemeRenderState } from "@/lib/club-theme";
import { getDefaultLodgeId, resolveOptionalActiveLodgeId } from "@/lib/lodges";
import { isDateOnlyString, parseDateOnly } from "@/lib/date-only";
import { prisma } from "@/lib/prisma";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import logger from "@/lib/logger";
import { clubFormatValues } from "@/lib/club-format-server";

// GET /api/display/state?days=N — the lobby display's single data feed
// (fork issues #28/#32/#52, design.md §5). Two callers:
//
//  - a PAIRED DEVICE (display-token cookie): the device's bound lodge and
//    template; a successful fetch stamps lastSeenAt so admins can see a dead
//    screen (the page polls this — no separate heartbeat needed).
//  - an ADMIN PREVIEW (issue #52; the kiosk per-account preview pattern,
//    upstream #1721): a full admin passes ?previewDevice=<id> (that device's
//    lodge + template), ?preview=1&templateId=<id>[&previewLodge=<id>] (an
//    AUTHORED v2 template against an explicit lodge — LTV-036, ADR-003 §5), or
//    ?preview=1 (default lodge, club-default fallback board). Preview is
//    read-only by construction — it never stamps lastSeenAt — and renders
//    through the SAME privacy-reduced serialiser, so a preview can never show
//    more than a lobby wall would. The parameter is honoured ONLY for a full
//    admin; anyone else gets the normal 401. A preview may also carry
//    ?previewDate=YYYY-MM-DD (issue #60) to start the window on a simulated
//    date instead of today — preview-only; device fetches never honour it.
//  - a SANDBOXED PREVIEW GRANT (LTV-036, ADR-003 §5): ?previewGrant=<token> —
//    an HMAC-signed, 5-minute, single-purpose blob minted by the admin-only
//    grant endpoint. It is how the authoring pages embed a preview inside a
//    `sandbox="allow-scripts"` iframe (opaque origin, no cookies): the framed
//    /display sends the grant instead of a session, and the route serves THAT
//    template/lodge preview only. The grant is not a display token — it never
//    stamps lastSeenAt and authorises nothing else. Its (cross-origin, opaque)
//    fetch needs a permissive CORS header to be readable by the frame.
//
// The serialiser (lodge-display-state.ts) is the privacy enforcement point;
// nothing here shapes or filters names. Window size is clamped server-side
// (default 3 days, max 7). Module flag off → proxy-level 404.

// The sandboxed preview iframe runs with an OPAQUE origin (sandbox without
// allow-same-origin), so its fetch to this same-site route is treated as
// cross-origin and its response is only readable with a permissive
// Access-Control-Allow-Origin. Safe here: the grant path sends no credentials
// (opaque origin → no cookies) and the payload is already the privacy-reduced
// wall feed, so "*" exposes nothing a valid grant-holder could not already see.
const GRANT_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "no-store",
} as const;

function grantJson(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: GRANT_CORS_HEADERS });
}

// Every display-state payload can carry guest names and opted-in phone numbers
// (the privacy-reduced wall feed), so no shared/browser cache may ever hold one
// (issue #176). All three response paths set Cache-Control: no-store — the grant
// path via GRANT_CORS_HEADERS above (which also carries the opaque-origin CORS
// header the sandboxed iframe needs), and the device + session-preview paths via
// this shared header.
const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;

function stateJson(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}

async function resolvePreview(
  req: NextRequest
): Promise<
  | {
      lodgeId: string;
      templateId: string | null;
      deviceId?: string;
    }
  | "not-a-preview"
  | "denied"
> {
  const previewDeviceId = req.nextUrl.searchParams.get("previewDevice");
  const previewFlag = req.nextUrl.searchParams.get("preview");
  const previewTemplateId = req.nextUrl.searchParams.get("templateId");
  if (!previewDeviceId && !previewFlag && !previewTemplateId) {
    return "not-a-preview";
  }

  const session = await auth();
  if (!session?.user?.id) return "denied";
  const member = await prisma.member.findUnique({
    where: { id: session.user.id },
    select: {
      id: true,
      active: true,
      canLogin: true,
      accessRoles: { select: { role: true } },
    },
  });
  // `active` is the load-bearing flag, exactly as in requireAdmin (#2383).
  // Cancellation, archive and deletion deliberately leave the access-role rows
  // in place and none of them invalidates the session JWT — auth() only
  // re-stamps the token's roles from those same retained rows — so a preview
  // grant would otherwise survive an admin's departure until their token
  // expired. `canLogin` is selected too so hasAdminAccess resolves the
  // login-cleared role set rather than the stored one.
  if (!member?.active || !hasAdminAccess(member)) return "denied";

  if (previewDeviceId) {
    const device = await prisma.lodgeDisplayDevice.findUnique({
      where: { id: previewDeviceId },
      select: { lodgeId: true, templateId: true },
    });
    if (!device) return "denied";
    return { ...device, deviceId: previewDeviceId };
  }

  // Authored v2 template preview (LTV-036, ADR-003 §5, shrinks #64). Templates
  // are lodge-agnostic, so the lodge is EXPLICIT: ?previewLodge=<id> (validated
  // to exist and be active) or the club default when omitted — never a silent
  // default. This is the admin-session/direct-navigation form; the sandboxed
  // authoring-page embed uses ?previewGrant instead.
  if (previewTemplateId) {
    const lodgeId = await resolveOptionalActiveLodgeId(
      prisma,
      req.nextUrl.searchParams.get("previewLodge")
    );
    if (!lodgeId) return "denied";
    return { lodgeId, templateId: previewTemplateId };
  }

  return {
    lodgeId: await getDefaultLodgeId(prisma),
    templateId: null,
  };
}

// A device bound to a v2 Template loads through here. The result distinguishes
// the two shapes the caller must treat differently (LTV-030, ADR-003 §5 render
// health): a clean render, or a BROKEN BINDING — a device points at a Template
// that is missing, whose Layout is gone, or that fails validation/sanitisation.
// (The third shape, "no binding" — templateId null — never reaches here; the
// caller stays on the legacy path for it.)
type LoadLayoutRenderResult =
  | { ok: true; render: LayoutRenderPayload }
  | { ok: false };

// Load a device's bound v2 Template + its Layout and assemble the sanitised,
// validated `layoutRender` payload (LTV-027). A broken binding — a missing row,
// a validation/sanitise error, or a DB error — returns `{ ok: false }` and logs
// at warn level (a device is silently pointing at content that can never render,
// which an operator should see); the caller then keeps the legacy code-built-in
// `template` field and flags `layoutRenderError` so a preview can distinguish
// the silent fallback a real wall gets. Devices without templateId never reach
// here and keep the legacy behaviour unchanged.
async function loadLayoutRender(
  templateId: string,
  // LTV-028: value tokens ({{config:…}}/{{lodge-name}}/{{display-date}}) resolve
  // against the bound lodge's DisplayState at serve time, so the render needs it.
  state: DisplayState,
  // Diagnostic context for the broken-binding warn log (LTV-030). The device id
  // is absent for a default-lodge `?preview=1` render (no device involved).
  context: { deviceId?: string } = {}
): Promise<LoadLayoutRenderResult> {
  try {
    // The club theme provides the read-only `themeCss` variable block so an
    // authored template can `var(--brand-*)` (LTV-029). getWebsiteThemeRenderState
    // is best-effort (it swallows its own DB error and falls back to defaults),
    // so it never takes the layout render down.
    const [template, theme, format] = await Promise.all([
      prisma.displayTemplate.findUnique({
        where: { id: templateId },
        select: {
          slotContent: true,
          cssOverrides: true,
          footerHtml: true,
          layout: {
            select: { bodyHtml: true, defaultCss: true, areas: true },
          },
        },
      }),
      getWebsiteThemeRenderState(),
      clubFormatValues(), // the {{display-date}} token's format (#3566)
    ]);
    if (!template) {
      logger.warn(
        { templateId, deviceId: context.deviceId },
        "display layout render: bound template row is missing — falling back to legacy board"
      );
      return { ok: false };
    }
    const render = buildLayoutRender(
      {
        bodyHtml: template.layout.bodyHtml,
        defaultCss: template.layout.defaultCss,
        areas: template.layout.areas,
        slotContent: template.slotContent,
        cssOverrides: template.cssOverrides,
        footerHtml: template.footerHtml,
        themeCss: theme.css,
      },
      state,
      format
    );
    return { ok: true, render };
  } catch (error) {
    logger.warn(
      { err: error, templateId, deviceId: context.deviceId },
      "display layout render: bound template failed to build — falling back to legacy board"
    );
    return { ok: false };
  }
}

/** Fold a load result into the response body's layout fields (LTV-030). A clean
 * render attaches `layoutRender`; a broken binding attaches `layoutRenderError`
 * (so a preview can surface it) but never `layoutRender` — a real wall silently
 * gets the legacy `template` already on the body. `null` means no binding: no
 * layout fields at all. */
function layoutFields(
  result: LoadLayoutRenderResult | null
): { layoutRender: LayoutRenderPayload } | { layoutRenderError: true } | Record<string, never> {
  if (!result) return {};
  return result.ok ? { layoutRender: result.render } : { layoutRenderError: true };
}

// The simulated preview start date (issue #60): strict date-only shape plus a
// real-calendar validity check. Malformed values fall back to today silently
// (null → the serialiser starts from today). Preview-only; the caller must
// never reach this from the device path.
function parsePreviewDate(req: NextRequest): Date | null {
  const raw = req.nextUrl.searchParams.get("previewDate");
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw) || !isDateOnlyString(raw)) {
    return null;
  }
  return parseDateOnly(raw);
}

export async function GET(req: NextRequest) {
  const rateLimited = await applyRateLimit(rateLimiters.api, req);
  if (rateLimited) return rateLimited;

  const daysParam = req.nextUrl.searchParams.get("days");
  const days = daysParam === null ? null : Number(daysParam);

  // Sandboxed preview grant (LTV-036): checked before any cookie/session — the
  // opaque-origin iframe carries neither. A verified grant renders exactly its
  // signed template/lodge, never stamps lastSeenAt, and responds with the CORS
  // header the framed (opaque-origin) fetch needs. Anything wrong with the grant
  // (bad shape, forged signature, expired) → 401, and does NOT fall through to
  // the session paths (the iframe has no session to try).
  const grantParam = req.nextUrl.searchParams.get("previewGrant");
  if (grantParam) {
    const grant = decodePreviewGrant(grantParam);
    if (!grant) {
      return grantJson({ error: "Unauthorised" }, 401);
    }
    // Window start for the grant render (issue #176). The grant is a signed,
    // single-purpose, per-preview capability: when it carries a windowStart, that
    // SIGNED value is authoritative and an unsigned `?previewDate` on the
    // (sandbox-rewritable) iframe URL must not shift or widen the served window
    // beyond it — the signed value wins. Only when the grant carries NO signed
    // windowStart does the in-frame date picker's `?previewDate` drive the window
    // (the admin re-mints the grant on the outer preview page to change a signed
    // date), which keeps the date-simulation UX working for the common case.
    const grantWindowStart = grant.windowStart
      ? parseDateOnly(grant.windowStart)
      : parsePreviewDate(req);
    const state = await buildDisplayState(grant.lodgeId, {
      days,
      windowStart: grantWindowStart,
    });
    if (!state) {
      return grantJson({ error: "Unauthorised" }, 401);
    }
    const template = resolveDisplayTemplateForDevice({ templateKey: null });
    // A draft grant (ADR-004 §7) names an ephemeral, ALREADY-RENDERED payload in
    // the in-memory draft-preview store — read it by nonce (no DB row). An
    // expired/unknown nonce yields a broken-binding result, exactly like a
    // missing template row, so the frame falls back to the legacy board rather
    // than erroring. A saved-template grant keeps the DB render path.
    let layoutResult: LoadLayoutRenderResult | null;
    if (grant.draftNonce) {
      const rendered = getDraftPreview(grant.draftNonce);
      layoutResult = rendered ? { ok: true, render: rendered } : { ok: false };
    } else if (grant.templateId) {
      layoutResult = await loadLayoutRender(grant.templateId, state);
    } else {
      layoutResult = null;
    }
    return grantJson({
      ...state,
      template: template.definition,
      // Previews (grant/session) don't need a custom cadence — the default keeps
      // the admin's preview refreshing without touching a device's setting.
      pollSeconds: DISPLAY_DEFAULT_POLL_SECONDS,
      ...layoutFields(layoutResult),
    });
  }

  const deviceAuth = await checkDisplayAuth(req);
  if (deviceAuth) {
    const state = await buildDisplayState(deviceAuth.device.lodgeId, { days });
    if (!state) {
      // The device's lodge no longer exists or is inactive — treat exactly
      // like a failed auth rather than serving a partial payload (AC8).
      return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
    }
    const template = resolveDisplayTemplateForDevice({ templateKey: null });
    // The poll doubles as the device heartbeat (issue #52): only genuine
    // device-token fetches stamp lastSeenAt — previews never do.
    await prisma.lodgeDisplayDevice.update({
      where: { id: deviceAuth.device.id },
      data: { lastSeenAt: new Date() },
    });
    // A device bound to a v2 Template (templateId) renders through the layout
    // engine; the legacy `template` field always ships too, as the safe
    // fallback the client uses when layoutRender is absent or broken (LTV-027/030).
    const layoutResult = deviceAuth.device.templateId
      ? await loadLayoutRender(deviceAuth.device.templateId, state, {
          deviceId: deviceAuth.device.id,
        })
      : null;
    return stateJson({
      ...state,
      template: template.definition,
      // The device's effective poll cadence (LTV-039): the client drives its
      // active-board tick from this. Clamped 15–600 here (null → default), so an
      // out-of-range legacy value can never make the wall hammer or starve the API.
      pollSeconds: clampPollSeconds(deviceAuth.device.pollSeconds),
      ...layoutFields(layoutResult),
    });
  }

  const preview = await resolvePreview(req);
  if (preview === "not-a-preview" || preview === "denied") {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const state = await buildDisplayState(preview.lodgeId, {
    days,
    windowStart: parsePreviewDate(req),
  });
  if (!state) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const template = resolveDisplayTemplateForDevice({ templateKey: null });
  // ?previewDevice of a v2-bound device renders the layout engine; ?preview=1
  // (templateId null) stays on the club-default fallback board.
  const layoutResult = preview.templateId
    ? await loadLayoutRender(preview.templateId, state, {
        deviceId: preview.deviceId,
      })
    : null;
  return stateJson({
    ...state,
    template: template.definition,
    // A preview (?previewDevice/?preview) always gets the default cadence — the
    // admin is watching a board, not driving a device's own heartbeat.
    pollSeconds: DISPLAY_DEFAULT_POLL_SECONDS,
    ...layoutFields(layoutResult),
  });
}
