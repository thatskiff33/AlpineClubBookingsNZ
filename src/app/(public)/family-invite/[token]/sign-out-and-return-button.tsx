"use client";

import { useState } from "react";
import { signOutMember } from "@/lib/member-sign-out";
import { Button } from "@/components/ui/button";

/**
 * The wrong-account branch's affordance: sign the visitor OUT, and bring them
 * back to this invitation (#2827, review finding 20 Aug 2026).
 *
 * ## Why a plain `/login` link could not do this
 *
 * That branch is reached BY a signed-in visitor — the invite was sent to somebody
 * else's address — and `/login` redirects an already-authenticated visitor
 * straight back to their resolved landing (`(public)/login/page.tsx`). So the
 * previous control, a `<Link href="/login">`, bounced the visitor to the identical
 * wrong-account screen and there was no sign-out affordance anywhere on a
 * `(public)` page to reach instead: that group's layout renders `WebsiteHeader`,
 * not the member `NavBar`. The copy told them to "sign in with that account" and
 * the button could not get them there. The same bounce existed before this branch,
 * via `buildLoginPath('/family-invite/<token>')` — so it is not a regression, but
 * it is a control this PR rewrote, and leaving it inert would ship a promise the
 * code does not keep.
 *
 * ## What it does
 *
 * `signOutMember({ callbackUrl })` drops the session and navigates back to this invite
 * address, which is now a SIGNED-OUT top-level navigation — so
 * `syncFamilyInviteReturnAddress()` in `src/proxy.ts` writes the return address on
 * that response, and the page shows its signed-out branch with a working "I
 * already have an account". That is also why the proxy is free to RETIRE the
 * address for a signed-in visitor rather than write it: this control, not an
 * unconditional stamp, is what serves the wrong-account case.
 *
 * ## Why holding the token as a prop is not the exposure this PR closed
 *
 * The token reaches the browser in React's flight payload, inside a `<script>`.
 * The oracle class #2827 is about is a CSS attribute selector, which can read an
 * attribute value and cannot read script content — and this component renders the
 * token into no attribute at all, which
 * `__tests__/family-invite-login-link.test.tsx` asserts over every attribute in
 * the tree. It is the same seam `PartnerInviteClaimCard` on the accepting branch
 * already uses for the same reason.
 *
 * Signing out requires JavaScript here, exactly as it does everywhere else in this
 * application (`src/components/nav-bar.tsx` calls `signOutToLogin`, which calls the
 * same `signOutMember`), so nothing that worked without scripting stops working.
 * The signed-out branch's anchor — the one the no-JavaScript recipient of an
 * emailed invite actually uses — is untouched.
 */
export function SignOutAndReturnButton({
  returnPath,
  children,
}: {
  returnPath: string;
  children: React.ReactNode;
}) {
  const [signingOut, setSigningOut] = useState(false);

  return (
    <Button
      variant="outline"
      disabled={signingOut}
      onClick={() => {
        setSigningOut(true);
        void signOutMember({ callbackUrl: returnPath });
      }}
    >
      {children}
    </Button>
  );
}
