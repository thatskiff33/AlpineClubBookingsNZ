import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { resolveOptionalActiveLodgeId } from "@/lib/lodges";
import {
  encodePreviewGrant,
  PREVIEW_GRANT_TTL_SECONDS,
} from "@/lib/lodge-display-auth";
import { buildDisplayState } from "@/lib/lodge-display-state";
import { buildLayoutRender } from "@/lib/lodge-display/layout-render";
import {
  validateLayoutForSave,
  validateTemplateForSave,
} from "@/lib/lodge-display/authoring-validation";
import { getWebsiteThemeRenderState } from "@/lib/club-theme";
import { parseDateOnly } from "@/lib/date-only";
import {
  storeDraftPreview,
  DRAFT_PREVIEW_TTL_SECONDS,
} from "@/lib/lodge-display/draft-preview-store";
import { clubFormatValues } from "@/lib/club-format-server";

// Preview grant mint (LTV-036, ADR-003 §5). The authoring pages preview an
// AUTHORED template inside a `sandbox="allow-scripts"` iframe (opaque origin, no
// cookies), so the framed /display cannot use the admin's session. This
// admin-only endpoint mints the short-lived, HMAC-signed capability the iframe
// carries as ?previewGrant=<token>: it names exactly one template + lodge (+ an
// optional simulated date) and expires in five minutes.
//
// The grant is issued here, under requireAdmin — the ONLY place an admin's
// authority converts into a sessionless preview capability. It is stateless
// (nothing persisted; the signature is the whole authority) and single-purpose:
// it authorises the state route's preview path and nothing else (§5), so a
// leaked grant can at worst re-render a five-minute, privacy-reduced board.

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// An UNSAVED builder draft to preview (ADR-004 §7). The HTML/CSS fields are
// strings; `areas` / `slotContent` are untyped JSON the save contract validates
// (mirrors the LayoutForSave / TemplateForSave shapes). Passed under the admin
// session only; validated + rendered before any grant is minted.
const draftField = z
  .object({
    bodyHtml: z.string(),
    defaultCss: z.string(),
    areas: z.unknown(),
    slotContent: z.unknown(),
    cssOverrides: z.string(),
    footerHtml: z.string(),
  })
  .strict();

const bodyField = z
  .object({
    // Null/omitted → preview the lodge's legacy board (no authored template).
    templateId: z.string().min(1).nullish(),
    // An unsaved draft to preview instead of a stored template (ADR-004 §7).
    // Mutually exclusive with templateId (a draft wins if both are somehow sent).
    draft: draftField.nullish(),
    // Templates are lodge-agnostic, so the lodge is explicit; omitted → the
    // club default lodge (resolveOptionalActiveLodgeId).
    previewLodge: z.string().min(1),
    // Optional simulated window start (LTV-017).
    previewDate: z.string().regex(DATE_ONLY).nullish(),
  })
  .strict();

