import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
  buildStoredMetadata,
  type AuditMetadataOptions,
} from "@/lib/audit";
import {
  canDeletePage,
  canUnpublishPage,
  isBuiltinPageSlug,
  isReservedPageSlug,
  isSystemPageSlug,
  isValidPageSlug,
  normalizePageSlug,
  PAGE_CONTENT_LIMITS,
  SITE_CONTENT_KEYS,
  SYSTEM_PAGE_SLUGS,
  toPagePath,
} from "@/lib/page-content";
import logger from "@/lib/logger";
import {
  listEditablePageContent,
  sanitizePageContentHtml,
} from "@/lib/page-content-html";
import { revalidatePublicPageContent } from "@/lib/public-content-revalidation";

// The one answer for a page that does not exist, including the loser of two
// simultaneous deletes (#3852).
// Named once: the audit write and the "will the stored copy be whole?" check
// below must hand `buildStoredMetadata` the same action.
const PAGE_CONTENT_DELETED_ACTION = "PAGE_CONTENT_DELETED";

const PAGE_NOT_FOUND = "Page not found";

const createSchema = z
  .object({
    caption: z.string().trim().max(PAGE_CONTENT_LIMITS.captionMax),
    menuTitle: z.string().trim().max(PAGE_CONTENT_LIMITS.menuTitleMax),
    title: z.string().trim().min(1).max(PAGE_CONTENT_LIMITS.titleMax),
    headerText: z.string().max(PAGE_CONTENT_LIMITS.headerTextMax),
    slug: z.string().trim().min(1).max(PAGE_CONTENT_LIMITS.slugMax),
    sortOrder: z
      .number()
      .int()
      .min(PAGE_CONTENT_LIMITS.sortOrderMin)
      .max(PAGE_CONTENT_LIMITS.sortOrderMax),
  })
  .strict();

const updateSchema = z
  .object({
    id: z.string().trim().min(1),
    caption: z.string().trim().max(PAGE_CONTENT_LIMITS.captionMax),
    menuTitle: z.string().trim().max(PAGE_CONTENT_LIMITS.menuTitleMax),
    title: z.string().trim().min(1).max(PAGE_CONTENT_LIMITS.titleMax),
    headerText: z.string().max(PAGE_CONTENT_LIMITS.headerTextMax),
    slug: z.string().trim().min(1).max(PAGE_CONTENT_LIMITS.slugMax),
    sortOrder: z
      .number()
      .int()
      .min(PAGE_CONTENT_LIMITS.sortOrderMin)
      .max(PAGE_CONTENT_LIMITS.sortOrderMax),
    contentHtml: z.string().max(PAGE_CONTENT_LIMITS.contentHtmlMax),
  })
  .strict();

const patchSchema = z
  .object({
    id: z.string().trim().min(1),
    published: z.boolean(),
  })
  .strict();

// The id travels in the body, matching how PUT and PATCH already address a page
// on this same collection route (#2352 D-B7(a)). See the DELETE handler's own
// comment for why a `[id]/route.ts` was not chosen.
const deleteSchema = z
  .object({
    id: z.string().trim().min(1),
  })
  .strict();

function unauthorizedResponse() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

// Preserve this route's custom 401-shaped forbidden response while making the
// content-area permission explicit (GET reads with view, mutations with edit).
const viewGuardOptions = {
  forbiddenResponse: unauthorizedResponse,
  permission: { area: "content", level: "view" },
} as const;

const editGuardOptions = {
  forbiddenResponse: unauthorizedResponse,
  permission: { area: "content", level: "edit" },
} as const;

export async function GET() {
  const guard = await requireAdmin(viewGuardOptions);
  if (!guard.ok) {
    return guard.response;
  }

  const pages = await listEditablePageContent();
  return NextResponse.json({ pages });
}

