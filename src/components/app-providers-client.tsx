"use client";

import { SessionProvider } from "next-auth/react";
import type { ReactNode } from "react";
import { AppThemeProvider } from "@/components/app-theme-provider";
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
 */

interface AppProvidersClientProps {
  children: ReactNode;
  clubIdentity: ClubIdentity;
  /** The club's PERSISTED timezone, resolved on the server. Never the viewer's. */
  clubTimeZone: string;
  nonce?: string;
}

export function AppProvidersClient({
  children,
  clubIdentity,
  clubTimeZone,
  nonce,
}: AppProvidersClientProps) {
  return (
    <CspNonceProvider nonce={nonce}>
      <AppThemeProvider nonce={nonce}>
        <ClubIdentityProvider value={clubIdentity}>
          <ClubTimeProvider zone={clubTimeZone}>
            <SessionProvider>{children}</SessionProvider>
            <Toaster richColors position="top-right" />
          </ClubTimeProvider>
        </ClubIdentityProvider>
      </AppThemeProvider>
    </CspNonceProvider>
  );
}
