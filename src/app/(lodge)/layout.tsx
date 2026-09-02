import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AppProviders } from "@/components/app-providers";
import { LodgePinSessionProvider } from "@/components/lodge-pin-session";
import { auth } from "@/lib/auth";
import { getCachedClubIdentity } from "@/lib/public-layout-config";
import { clubThemeFontVariableClassName } from "@/lib/club-theme-fonts";
import { getWebsiteThemeRenderState } from "@/lib/club-theme";
import { CSP_NONCE_HEADER } from "@/lib/csp";
import { getDefaultLodgeCapacity } from "@/lib/lodge-capacity";
import { hasAnyActiveLodgePinSession } from "@/lib/lodge-pin-session";
import { prisma } from "@/lib/prisma";
import { REQUEST_PATH_HEADER } from "@/lib/internal-return-path";
import {
  buildTwoFactorGatePath,
  isTwoFactorSessionBlocked,
} from "@/lib/two-factor-gate";

export default async function LodgeLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  const requestHeaders = await headers();

  if (!session?.user) {
    redirect(`/login?callbackUrl=${encodeURIComponent("/lodge/kiosk")}`);
  }

  const member = await prisma.member.findUnique({
    where: { id: session.user.id },
    select: {
      active: true,
      forcePasswordChange: true,
      twoFactorEnabled: true,
    },
  });

  if (!member?.active) {
    redirect("/login");
  }

  if (member.forcePasswordChange) {
    redirect("/change-password");
  }

  const requestedPath =
    requestHeaders.get(REQUEST_PATH_HEADER) ?? "/lodge/kiosk";
  if (
    isTwoFactorSessionBlocked({
      sessionUser: session.user,
      member,
    })
  ) {
    redirect(
      buildTwoFactorGatePath({
        sessionUser: session.user,
        member,
        callbackPath: requestedPath,
      }),
    );
  }

  /*
    #3228 — the PIN-session renewal is mounted HERE, not on the kiosk page, and
    this layout is the reason it works.

    A hut leader's authority spans two pages: the kiosk, where the PIN is typed,
    and the chore-roster wizard the kiosk links to with a plain `<a href>` — a
    full navigation that unmounts the kiosk. This layout wraps both, so one set
    of listeners covers both and no page can be left out of the rule. The read
    below is what arms it across that navigation: the wizard renders with renewal
    already live, from the server's own look at the cookie, rather than waiting to
    be told by a client fetch it never makes.

    `hasAnyActiveLodgePinSession` is the same reader `lodge/roster/layout.tsx`
    already uses as its gate; this is not a second definition of "is there a PIN
    session", only a second question asked of it.
  */
  const [lodgeCapacity, theme, clubIdentity, pinSessionActive] =
    await Promise.all([
      getDefaultLodgeCapacity(),
      getWebsiteThemeRenderState(),
      getCachedClubIdentity(),
      hasAnyActiveLodgePinSession(session?.user?.id ?? null),
    ]);
  const liveClubIdentity = { ...clubIdentity, lodgeCapacity };
  const nonce = requestHeaders.get(CSP_NONCE_HEADER) ?? undefined;

  return (
    <AppProviders clubIdentity={liveClubIdentity} nonce={nonce}>
      <div
        className={`${clubThemeFontVariableClassName} app-theme-scope min-h-screen bg-background text-foreground`}
      >
        <style
          dangerouslySetInnerHTML={{ __html: theme.appCss }}
          data-site-style="club-theme"
        />
        <LodgePinSessionProvider initialActive={pinSessionActive}>
          {children}
        </LodgePinSessionProvider>
      </div>
    </AppProviders>
  );
}