export async function POST(req: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  let body: z.infer<typeof bodyField>;
  try {
    body = bodyField.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  // The lodge must exist and be active (or default when omitted); an admin path,
  // so a cross-lodge preview is in-policy, but a bogus/inactive lodge is a 400.
  const lodgeId = await resolveOptionalActiveLodgeId(prisma, body.previewLodge);
  if (!lodgeId) {
    return NextResponse.json({ error: "Unknown or inactive lodge" }, { status: 400 });
  }

  // ---- Unsaved-draft preview (ADR-004 §7) ---------------------------------
  // Under the admin session, validate the draft through the EXACT save contract,
  // then render it against the chosen lodge's privacy-reduced DisplayState and
  // hold the result in the ephemeral store. Preview IS the save gate (ADR-003 §5
  // "preview-before-save"): a broken draft returns the same structured
  // errors/warnings the save UI shows and NO grant is minted, so a broken draft
  // can never reach a rendered frame. buildLayoutRender re-runs the same
  // validation + sanitisation the serve path applies, so nothing unsafe is stored.
  if (body.draft) {
    const draft = body.draft;
    const layoutVerdict = validateLayoutForSave({
      bodyHtml: draft.bodyHtml,
      defaultCss: draft.defaultCss,
      areas: draft.areas,
    });
    const templateVerdict = validateTemplateForSave({
      layout: { bodyHtml: draft.bodyHtml, areas: draft.areas },
      slotContent: draft.slotContent,
      cssOverrides: draft.cssOverrides,
      footerHtml: draft.footerHtml,
    });
    if (!layoutVerdict.ok || !templateVerdict.ok) {
      // Merge both halves' findings into the save-UI shape (errors refuse; the
      // warnings ride along). No grant is minted.
      const errors = [
        ...(layoutVerdict.ok ? [] : layoutVerdict.errors),
        ...(templateVerdict.ok ? [] : templateVerdict.errors),
      ];
      const warnings = [...layoutVerdict.warnings, ...templateVerdict.warnings];
      return NextResponse.json({ ok: false, errors, warnings }, { status: 422 });
    }

    const windowStart = body.previewDate ? parseDateOnly(body.previewDate) : null;
    const state = await buildDisplayState(lodgeId, { windowStart });
    if (!state) {
      return NextResponse.json({ error: "Unknown or inactive lodge" }, { status: 400 });
    }
    const lodge = await prisma.lodge.findUnique({
      where: { id: lodgeId },
      select: { id: true, name: true },
    });
    if (!lodge) {
      return NextResponse.json({ error: "Unknown or inactive lodge" }, { status: 400 });
    }
    const [theme, format] = await Promise.all([
      getWebsiteThemeRenderState(),
      // The club's date format (#3566), for the {{display-date}} token.
      clubFormatValues(),
    ]);
    // buildLayoutRender validates + sanitises again; it cannot throw here (the
    // save contract already passed) but a defensive guard keeps a surprise from
    // 500ing rather than reporting.
    let nonce: string;
    try {
      const rendered = buildLayoutRender(
        {
          bodyHtml: draft.bodyHtml,
          defaultCss: draft.defaultCss,
          areas: draft.areas,
          slotContent: draft.slotContent,
          cssOverrides: draft.cssOverrides,
          footerHtml: draft.footerHtml,
          themeCss: theme.css,
        },
        state,
        format
      );
      nonce = storeDraftPreview(rendered, DRAFT_PREVIEW_TTL_SECONDS);
    } catch {
      return NextResponse.json(
        {
          ok: false,
          errors: [{ path: "draft", message: "The draft could not be rendered." }],
          warnings: [] as { path: string; message: string }[],
        },
        { status: 422 }
      );
    }

    const token = encodePreviewGrant({
      templateId: null,
      draftNonce: nonce,
      lodgeId,
      ...(body.previewDate ? { windowStart: body.previewDate } : {}),
      exp: Math.floor(Date.now() / 1000) + PREVIEW_GRANT_TTL_SECONDS,
    });
    return NextResponse.json({
      token,
      lodgeId: lodge.id,
      lodgeName: lodge.name,
      expiresInSeconds: PREVIEW_GRANT_TTL_SECONDS,
      // Warnings ride along on a successful draft mint so the builder surfaces
      // auto-sanitised CSS the same way the save UI does.
      warnings: [...layoutVerdict.warnings, ...templateVerdict.warnings],
    });
  }

  // A named template must actually exist — mint a grant only for something the
  // state route can render (else the preview would silently fall back).
  if (body.templateId) {
    const template = await prisma.displayTemplate.findUnique({
      where: { id: body.templateId },
      select: { id: true },
    });
    if (!template) {
      return NextResponse.json({ error: "Template not found" }, { status: 404 });
    }
  }

  const lodge = await prisma.lodge.findUnique({
    where: { id: lodgeId },
    select: { id: true, name: true },
  });
  if (!lodge) {
    return NextResponse.json({ error: "Unknown or inactive lodge" }, { status: 400 });
  }

  const token = encodePreviewGrant({
    templateId: body.templateId ?? null,
    lodgeId,
    ...(body.previewDate ? { windowStart: body.previewDate } : {}),
    exp: Math.floor(Date.now() / 1000) + PREVIEW_GRANT_TTL_SECONDS,
  });

  // The lodge id/name ride back so the authoring UI can label the preview
  // "previewing against <lodge>" without a second round-trip (the old silent
  // default becomes explicit — shrinks #64).
  return NextResponse.json({
    token,
    lodgeId: lodge.id,
    lodgeName: lodge.name,
    expiresInSeconds: PREVIEW_GRANT_TTL_SECONDS,
  });
}
