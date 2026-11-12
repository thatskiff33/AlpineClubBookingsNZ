import Link from "next/link";
import { headers } from "next/headers";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PartnerInviteClaimCard } from "@/components/partner-invite-claim-card";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getPartnerInviteTokenForClaim } from "@/lib/partner-invite-token";
import { normalizeInvitedEmail } from "@/lib/partner-invite-token-policy";
import { getCachedClubIdentity } from "@/lib/public-layout-config";
import {
  buildFamilyInviteLoginPath,
  FAMILY_INVITE_RETURN_NONCE_HEADER,
} from "@/lib/family-invite-return-address";
import { SignOutAndReturnButton } from "./sign-out-and-return-button";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Family group invitation",
};

export const dynamic = "force-dynamic";

/**
 * The signed-out branch's sign-in affordance is a plain, tokenless `/login`
 * anchor (#2827) carrying a tokenless tab-binding nonce (#2974).
 *
 * It used to be `buildLoginPath('/family-invite/<token>')`, which put the invite
 * token into an `href` — and from there into the visitor's address bar, their
 * history and any `Referer` the next hop saw. Do not reintroduce a callbackUrl
 * here, in any attribute, hidden input or form action.
 *
 * **What IS in the anchor, since #2974, is `?inviteReturn=<nonce>`** — 128 random
 * bits minted by `src/proxy.ts` on this very response and handed to this render in
 * {@link FAMILY_INVITE_RETURN_NONCE_HEADER}. It is not derived from the token and
 * it is worth nothing on its own: it only unlocks a landing for a browser that
 * already holds the matching `HttpOnly` cookie. Its job is to make the return
 * address belong to THIS TAB, so the next person to sign in on a shared kiosk
 * browser is not landed on somebody else's invitation. Absent header (an old
 * browser, a soft navigation, a signed-in visitor) simply yields a plain `/login`
 * and the ordinary post-login landing.
 *
 * **What that link did NOT expose, corrected 20 Aug 2026.** The first cut of this
 * fix recorded that this page injects admin-authored Raw CSS and that
 * `a[href^="/family-invite/9f"]` therefore read the token out a character at a
 * time. That is false: `(public)/layout.tsx` injects `theme.appCss`, which
 * `buildClubThemeAppCss()` builds **without** `rawCss`, so no admin CSS selector
 * ever ran on this page. The oracle is real on `(website-dynamic)`, which is where
 * #2827's other two fixes live. Keeping the token out of this link is still right —
 * the URL exposure was real, and a future move of this group under the shared
 * chrome would make the CSS oracle real too — but it is defence in depth here, not
 * a closed breach. Full account in `src/lib/family-invite-return-address.ts`.
 *
 * The post-login return address is carried server-side instead, in the HttpOnly
 * cookie that module documents: `src/proxy.ts` writes it on a signed-out
 * navigation to this page and retires it on the signed-in GET, and all four
 * post-login landing sites honour it for the tab that presents the nonce.
 *
 * **Nothing on this page needs JavaScript to arm the return address** — the
 * affordance is an ordinary server-rendered anchor, and both halves of the
 * binding (the cookie and the nonce in that anchor) ride on the HTTP response
 * that rendered it. That is the property a Server Action carrier would have cost,
 * and it is why one was rejected in #2827. It is a claim about *this page*, not
 * about the whole sign-in: `LoginForm` submits through `signIn()` and so needs
 * scripting, exactly as it did before either issue.
 *
 * The wrong-account branch is NOT a `/login` link: see
 * {@link SignOutAndReturnButton}, because `/login` redirects a signed-in visitor
 * straight back here.
 *
 * An absent or expired cookie, or a sign-in started in another tab, degrades to
 * the member's ordinary post-login landing, never to an error; the emailed invite
 * link still works.
 */
async function resolveLoginPath(): Promise<string> {
  const requestHeaders = await headers();

  return buildFamilyInviteLoginPath(
    requestHeaders.get(FAMILY_INVITE_RETURN_NONCE_HEADER),
  );
}

function Shell({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-10">
      <Card>
        <CardHeader>
          <CardTitle headingLevel={1}>{title}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm text-muted-foreground">
          {children}
        </CardContent>
      </Card>
    </div>
  );
}

