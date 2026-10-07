"use client";

import { SessionProvider } from "next-auth/react";
import type { ReactNode } from "react";
import { AppThemeProvider } from "@/components/app-theme-provider";
import { ClubFormatProvider } from "@/components/club-format-provider";
import { ClubIdentityProvider } from "@/components/club-identity-provider";
import { ClubTimeProvider } from "@/components/club-time-provider";
import { CspNonceProvider } from "@/components/security/csp-nonce-provider";
import { Toaster } from "@/components/ui/sonner";
import type { ClubIdentity } from "@/config/club-identity-types";

/**
 * The browser half of the application shell.
 *
 * SPLIT OUT OF `app-providers.tsx` BY CT-4 (#2870, epic #2988), and the split is
 * the whole point rather than tidying: the club's timezone is a `server-only`
 * database read (`INV-CONFIG-002`) and this file is `"use client"`, so the value
 * has to be resolved one level up and handed down. `app-providers.tsx` is now a
 * three-line async server component that does exactly that; everything visible
 * stayed here, in the same order, unchanged.
 *
 * WHY `ClubTimeProvider` SITS WHERE IT DOES. Inside `ClubIdentityProvider`,
 * outside `SessionProvider`, and wrapping the `Toaster` as well as the page: a
 * toast can carry a timestamp, and a component that renders in one place and
 * not the other is exactly the class of bug the context exists to remove.
 *
 * `ClubFormatProvider` (#3564) sits immediately outside it, on the same
 * argument and covering the same subtree: a toast can carry an amount too.
 * Currency and locale travel the same way the zone does and for the same
 * reason — `NEXT_PUBLIC_*` is inlined at build time into an image that serves
 * every club, so the values are resolved on the server one level up and handed
 * down as data. See `club-format-provider.tsx`.
 */

interface AppProvidersClientProps {
  children: ReactNode;
  clubIdentity: ClubIdentity;
  /** The club's PERSISTED timezone, resolved on the server. Never the viewer's. */
  clubTimeZone: string;
  /** The club's PERSISTED ISO 4217 currency code, resolved on the server. */
  clubCurrencyCode: string;
  /** The club's PERSISTED BCP 47 locale, resolved on the server. */
  clubLocale: string;
  nonce?: string;
}

export function AppProvidersClient({
  children,
  clubIdentity,
  clubTimeZone,
  clubCurrencyCode,
  clubLocale,
  nonce,
}: AppProvidersClientProps) {
  return (
    <CspNonceProvider nonce={nonce}>
      <AppThemeProvider nonce={nonce}>
        <ClubIdentityProvider value={clubIdentity}>
          <ClubFormatProvider
            currencyCode={clubCurrencyCode}
            locale={clubLocale}
          >
            <ClubTimeProvider zone={clubTimeZone} locale={clubLocale}>
              <SessionProvider>{children}</SessionProvider>
              <Toaster richColors position="top-right" />
            </ClubTimeProvider>
          </ClubFormatProvider>
        </ClubIdentityProvider>
      </AppThemeProvider>
    </CspNonceProvider>
  );
}
