import { ClubTimeProvider } from "@/components/club-time-provider";
import { SkifieldWhakapapaWidget } from "@/components/website/skifield-whakapapa-widget";
import { clubTimeZone } from "@/lib/club-time/server";

/**
 * The ski-field conditions widget with the club's timezone in scope (CT-4,
 * #2870; epic #2988).
 *
 * ## Why this wrapper exists at all
 *
 * The widget shows the upstream report's "updated" stamp, which is a real
 * INSTANT and must therefore be rendered in the club's PERSISTED timezone
 * (`INV-CONFIG-002`) rather than the viewer's. It is `"use client"`, so it reads
 * that zone from `ClubTimeProvider` — and on every public-website page it
 * already has one, because `website-chrome.tsx` mounts it for both public route
 * groups.
 *
 * `/404` IS THE EXCEPTION, and it is the reason for this file. The root
 * `src/app/not-found.tsx` sits outside both website route groups — it renders
 * under `src/app/layout.tsx` alone — and it renders `EmbeddedPageContentParts`
 * over whatever an admin has published at that path. Put a
 * `{{skifield-whakapapa}}` token on the 404 page and the widget would render
 * with no provider above it, which is a thrown error on the one page whose job
 * is to fail gracefully.
 *
 * ## Why a wrapper rather than making the parts renderer async
 *
 * `EmbeddedPageContentParts` is a synchronous server component with two tests
 * that render it directly through Testing Library. Making it `async` to await
 * the zone would break both, and would pull a `server-only` module that reaches
 * Prisma onto their import graph for a value only one of its dozen branches
 * needs. A sync server component may render an async server child, so the await
 * belongs at the branch that needs it.
 *
 * Nesting this inside the chrome's provider on a normal website page is
 * harmless: the inner provider wins and carries the identical value.
 */
export async function SkifieldWhakapapaEmbed() {
  return (
    <ClubTimeProvider zone={await clubTimeZone()}>
      <SkifieldWhakapapaWidget />
    </ClubTimeProvider>
  );
}