export default async function PartnerInvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const [session, view, { name: clubName }] = await Promise.all([
    auth(),
    getPartnerInviteTokenForClaim(token),
    getCachedClubIdentity(),
  ]);

  if (view.status === "invalid") {
    return (
      <Shell title="Invitation link not found">
        <p>This invitation link is invalid or is no longer available.</p>
        <p>
          If you reached this page from an older email, ask the person who
          invited you to send a fresh invitation.
        </p>
      </Shell>
    );
  }

  if (view.status === "expired") {
    return (
      <Shell title="Invitation expired">
        <p>This invitation link has expired.</p>
        <p>
          Ask the person who invited you to send a fresh invitation from their
          family group.
        </p>
      </Shell>
    );
  }

  if (view.status === "claimed") {
    return (
      <Shell title="Invitation already used">
        <p>This invitation has already been accepted.</p>
        <p>
          If you have a {clubName} account, your family group is available from
          your profile page.
        </p>
      </Shell>
    );
  }

  if (view.status === "group_unavailable") {
    return (
      <Shell title="Family group not ready yet">
        <p>
          The family group for this invitation is not available yet. It still
          needs to be approved by an administrator, or it is no longer active.
        </p>
        <p>Check back later, or contact the person who invited you.</p>
      </Shell>
    );
  }

  const groupName = view.groupName ?? "a family group";

  // Not signed in: route the recipient through the normal membership process (do
  // not fork a second registration path). Signing in brings them back here — the
  // return address travels in the #2827 HttpOnly cookie, not in the link, and the
  // link carries only the #2974 tab-binding nonce, so see resolveLoginPath above
  // before adding a callbackUrl to either button.
  if (!session?.user?.id) {
    const loginPath = await resolveLoginPath();

    return (
      <Shell title="Family group invitation">
        <p>
          You have been invited to join the family group{" "}
          <strong>{groupName}</strong> at {clubName}.
        </p>
        <p>
          To accept, you first need a {clubName} membership account. Apply for
          membership using the invited email address
          {" "}
          <strong>{view.invitedEmail}</strong>. Once your login is active,
          return to this link to join the group.
        </p>
        <div className="flex flex-wrap gap-3 pt-2">
          <Button asChild>
            <Link href="/join/apply">Apply for membership</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href={loginPath}>I already have an account</Link>
          </Button>
        </div>
      </Shell>
    );
  }

  const member = await prisma.member.findUnique({
    where: { id: session.user.id },
    select: { email: true },
  });

  // Signed in with a different email than the invite was sent to: a forwarded
  // link cannot be used to join a stranger's group.
  if (!member || normalizeInvitedEmail(member.email) !== view.invitedEmail) {
    return (
      <Shell title="Family group invitation">
        <p>
          This invitation was sent to <strong>{view.invitedEmail}</strong>.
        </p>
        <p>
          You are signed in as a different member. Sign out and sign back in with
          that account to accept the invitation to join{" "}
          <strong>{groupName}</strong>.
        </p>
        <div className="pt-2">
          {/*
            NOT a `/login` link: this branch is reached BY a signed-in visitor, and
            /login redirects an authenticated visitor straight back here, so the old
            link bounced to the identical screen (review finding, 20 Aug 2026 — the
            pre-#2827 `buildLoginPath(...)` link bounced the same way). Signing out
            and returning here lands a SIGNED-OUT navigation on this address, which
            is where `syncFamilyInviteReturnAddress()` writes the return address, so
            the next sign-in comes back. See the component's docblock.
          */}
          <SignOutAndReturnButton
            returnPath={`/family-invite/${encodeURIComponent(token)}`}
          >
            Sign out and use a different account
          </SignOutAndReturnButton>
        </div>
      </Shell>
    );
  }

  return (
    <Shell title="Join family group">
      <p>
        You have been invited to join the family group{" "}
        <strong>{groupName}</strong>.
      </p>
      <p>
        Accepting adds you to the group so you can be included when the group
        makes bookings.
      </p>
      {view.createPartnerLink && (
        <p>
          Accepting will <strong>also record you as{" "}
          {view.inviterName ? `${view.inviterName}'s` : "your inviter's"}{" "}
          partner</strong> (husband, wife, or partner) with the club. If that is
          not right, don&apos;t accept — contact the club instead. You can remove
          a recorded partner relationship from your profile at any time.
        </p>
      )}
      <PartnerInviteClaimCard token={token} groupName={groupName} />
    </Shell>
  );
}
