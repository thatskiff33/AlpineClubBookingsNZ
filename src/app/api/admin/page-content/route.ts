import { NextRequest, NextResponse } from "next/server";
import { Prisma, type PageContent } from "@prisma/client";
import { z } from "zod";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
  sanitizeAuditMetadata,
  type AuditMetadataOptions,
} from "@/lib/audit";
import {
  canDeletePage,
  canUnpublishPage,
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

  const safeContentHtml = sanitizePageContentHtml(parsed.data.contentHtml);
  const safeHeaderText = sanitizePageContentHtml(parsed.data.headerText);

  const existing = await prisma.pageContent.findUnique({
    where: {
      id: parsed.data.id,
    },
  });

  if (!existing) {
    return NextResponse.json({ error: "Page not found" }, { status: 404 });
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
    return NextResponse.json({ error: "Page not found" }, { status: 404 });
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
 * Raised by the DELETE below when the row is already gone at the moment the
 * transaction tries to remove it (second review, finding S3).
 *
 * The existence check runs before the transaction, so two officers deleting the
 * same page both pass it and the loser's `delete` raises Prisma's P2025. Left
 * uncaught that is a bare 500 for a page that IS gone, which is the one answer
 * the officer cannot act on. Thrown as a distinct type rather than caught in
 * place so the whole transaction still rolls back — the repoint above the delete
 * must not survive a delete that did not happen — and mapped to the same
 * `404 "Page not found"` the pre-transaction check would have given, which is
 * what the doctrine's loser gets everywhere else in this repo.
 */
class PageAlreadyDeletedError extends Error {
  constructor() {
    super("Page already deleted");
    this.name = "PageAlreadyDeletedError";
  }
}

/**
 * Did the archived snapshot keep the page's own text, byte for byte?
 *
 * The hard-delete decision (D-B1(a)) rests on the audit `before` row being a
 * complete copy, and two things in the sanitiser can gut it while the delete
 * still succeeds (second review): `SECRET_VALUE_PATTERN` replaces a whole field
 * with `[REDACTED]` on one match, and a payload past the whole-metadata JSON
 * budget collapses to a `{_truncated, preview}` stub with no `before` at all.
 * Both are the privacy and size protections working as designed — but the
 * officer is told "deleted" either way, so the response says which it was
 * instead of leaving them to discover it when they need the content back.
 *
 * Compared against the row the DELETE returned, not the pre-read, for the same
 * reason the snapshot is built from it.
 */
function isSnapshotComplete(
  sanitized: unknown,
  row: { contentHtml: string; headerText: string },
): boolean {
  if (typeof sanitized !== "object" || sanitized === null) {
    return false;
  }
  const before = (sanitized as { before?: unknown }).before;
  if (typeof before !== "object" || before === null) {
    return false;
  }
  const kept = before as { contentHtml?: unknown; headerText?: unknown };
  return (
    kept.contentHtml === row.contentHtml && kept.headerText === row.headerText
  );
}

/**
 * Deletes an admin-created content page for good (#2352 MC-03D, Option B).
 *
 * **Why this method exists at all.** Every other way public page content can
 * change already clears the stored public site; deletion was the one supported
 * lifecycle step with no writer, so the measurement gate could not prove
 * deletion invalidation the way it proves the other 39 writers'. This is that
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
 * the recovery route, which is why the snapshot below is the whole row, is built
 * from the row the DELETE itself removed, is archived at the ACTUAL stored length
 * of the two text fields rather than the audit log's default 1,000-character
 * string clip, and — because two protections can still gut it — reports
 * `snapshotComplete` to the officer when it did not survive whole.
 *
 * **Route shape (D-B7(a)).** `DELETE` on the collection with the id in the body,
 * not a new `[id]/route.ts`. Both mutating methods here already address a page
 * that way; it keeps this route's deliberate 401-shaped forbidden response, which
 * the admin panel already handles; and the preserved MC-03D measurement harness
 * watches THIS file for a DELETE export, so a sibling file would be invisible to
 * it. The REST-shaped alternative reads better and is a legitimate preference —
 * it would just require widening that scan in the same change.
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
 * below sets the target back to the booking flow itself, TWICE over — once before
 * the delete for the row that points here, and once after it for the pair the
 * FK's own `SetNull` can leave behind while nothing was locked (second review,
 * finding S1) — so the row it leaves behind is always one its own writer would
 * accept. Doing that SILENTLY is the surprise an audit row cannot prevent, which
 * is what the two flags in the response are for.
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
    return NextResponse.json({ error: "Page not found" }, { status: 404 });
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

  // Was the public header's Book Now button pointing here? Answered by the same
  // statement that moves it, inside the transaction below, rather than by a read
  // taken out here and hoped to still be true when the delete lands.
  let wasBookNowTarget = false;
  // Did the FK's own cascade leave a `PAGE` + null pair behind for the repair
  // below to clean up (second review, finding S1)? Distinct from the flag above
  // on purpose: that one answers "was the button pointing at THIS page", which
  // is the question the confirmation asked, and this one answers "did the stored
  // pair have to be corrected after the fact", which the pre-delete count cannot
  // see and which the audit row must not omit.
  let bookNowPairRepaired = false;
  // Did the archived `before` row survive the sanitiser whole (second review)?
  let snapshotComplete = true;
  const referencedBySlugs = referencingPages.map((page) => page.slug);
  const referencedByFooterSections = referencingFooterSections.map(
    (section) => section.key,
  );

  // Delete the row and record what was removed atomically, so a page can never
  // vanish without the audit entry that is its only recovery route.
  try {
    await prisma.$transaction(async (tx) => {
      // Repoint the Book Now button BEFORE the delete, in the same transaction
      // (first review, finding 1). `onDelete: SetNull` would clear the id and leave
      // the target reading "PAGE", and that pair is one the settings panel's own PUT
      // refuses to save — wedging every unrelated control in that panel (fee and
      // policy visibility, the committee photo, `showBookNow`) until the officer
      // noticed the empty selector and moved the radio by hand. Writing it here
      // means the only states this route can leave behind are states that panel
      // accepts.
      //
      // ONE scoped statement, and the same statement answers whether the button
      // pointed here: `updateMany` touches only a row that still points at this
      // page with the target still on `PAGE`, so `count` is the fact at delete
      // time rather than a read taken earlier. Under READ COMMITTED it blocks on a
      // concurrent settings write and then re-evaluates its predicate against the
      // committed row (`docs/CONCURRENCY_AND_LOCKING.md`), which closes one
      // direction outright: an officer who repoints at ANOTHER page keeps their
      // choice, because the where-clause no longer matches their row and the FK
      // then has nothing to null. Gated on the target as well as the id for the
      // same reason the warning is: the settings PUT never persists a stray page
      // id while the target is the booking flow, and a legacy row that did is
      // already sending visitors to the booking flow and will keep doing so.
      //
      // It does NOT close the other direction on its own, and the previous round
      // claimed it did (second review, finding S1). When the settings row points
      // somewhere else this statement matches ZERO rows, and a statement that
      // matches nothing takes no lock at all — so a `public-content-settings` PUT
      // can still commit `PAGE` + this page id in the window before the delete
      // begins. That is what the repair after the delete is for. This statement is
      // a probe (count 0 → proceed), not the guarded transition the doctrine uses
      // as an authority (count 0 → refuse), and one probe is not a closure.
      //
      // Recorded, not silent: `wasBookNowTarget` goes into the audit metadata
      // below and into the response, which is what the confirmation warned about
      // and what the post-delete message repeats. No second
      // PUBLIC_CONTENT_SETTINGS_UPDATED row is written for it on purpose — the
      // deletion entry is the one that explains WHY the target moved, and the page
      // id it moved off is the entity that entry is already about.
      const repointed = await tx.publicContentSettings.updateMany({
        where: { bookNowPageId: existing.id, bookNowTarget: "PAGE" },
        data: {
          bookNowTarget: "BOOKING_FLOW",
          bookNowPageId: null,
          updatedByMemberId: guard.session.user.id,
        },
      });
      wasBookNowTarget = repointed.count > 0;

      // The row that was actually destroyed, not the one read before the
      // transaction opened (second review, BLOCKER B1). Nothing locks the page
      // row between that read and this statement, so a concurrent PUT on this
      // same route can commit a new body in the window; under READ COMMITTED the
      // DELETE takes a fresh snapshot and follows the update chain, which means
      // `removed` IS the row this statement destroyed while the earlier read is
      // whatever the page said beforehand. Archiving the earlier read would lose
      // the newer body permanently and silently, under an `updatedAt` asserting
      // otherwise — and that snapshot is the whole basis of the hard-delete
      // decision. `existing` is a full `findUnique` with no `select`, so the two
      // shapes match; it is kept for the guards and the advisory report above.
      let removed: PageContent;
      try {
        removed = await tx.pageContent.delete({ where: { id: existing.id } });
      } catch (err) {
        // The loser of two concurrent deletes (finding S3). `deleteMany` would
        // also survive the race, but it returns a count rather than the row, and
        // B1 above needs the row — so the guard is a mapped P2025 instead, which
        // keeps both properties in one statement.
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === "P2025"
        ) {
          throw new PageAlreadyDeletedError();
        }
        throw err;
      }

      // The other half of finding S1, and it needs no lock to be correct. By this
      // line the row is gone and the FK's `SetNull` has already fired, so if a
      // concurrent settings PUT won the window above, the stored pair is now
      // `PAGE` + null — the exact wedge the pre-delete repoint exists to prevent,
      // arrived at by the cascade instead. No writer can point at this page any
      // more (the FK rejects a parent that is gone), so this cannot clobber an
      // officer's choice of a DIFFERENT page: it is scoped to the null id, which
      // only the cascade can produce. Idempotent — it matches nothing on the
      // ordinary path, including when the repoint above already moved the row.
      const repaired = await tx.publicContentSettings.updateMany({
        where: { bookNowTarget: "PAGE", bookNowPageId: null },
        data: {
          bookNowTarget: "BOOKING_FLOW",
          updatedByMemberId: guard.session.user.id,
        },
      });
      bookNowPairRepaired = repaired.count > 0;

      // Archive mode, following the email-template reset
      // (`email-templates/reset/route.ts`). Without it the audit log's default
      // clips every string at 1,000 characters, so the "complete before row" this
      // decision rests on would in practice be the first paragraph of the page.
      //
      // Sized from the ACTUAL stored lengths, floored at this route's own input
      // caps (second review). The caps alone were the wrong bound in one
      // direction and the right one in the other, so both arms are needed:
      //
      //  - the caps bound the INPUT, not the stored value. `PUT` parses with zod
      //    and THEN entity-escapes through `sanitizePageContentHtml`
      //    (`&` → `&amp;`), and the column is unbounded, so an `&`-dense body
      //    accepted at the cap is stored up to ~5x longer. Measured: a 44,000-
      //    character `&` body — 22% of the cap, not the "within ~10%" this
      //    comment used to claim — already passes the 220,000 string limit the
      //    caps produce, and two inputs both legal here serialise past the JSON
      //    budget, which loses the WHOLE snapshot to the `{_truncated, preview}`
      //    stub rather than clipping it visibly. Sizing from the row makes the
      //    budget follow the data instead of a bound the data can exceed.
      //  - the floor is what keeps the SHORT-page case correct. `maxStringLength`
      //    clips every string in the payload, not just the two long ones, so a
      //    tiny page must not shrink the limit below the length of its own
      //    `createdAt` or `updatedByMemberId`.
      //
      // The bound is the SUM of the two archived text fields rather than the
      // body's alone, and that is not padding: `archiveText` sets the
      // whole-metadata JSON budget to `24,000 + maxStringLength * 2`, so a page
      // holding both fields at once, each of which can double under JSON
      // escaping, would overflow a budget sized for the body alone.
      //
      // TWO honest caveats survive, and the response now reports when either one
      // has fired rather than leaving the officer to discover it:
      //
      //  1. key-value redaction still fires on body text shaped like
      //     `password: value`, and it takes the whole matched value, not a
      //     fragment — the same caveat the email-template route documents.
      //  2. `SECRET_VALUE_PATTERN` replaces the ENTIRE field with `[REDACTED]`
      //     on a single match, not just the match. One
      //     `/membership-cancellation/<token>` URL, Stripe key or JWT pasted into
      //     a help page therefore costs the whole body snapshot, not a line of it
      //     (first review, finding 4).
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

      // Sanitised once here to find out what the row will actually hold, then
      // again by the audit boundary that writes it. The duplicate pass is the
      // price of being able to tell the officer the snapshot is incomplete while
      // they can still do something about it; it runs once per delete, on an
      // admin action, over a payload the same call is about to serialise anyway.
      snapshotComplete = isSnapshotComplete(
        sanitizeAuditMetadata(
          { before, referencedBySlugs, referencedByFooterSections },
          archiveOptions,
        ),
        removed,
      );

      await tx.auditLog.create(
        buildStructuredAuditLogCreateArgs(
          {
            action: "PAGE_CONTENT_DELETED",
            actor: { memberId: guard.session.user.id },
            entity: { type: "PageContent", id: existing.id },
            category: "admin",
            severity: "important",
            outcome: "success",
            summary: `Page deleted for ${removed.slug}`,
            // No `retentionClass` here on purpose: `classifyAuditRetention()`
            // maps an "admin" + "important" + non-access action to `critical`,
            // which is the seven-year class this snapshot needs. Hand-setting it
            // would be exactly the drift that classifier exists to prevent.
            metadata: {
              before,
              referencedBySlugs,
              referencedByFooterSections,
              wasBookNowTarget,
              bookNowPairRepaired,
              // So a reader of the row knows whether the body above is the page
              // or a redacted stand-in for it, without having to guess.
              snapshotComplete,
            },
            request: getAuditRequestContext(request),
          },
          archiveOptions,
        ),
      );
    });
  } catch (err) {
    // The concurrent loser (finding S3): the row went between the guard above and
    // the transaction, so the whole transaction rolled back — nothing repointed,
    // no audit row — and the honest answer is the same 404 the guard would have
    // given. Every other failure still escapes to the platform handler.
    if (err instanceof PageAlreadyDeletedError) {
      return NextResponse.json({ error: "Page not found" }, { status: 404 });
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
  // delete happened and the flush did not.
  //
  // What that costs is NOT "up to 300 seconds", and saying so contradicted the
  // paragraph directly above it (second review). `revalidate = 300` makes an entry
  // eligible for background regeneration; the stale entry is still handed to the
  // requester that triggers it, and a prefetch skips revalidation altogether, so
  // in wall-clock terms the staleness has no bound the officer can wait out. The
  // remedy is another write, not time: every other content save in the admin area
  // calls this same invalidator, so saving any page or footer section flushes the
  // deleted address too. The failure is logged distinctly because nothing else in
  // the request records it — the audit row cannot, it is already committed.
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

  // `page` and the two reference lists come from the PRE-transaction read, so
  // they are advisory rather than fresh: a concurrent edit committed in that
  // window can leave `published` — and the link scan behind
  // `referencedBySlugs` / `referencedByFooterSections` — one edit stale. They are
  // reported anyway because their job is to describe what the club just lost in
  // the officer's own terms, and a slightly stale warning is more use than
  // silence. The audit `before` row is the one that had to be exact, and it is
  // taken from the delete's own return value instead.
  return NextResponse.json({
    ok: true,
    page: {
      id: existing.id,
      slug: existing.slug,
      path: existing.path,
      title: existing.title,
      published: existing.published,
    },
    referencedBySlugs,
    referencedByFooterSections,
    wasBookNowTarget,
    bookNowPairRepaired,
    snapshotComplete,
    publicCacheCleared,
  });
}
