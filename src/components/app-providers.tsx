import type { ReactNode } from "react";
import { AppProvidersClient } from "@/components/app-providers-client";
import type { ClubIdentity } from "@/config/club-identity-types";
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
  return (
    <AppProvidersClient
      clubIdentity={clubIdentity}
      clubTimeZone={await clubTimeZone()}
      nonce={nonce}
    >
      {children}
    </AppProvidersClient>
  );
}