export async function POST(request: NextRequest) {
  const guard = await requireAdmin(editGuardOptions);
  if (!guard.ok) {
    return guard.response;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const slug = normalizePageSlug(parsed.data.slug);
  if (!isValidPageSlug(slug)) {
    return NextResponse.json(
      {
        error:
          "Slug must use lowercase letters, numbers, and hyphens, with optional forward slashes between segments (for example: trip-reports or join/apply)",
      },
      { status: 400 },
    );
  }

  if (isReservedPageSlug(slug)) {
    return NextResponse.json(
      {
        error:
          "This slug is reserved for part of the application (for example admin, login, pay, calendar or profile) and cannot be used for a content page. Choose a different first word.",
      },
      { status: 400 },
    );
  }

  const path = toPagePath(slug);

  const safeHeaderText = sanitizePageContentHtml(parsed.data.headerText);

  const existing = await prisma.pageContent.findFirst({
    where: {
      OR: [{ slug }, { path }],
    },
    select: { id: true },
  });

  if (existing) {
    return NextResponse.json(
      { error: "A page with that slug already exists" },
      { status: 409 },
    );
  }

  const created = await prisma.pageContent.create({
    data: {
      slug,
      path,
      caption: parsed.data.caption,
      menuTitle: parsed.data.menuTitle,
      title: parsed.data.title,
      headerText: safeHeaderText,
      sortOrder: parsed.data.sortOrder,
      contentHtml: "",
      updatedByMemberId: guard.session.user.id,
    },
  });

  await prisma.auditLog.create(
    buildStructuredAuditLogCreateArgs({
      action: "PAGE_CONTENT_CREATED",
      actor: { memberId: guard.session.user.id },
      entity: {
        type: "PageContent",
        id: created.id,
      },
      category: "admin",
      severity: "important",
      outcome: "success",
      summary: `Page created for ${slug}`,
      metadata: {
        slug,
        path,
        caption: created.caption,
        menuTitle: created.menuTitle,
        title: created.title,
        headerText: created.headerText,
        sortOrder: created.sortOrder,
      },
      request: getAuditRequestContext(request),
    }),
  );

  revalidatePublicPageContent();
  return NextResponse.json(
    {
      page: {
        id: created.id,
        slug: created.slug,
        path: created.path,
        caption: created.caption,
        menuTitle: created.menuTitle,
        title: created.title,
        headerText: created.headerText,
        sortOrder: created.sortOrder,
        contentHtml: created.contentHtml,
        published: created.published,
        updatedAt: created.updatedAt.toISOString(),
        updatedByMemberId: created.updatedByMemberId,
      },
    },
    { status: 201 },
  );
}

export async function PUT(request: NextRequest) {
  const guard = await requireAdmin(editGuardOptions);
  if (!guard.ok) {
    return guard.response;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const slug = normalizePageSlug(parsed.data.slug);
  if (!isValidPageSlug(slug)) {
    return NextResponse.json(
      {
        error:
          "Slug must use lowercase letters, numbers, and hyphens, with optional forward slashes between segments (for example: trip-reports or join/apply)",
      },
      { status: 400 },
    );
  }

  const path = toPagePath(slug);

  const safeContentHtml = sanitizePageContentHtml(parsed.data.contentHtml);
  const safeHeaderText = sanitizePageContentHtml(parsed.data.headerText);

  const existing = await prisma.pageContent.findUnique({
    where: {
      id: parsed.data.id,
    },
  });

  if (!existing) {
    return NextResponse.json({ error: PAGE_NOT_FOUND }, { status: 404 });
  }

  // The reserved-slug rule gates admin-CREATED pages, so a BUILT-IN row keeping
  // its own slug is exempt. It has to be: since #2818 reserved the
  // `booking-requests` and `school-bookings` namespaces (decision 9), and since
  // both bare addresses are claimed by real `(website-dynamic)` routes, those two
  // slugs are reserved twice over — and an admin who cannot save that row cannot
  // set the menu title that opts the page into the navigation, which is the whole
  // of decision 1. `/contact`, `/join/apply` and the policy pages are exempted by
  // the same line rather than by luck; they are not reserved today, but nothing
  // guarantees that stays true.
  //
  // Deliberately narrow. It exempts only a built-in row whose slug is UNCHANGED,
  // so it cannot be used to move an ordinary page onto a reserved address, and it
  // is checked after the row is loaded so the exemption is about the row being
  // edited rather than about the value the caller typed.
  const editingBuiltinInPlace =
    isBuiltinPageSlug(existing.slug) && slug === existing.slug;

  if (!editingBuiltinInPlace && isReservedPageSlug(slug)) {
    return NextResponse.json(
      {
        error:
          "This slug is reserved for part of the application (for example admin, login, pay, calendar or profile) and cannot be used for a content page. Choose a different first word.",
      },
      { status: 400 },
    );
  }

  // System pages have fixed slugs and fixed sort orders.
  if (isSystemPageSlug(existing.slug)) {
    if (slug !== existing.slug) {
      return NextResponse.json(
        { error: `The slug for this system page cannot be changed` },
        { status: 422 },
      );
    }
    const fixedOrder = SYSTEM_PAGE_SLUGS.get(existing.slug)!;
    if (parsed.data.sortOrder !== fixedOrder) {
      return NextResponse.json(
        {
          error: `Menu order for "${existing.slug}" is fixed at ${fixedOrder} and cannot be changed`,
        },
        { status: 422 },
      );
    }
  }

  const duplicate = await prisma.pageContent.findFirst({
    where: {
      id: { not: parsed.data.id },
      OR: [{ slug }, { path }],
    },
    select: { id: true },
  });

  if (duplicate) {
    return NextResponse.json(
      { error: "Another page already uses that slug" },
      { status: 409 },
    );
  }

  const updated = await prisma.pageContent.update({
    where: { id: parsed.data.id },
    data: {
      slug,
      path,
      caption: parsed.data.caption,
      menuTitle: parsed.data.menuTitle,
      title: parsed.data.title,
      headerText: safeHeaderText,
      sortOrder: parsed.data.sortOrder,
      contentHtml: safeContentHtml,
      updatedByMemberId: guard.session.user.id,
    },
  });

  await prisma.auditLog.create(
    buildStructuredAuditLogCreateArgs({
      action: "PAGE_CONTENT_UPDATED",
      actor: { memberId: guard.session.user.id },
      entity: {
        type: "PageContent",
        id: updated.id,
      },
      category: "admin",
      severity: "important",
      outcome: "success",
      summary: `Page content updated for ${slug}`,
      metadata: {
        slug,
        path,
        caption: parsed.data.caption,
        menuTitle: parsed.data.menuTitle,
        title: parsed.data.title,
        headerText: safeHeaderText,
        sortOrder: parsed.data.sortOrder,
        previousLength: existing?.contentHtml.length ?? 0,
        nextLength: safeContentHtml.length,
      },
      request: getAuditRequestContext(request),
    }),
  );

  revalidatePublicPageContent();
  return NextResponse.json({
    page: {
      id: updated.id,
      slug: updated.slug,
      path: updated.path,
      caption: updated.caption,
      menuTitle: updated.menuTitle,
      title: updated.title,
      headerText: updated.headerText,
      sortOrder: updated.sortOrder,
      contentHtml: updated.contentHtml,
      published: updated.published,
      updatedAt: updated.updatedAt.toISOString(),
      updatedByMemberId: updated.updatedByMemberId,
    },
  });
}

// Toggles a page's public visibility (publish/unpublish). Only admin-created
// pages can be hidden; system and built-in pages must always stay published.
export async function PATCH(request: NextRequest) {
  const guard = await requireAdmin(editGuardOptions);
  if (!guard.ok) {
    return guard.response;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const existing = await prisma.pageContent.findUnique({
    where: { id: parsed.data.id },
  });

  if (!existing) {
    return NextResponse.json({ error: PAGE_NOT_FOUND }, { status: 404 });
  }

  // System pages (home, 404) and built-in design pages are linked from code
  // routes, the footer, and the sitemap, so they cannot be hidden.
  if (!parsed.data.published && !canUnpublishPage(existing.slug)) {
    return NextResponse.json(
      { error: "This page cannot be hidden from the public site" },
      { status: 422 },
    );
  }

  const updated = await prisma.pageContent.update({
    where: { id: parsed.data.id },
    data: {
      published: parsed.data.published,
      updatedByMemberId: guard.session.user.id,
    },
  });

  await prisma.auditLog.create(
    buildStructuredAuditLogCreateArgs({
      action: "PAGE_CONTENT_VISIBILITY_CHANGED",
      actor: { memberId: guard.session.user.id },
      entity: {
        type: "PageContent",
        id: updated.id,
      },
      category: "admin",
      severity: "important",
      outcome: "success",
      summary: `Page ${updated.published ? "published" : "unpublished"} for ${existing.slug}`,
      metadata: {
        slug: existing.slug,
        path: existing.path,
        published: updated.published,
      },
      request: getAuditRequestContext(request),
    }),
  );

  revalidatePublicPageContent();
  return NextResponse.json({
    page: {
      id: updated.id,
      slug: updated.slug,
      path: updated.path,
      caption: updated.caption,
      menuTitle: updated.menuTitle,
      title: updated.title,
      headerText: updated.headerText,
      sortOrder: updated.sortOrder,
      contentHtml: updated.contentHtml,
      published: updated.published,
      updatedAt: updated.updatedAt.toISOString(),
      updatedByMemberId: updated.updatedByMemberId,
    },
  });
}

/**
 * Raised inside the DELETE transaction when the row is already gone (#3852).
 *
 * The existence check runs before the transaction, so two officers deleting the
 * same page both pass it and the loser's `delete` raises P2025. Thrown as its own
 * type rather than answered in place so the whole transaction rolls back — the
 * Book Now repoint must not outlive a delete that did not happen — and mapped to
 * the same `404 "Page not found"` the existence check gives.
 */
class PageAlreadyDeletedError extends Error {
  constructor() {
    super("Page already deleted");
    this.name = "PageAlreadyDeletedError";
  }
}

/**
 * Did the archived `before` row survive the audit sanitiser exactly (#3852)?
 *
 * Three things in the sanitiser can leave the officer's only recovery copy
 * incomplete while the delete still succeeds: `SECRET_VALUE_PATTERN` replaces a
 * whole string with `[REDACTED]` on one match, key-value and card-number
 * redaction rewrite part of one, and a payload over the JSON budget is reduced
 * to the fields that fit (#2704) — and `before`, the largest field and not a
 * string, is dropped by name rather than clipped. Each is the protection working
 * as designed, so this does not fight them; it reports them. Compared field by
 * field against the row the DELETE returned.
 */
function isArchivedSnapshotComplete(
  stored: unknown,
  before: Record<string, string | number | boolean | null>,
): boolean {
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) {
    return false;
  }
  const kept = (stored as { before?: unknown }).before;
  if (typeof kept !== "object" || kept === null || Array.isArray(kept)) {
    return false;
  }
  const keptFields = kept as Record<string, unknown>;
  return Object.entries(before).every(
    ([key, value]) => keptFields[key] === value,
  );
}

/**
 * Deletes an admin-created content page for good (#2352 MC-03D, Option B).
 *
 * **Why this method exists at all.** Every other way public page content can
 * change already clears the stored public site; deletion was the one supported
 * lifecycle step with no writer, so the measurement gate could not prove
 * deletion invalidation the way it proved the other 39 writers'. This is that
 * writer. It needs no new public-site behaviour: the `(website)/[...slug]`
 * catch-all already answers 404 for an address with no published row, so a
 * deleted page 404s through the same path a hidden one does (D-B2(a)).
 *
 * **It is final, by decision (D-B1(a)).** There is no second soft-delete state,
 * because the product already has one: `PATCH published: false` hides a page and
 * publishes it again, which is soft delete with restore. A `deletedAt` column
 * would ship a hidden state indistinguishable from the existing one to every
 * visitor and every officer, and would leave a soft-deleted row inside
 * `listPublishedCmsPagePaths()` — the pre-cutover warm-up plan — demanding a 200
 * for an address that must 404. The complete `before` row in the audit entry is
 * the recovery route, which is why the snapshot below is the whole row, is taken
 * from the row the DELETE itself removed, is archived at the stored length of its
 * text rather than the audit log's default 1,000-character string clip, and is
 * reported as incomplete when the sanitiser could not keep it whole (#3852).
 *
 * **Route shape (D-B7(a)).** `DELETE` on the collection with the id in the body,
 * not a new `[id]/route.ts`. Both mutating methods here already address a page
 * that way; it keeps this route's deliberate 401-shaped forbidden response,
 * which the admin panel already handles. It also once let the MC-03D
 * measurement harness watch THIS file alone for a DELETE export; that harness
 * is gone (#3382) but the shape was never only about it. The REST-shaped
 * alternative reads better and is still a legitimate future preference.
 *
 * **References are reported, not blocking (D-B4(a)).** In-content links are free
 * text an officer can spell any number of ways, so a substring check that refused
 * the delete would be both bypassable and infuriating; the same check used to warn
 * is honest about being best-effort. It covers BOTH admin-authored link surfaces:
 * the other pages' body/intro text, and the keyed `SiteContent` footer sections —
 * which are edited under this same `content` permission and render on every public
 * page, so a footer link left dangling is the widest miss of the two (first review,
 * finding 3). Navigation needs no rule — the menu is derived from the rows
 * themselves.
 *
 * **The Book Now target is repointed, not left half-set (first review, finding 1).**
 * The FK is `onDelete: SetNull` and `getBookNowConfig()` fails open, so the public
 * button was never going to dangle. The stored PAIR was the problem: `SetNull`
 * clears `bookNowPageId` and leaves `bookNowTarget = "PAGE"`, which is a
 * combination the settings panel's own PUT rejects with
 * `400 "Select a published page for the Book Now target."` — so the officer could
 * not save ANY change in that sibling panel (fee/policy visibility, committee
 * photo, `showBookNow`) until they noticed and moved the radio. The transaction
 * below sets the target back to the booking flow itself — before the delete for
 * a row that points here, and again after it for the `PAGE` + null pair the FK's
 * own `SetNull` can still leave (#3852) — so the row it leaves behind is always
 * one its own writer would accept. Doing that SILENTLY is the surprise an audit
 * row cannot prevent, which is what the two flags in the response are for.
 */
export async function DELETE(request: NextRequest) {
  // Same gate as editing and hiding (D-B5(a)): `content:edit` already permits
  // replacing a page's entire body and taking it off the public site, both of
  // which have an equal or larger public blast radius. A Full-Admin-only bar was
  // considered; the two existing Full-Admin gates protect whole-instance config
  // transfer and provider secrets, and there is no third permission tier to
  // promote a delete into. The audit snapshot and the confirmation are the real
  // controls.
  const guard = await requireAdmin(editGuardOptions);
  if (!guard.ok) {
    return guard.response;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = deleteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const existing = await prisma.pageContent.findUnique({
    where: { id: parsed.data.id },
  });

  if (!existing) {
    return NextResponse.json({ error: PAGE_NOT_FOUND }, { status: 404 });
  }

  // Never wider than hiding: system pages (home, 404) and the built-in design
  // pages are read by code routes at literal paths and linked from the footer and
  // the sitemap, so deleting one would 404 a page the product itself links.
  if (!canDeletePage(existing.slug)) {
    return NextResponse.json(
      { error: "This page cannot be deleted from the public site" },
      { status: 422 },
    );
  }

  // Best-effort reference report, gathered BEFORE the write so the response can
  // describe what the club just lost. A plain substring match on the page's path,
  // the same semantics the image-library delete uses for its own report: a page
  // whose text happens to mention a LONGER path starting with these characters is
  // reported too. Over-reporting a warning is the safe direction. A RELATIVE href
  // ("../trip-reports") still slips past it, and that limitation is stated in the
  // operator guide rather than left as a surprise.
  //
  // Two sources, because the club has two places to author a link (first review,
  // finding 3). The footer sections were the silent gap: `FOOTER_QUICK_LINKS` and
  // `FOOTER_AFFILIATIONS` are HTML link lists edited under this same `content`
  // permission and rendered on EVERY public page, so reporting "nothing points at
  // it" while the footer did was the most misleading answer this endpoint could
  // give. Filtered to the same `SITE_CONTENT_KEYS` allowlist the site-content
  // route enforces, so a future non-public key cannot silently join the scan.
  //
  // The missing-row fallback in `getSiteFooterContent()` cannot hide a reference
  // here: a club with no stored row renders `starterSiteContent`, whose only links
  // are to built-in pages (`/about`, `/join`, `/faq`, `/rules`, `/contact`,
  // `/login`) — none of which is deletable at all.
  const [referencingPages, referencingFooterSections] = await Promise.all([
    prisma.pageContent.findMany({
      where: {
        id: { not: existing.id },
        OR: [
          { contentHtml: { contains: existing.path } },
          { headerText: { contains: existing.path } },
        ],
      },
      select: { slug: true },
      orderBy: { slug: "asc" },
    }),
    prisma.siteContent.findMany({
      where: {
        key: { in: [...SITE_CONTENT_KEYS] },
        contentHtml: { contains: existing.path },
      },
      select: { key: true },
      orderBy: { key: "asc" },
    }),
  ]);

  const referencedBySlugs = referencingPages.map((page) => page.slug);
  const referencedByFooterSections = referencingFooterSections.map(
    (section) => section.key,
  );

  // Delete the row and record what was removed atomically, so a page can never
  // vanish without the audit entry that is its only recovery route.
  let outcome: {
    removed: { id: string; slug: string; path: string; title: string; published: boolean };
    // Was the public header's Book Now button pointing here? Answered by the
    // statement that moves it, not by a read taken earlier.
    wasBookNowTarget: boolean;
    // Did the stored pair need correcting AFTER the delete (#3852)? A different
    // question from the one above, which the pre-delete statement cannot see.
    bookNowPairRepaired: boolean;
    // Did the archived `before` row survive the audit sanitiser whole (#3852)?
    snapshotComplete: boolean;
  };
  try {
    outcome = await prisma.$transaction(async (tx) => {
      // Repoint the Book Now button BEFORE the delete, in the same transaction
      // (first review, finding 1). `onDelete: SetNull` would clear the id and
      // leave the target reading "PAGE", and that pair is one the settings
      // panel's own PUT refuses to save — wedging every unrelated control in that
      // panel until the officer moved the radio by hand.
      //
      // Scoped to a row that still points here with the target on `PAGE`, so
      // `count` is the fact at delete time. An officer who repoints at ANOTHER
      // page keeps their choice: the where-clause no longer matches their row.
      // It does not close the other direction on its own (#3852): when the
      // setting points elsewhere this matches no row and so locks nothing, and a
      // settings PUT can still point AT this page before the delete runs. The
      // repair after the delete covers that.
      //
      // Recorded, not silent: `wasBookNowTarget` goes into the audit metadata
      // below and into the response. No second PUBLIC_CONTENT_SETTINGS_UPDATED
      // row is written for it on purpose — the deletion entry explains WHY the
      // target moved.
      const repointed = await tx.publicContentSettings.updateMany({
        where: { bookNowPageId: existing.id, bookNowTarget: "PAGE" },
        data: {
          bookNowTarget: "BOOKING_FLOW",
          bookNowPageId: null,
          updatedByMemberId: guard.session.user.id,
        },
      });

      // The row actually destroyed, not the one read before the transaction
      // (#3852). Nothing locks the page between that read and this statement, so
      // a concurrent PUT on this route can commit a new body in the window; the
      // DELETE returns the row it removed, so archiving it keeps that edit where
      // archiving the earlier read would lose it for good.
      let removed: Awaited<ReturnType<typeof tx.pageContent.delete>>;
      try {
        removed = await tx.pageContent.delete({ where: { id: existing.id } });
      } catch (err) {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === "P2025"
        ) {
          throw new PageAlreadyDeletedError();
        }
        throw err;
      }

      // The other half of the Book Now repoint (#3852). By here the FK's
      // `SetNull` has fired, so if a settings PUT pointed at this page after the
      // statement above, the stored pair is now `PAGE` + null. Scoped to the null
      // id, which a saved choice of another page can never have, so it cannot
      // move an officer's real choice; it matches nothing on the ordinary path.
      const repaired = await tx.publicContentSettings.updateMany({
        where: { bookNowTarget: "PAGE", bookNowPageId: null },
        data: {
          bookNowTarget: "BOOKING_FLOW",
          updatedByMemberId: guard.session.user.id,
        },
      });

      // Archive mode, following the email-template reset
      // (`email-templates/reset/route.ts`). Without it the audit log's default
      // clips every string at 1,000 characters, so the "complete before row" this
      // decision rests on would be the first paragraph of the page.
      //
      // Sized from the STORED text, floored at this route's input caps (#3852).
      // The caps bound the input, not the column: `PUT` entity-escapes after zod
      // (`&` → `&amp;`), so an `&`-dense body accepted under the cap is stored
      // several times longer, and a payload over the JSON budget
      // (`24,000 + maxStringLength * 2`) is reduced by dropping `before` whole
      // (#2704). The floor keeps a short page's other strings from being clipped,
      // and the sum covers both text fields because the budget is shared.
      const archiveOptions: AuditMetadataOptions = {
        archiveText: {
          maxStringLength: Math.max(
            PAGE_CONTENT_LIMITS.contentHtmlMax +
              PAGE_CONTENT_LIMITS.headerTextMax,
            removed.contentHtml.length + removed.headerText.length,
          ),
        },
      };

      const before = {
        id: removed.id,
        slug: removed.slug,
        path: removed.path,
        caption: removed.caption,
        menuTitle: removed.menuTitle,
        title: removed.title,
        headerText: removed.headerText,
        sortOrder: removed.sortOrder,
        contentHtml: removed.contentHtml,
        published: removed.published,
        updatedByMemberId: removed.updatedByMemberId,
        createdAt: removed.createdAt.toISOString(),
        updatedAt: removed.updatedAt.toISOString(),
      };
      const metadata = {
        before,
        referencedBySlugs,
        referencedByFooterSections,
        wasBookNowTarget: repointed.count > 0,
        bookNowPairRepaired: repaired.count > 0,
        // So a reader of the row knows whether `before` is the page or a
        // redacted or reduced stand-in for it.
        snapshotComplete: false,
      };

      // What the row will actually hold, measured with the sanitiser the write
      // below runs, so the officer is told while they may still have the text
      // open elsewhere. Measured with `snapshotComplete: false`, the longer of
      // the two values, so the real write is never larger than what was checked.
      // Two caveats this reports rather than prevents: `password: value`-shaped
      // text loses that value, and one secret-shaped match (a
      // `/membership-cancellation/<token>` link, a provider key, a JWT) replaces
      // the whole field with `[REDACTED]` (first review, finding 4).
      metadata.snapshotComplete = isArchivedSnapshotComplete(
        buildStoredMetadata({
          action: PAGE_CONTENT_DELETED_ACTION,
          metadata,
          options: archiveOptions,
        }),
        before,
      );

      await tx.auditLog.create(
        buildStructuredAuditLogCreateArgs(
          {
            action: PAGE_CONTENT_DELETED_ACTION,
            actor: { memberId: guard.session.user.id },
            entity: { type: "PageContent", id: removed.id },
            category: "admin",
            severity: "important",
            outcome: "success",
            summary: `Page deleted for ${removed.slug}`,
            // No `retentionClass` here on purpose: `classifyAuditRetention()`
            // maps an "admin" + "important" + non-access action to `critical`,
            // which is the seven-year class this snapshot needs. Hand-setting it
            // would be exactly the drift that classifier exists to prevent.
            metadata,
            request: getAuditRequestContext(request),
          },
          archiveOptions,
        ),
      );

      return {
        removed,
        wasBookNowTarget: metadata.wasBookNowTarget,
        bookNowPairRepaired: metadata.bookNowPairRepaired,
        snapshotComplete: metadata.snapshotComplete,
      };
    });
  } catch (err) {
    // The loser of two simultaneous deletes (#3852): the whole transaction rolled
    // back, so nothing moved and no audit row was written, and the honest answer
    // is the 404 the existence check would have given.
    if (err instanceof PageAlreadyDeletedError) {
      return NextResponse.json({ error: PAGE_NOT_FOUND }, { status: 404 });
    }
    throw err;
  }

  // AFTER the transaction, on the success path only. Ordering is load-bearing in
  // one direction: invalidating before a rollback costs a needless cold render,
  // but deleting and then failing before this call leaves the deleted page served
  // from the store — and `revalidate = 300` is no bound on that, because a stale
  // entry is handed to the requester before regeneration starts. Only the tag
  // expiry this produces forces the blocking regeneration.
  //
  // Guarded, unlike the sibling methods (first review, finding 5). By this line
  // the row is gone and the audit entry is written, so letting a cache-clear
  // failure escape would answer 500 for a delete that SUCCEEDED: the panel keeps
  // the row on screen, the officer retries, and the retry answers
  // `404 "Page not found"` — two failures for one completed delete, on the one
  // method that cannot be repeated. So the response tells the truth instead: the
  // delete happened and the flush did not. That is not "up to 300 seconds" (see
  // above): the stored copy keeps answering until something clears it, and every
  // page save, hide or publish on this route calls the same invalidator, so that
  // is the remedy the panel names (#3852). The failure is logged distinctly
  // because nothing else in the request records it — the audit row cannot, it is
  // already committed.
  let publicCacheCleared = true;
  try {
    revalidatePublicPageContent();
  } catch (err) {
    publicCacheCleared = false;
    logger.error(
      { err, pageId: existing.id, slug: existing.slug, path: existing.path },
      "Page deleted but the public site cache could not be cleared",
    );
  }

  // The reference lists come from the pre-transaction read, so a concurrent edit
  // can leave them one edit stale; they are a best-effort warning either way. The
  // page itself is described from the row the delete removed.
  return NextResponse.json({
    ok: true,
    page: {
      id: outcome.removed.id,
      slug: outcome.removed.slug,
      path: outcome.removed.path,
      title: outcome.removed.title,
      published: outcome.removed.published,
    },
    referencedBySlugs,
    referencedByFooterSections,
    wasBookNowTarget: outcome.wasBookNowTarget,
    bookNowPairRepaired: outcome.bookNowPairRepaired,
    snapshotComplete: outcome.snapshotComplete,
    publicCacheCleared,
  });
}
