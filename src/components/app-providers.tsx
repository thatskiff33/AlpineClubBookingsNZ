import type { ReactNode } from "react";
import { AppProvidersClient } from "@/components/app-providers-client";
import type { ClubIdentity } from "@/config/club-identity-types";
import { getClubFormat } from "@/lib/club-format-settings";
import { clubTimeZone } from "@/lib/club-time/server";

/**
 * The application shell every authenticated, admin, finance, lodge and member
 * route group composes — now a SERVER component, so the club's timezone can be
 * read where it lives (CT-4, #2870; epic #2988).
 *
 * ## What changed and why
 *
 * This file used to be the `"use client"` provider stack itself. The stack has
 * moved, byte for byte, to `app-providers-client.tsx`; what is left is the one
 * thing a client module cannot do, which is `await` the persisted club timezone.
 * `INV-CONFIG-002` says the club's civil-time authority is
 * `ClubTimeSettings.timeZone` and never the machine rendering the page, so the
 * value has to be resolved on the server and handed to the browser as data.
 *
 * NO LAYOUT CHANGED. All five route groups already render
 * `<AppProviders clubIdentity={...} nonce={...}>` from an async server layout,
 * and a server component composing client components is the ordinary direction —
 * so the boundary moved one file up and every caller stayed as it was.
 *
 * ## This is one of the epic's two client-boundary mount points
 *
 * Between this component and `website/website-chrome.tsx`, every route group in
 * the application is wrapped by a `ClubTimeProvider`. That is what lets
 * `useClubTime()` throw rather than fall back to a plausible wrong zone;
 * `club-time-provider.tsx` has the full reasoning, and
 * `club-time-provider-mount-census.test.tsx` is the guard that keeps the claim
 * true as route groups come and go.
 *
 * ## And, since #3564, the club's CURRENCY AND LOCALE come the same way
 *
 * Stage 2 of programme #3205 put `ClubFormatSettings` behind the same seam, for
 * the same reason and through the same two mount points: `NEXT_PUBLIC_CURRENCY`
 * and `NEXT_PUBLIC_LOCALE` are inlined at BUILD time into an image that serves
 * every club, so a browser that reads them sees `undefined` and falls back to
 * New Zealand. `club-format-provider.tsx` has the reasoning and
 * `club-format-provider-mount-census.test.tsx` is its guard.
 *
 * BOTH READS HAPPEN ONCE PER RENDER PASS, side by side. `clubTimeZone()` is
 * request-memoised with React `cache()`; `getClubFormat()` deliberately is not
 * — stage 1's reader records that the caching contract belongs to #3565, which
 * is where the hot per-format call sites arrive, and this component adds
 * exactly one primary-key read of a one-row table to a render that already
 * performs several. Choosing a cross-request cache here would mean inventing an
 * invalidation contract for the admin writer a stage early.
 */

interface AppProvidersProps {
  children: ReactNode;
  clubIdentity: ClubIdentity;
  nonce?: string;
}

export async function AppProviders({
  children,
  clubIdentity,
  nonce,
}: AppProvidersProps) {
  const [zone, format] = await Promise.all([clubTimeZone(), getClubFormat()]);
  return (
    <AppProvidersClient
      clubIdentity={clubIdentity}
      clubTimeZone={zone}
      clubCurrencyCode={format.currencyCode}
      clubLocale={format.locale}
      nonce={nonce}
    >
      {children}
    </AppProvidersClient>
  );
}
