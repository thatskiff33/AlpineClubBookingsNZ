"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import Link from "next/link";
import { useClubIdentity } from "@/components/club-identity-provider";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader } from "@/components/ui/card";
import { WebsiteLogo } from "@/components/website-logo";
import { FieldHint, useFieldHint } from "@/components/ui/field-hint";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  appendFamilyInviteReturnParam,
  buildFamilyInviteLoginPath,
} from "@/lib/family-invite-return-address";
import { LOGIN_THROTTLED_CODE } from "@/lib/login-throttle-policy";
import { MagicLinkRequestForm } from "./magic-link-request-form";

// The login query params (verified / verifyError / emailChanged / callbackUrl)
// are read on the server and passed in as props. Reading them here via
// useSearchParams() forced this client subtree into a Suspense boundary, whose
// hard-load hydration is the suspected cause of the transient input duplication
// (#email briefly resolving to two nodes — the E2E flake tracked in #1207/#1140).
// Server-resolved props keep the render deterministic. redirectTo is the
// already-sanitised post-login destination (resolvePostLoginPath ran server-side).
// Friendly copy for OAuth (Google) refusals redirected here as ?error=… by the
// signIn callback (#2035). Unlisted values fall through to the generic branch.
function oauthErrorMessage(error: string): string {
  switch (error) {
    case "google_unlinked":
      return "That Google account isn't linked to a member here. Sign in with your password first, then connect Google from your profile.";
    case "google_password_change":
      return "Please sign in with your password — a password update is required before you can use Google sign-in.";
    case "google_disabled":
      return "Google sign-in is currently turned off. Please sign in with your password.";
    case "google_refused":
      return "We couldn't sign you in with Google. Please sign in with your password or contact the club.";
    default:
      return "Could not sign in with Google. Please try again or use your password.";
  }
}

export function LoginForm({
  verified,
  verifyError,
  emailChanged,
  redirectTo,
  explicitCallbackUrl,
  familyInviteReturnNonce,
  authBounceRef,
  magicLinkEnabled = false,
  googleLoginEnabled = false,
  oauthError,
}: {
  verified: boolean;
  verifyError?: string;
  emailChanged: boolean;
  redirectTo: string;
  // A genuinely user/deep-link-supplied callbackUrl (#2090). When set it wins
  // over the landing preference (D-D4); when absent the post-auth resolver
  // falls back to the member's preference / admin role default. Undefined is
  // NOT a flow-materialised default — the server only forwards a real one.
  explicitCallbackUrl?: string;
  // #2974: the tab-binding nonce from `/login?inviteReturn=…`, already
  // shape-checked server-side. It is tokenless — 128 random bits that mean
  // nothing without the HttpOnly family-invite cookie from this same browser —
  // and it exists so a sign-in started in THIS tab returns to the invitation
  // while one started anywhere else does not. Forwarded to the landing resolver,
  // the 2FA detour and Google's callbackUrl, which are the three seams this
  // component owns. Never the invite path: that is what put the token in a URL.
  familyInviteReturnNonce?: string;
  authBounceRef?: string;
  magicLinkEnabled?: boolean;
  googleLoginEnabled?: boolean;
  oauthError?: string;
}) {
  const club = useClubIdentity();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [emailNotVerified, setEmailNotVerified] = useState(false);
  const [resendLoading, setResendLoading] = useState(false);
  const [resendSuccess, setResendSuccess] = useState(false);
  // #2264 — the example address sits below the box, not greyed inside it where
  // it reads as an address already entered.
  const emailHint = useFieldHint();

  // Post-auth landing (#2090): the credential form resolves the destination
  // AFTER sign-in — once the session cookie exists — because it depends on the
  // member's landing preference and admin role default, neither known at render
  // time. An explicit deep-link callbackUrl (if any) is forwarded so it can win
  // per D-D4. Any failure falls back to the pre-auth-sanitised redirectTo.
  async function resolvePostAuthLanding(): Promise<string> {
    // A hung resolver must never strand the user on a spinner: abort after a
    // short timeout and fall back to the pre-auth-sanitised redirectTo (the same
    // fallback the catch below uses for any network failure).
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const params = new URLSearchParams();
      if (explicitCallbackUrl) {
        params.set("callbackUrl", explicitCallbackUrl);
      }
      appendFamilyInviteReturnParam(params, familyInviteReturnNonce);
      const query = params.toString();
      const response = await fetch(
        `/api/auth/post-login-landing${query ? `?${query}` : ""}`,
        { credentials: "same-origin", signal: controller.signal },
      );
      if (!response.ok) return redirectTo;
      const body = (await response.json()) as { path?: string };
      return typeof body.path === "string" && body.path ? body.path : redirectTo;
    } catch {
      return redirectTo;
    } finally {
      clearTimeout(timeout);
    }
  }

  // Build the 2FA detour URL (verify/enroll) when the challenge is still open,
  // else null. Determinism note (#2090): the detour's callbackUrl carries ONLY a
  // genuinely explicit deep link — never the resolved default landing. The
  // default (preference / admin role default) is re-resolved server-side at the
  // /login/enroll and /login/verify pages from the fully-authed session, so it
  // no longer depends on a post-signIn resolver fetch that could race or fail and
  // silently bake the wrong /dashboard default into the detour (the alice/bob
  // asymmetry). A flow-materialised default is thus never written here, so it can
  // never be re-read as an explicit choice (D-D4).
  async function resolveTwoFactorPath() {
    const response = await fetch("/api/auth/2fa/status", {
      credentials: "same-origin",
    });
    if (!response.ok) return null;
    const status = (await response.json()) as {
      required?: boolean;
      verified?: boolean;
      enrolled?: boolean;
      forcePasswordChange?: boolean;
    };

    if (status.forcePasswordChange) {
      return "/change-password";
    }

    if (!status.required || status.verified) {
      return null;
    }

    const params = new URLSearchParams();
    if (explicitCallbackUrl) {
      params.set("callbackUrl", explicitCallbackUrl);
    }
    // #2974: the detour re-resolves the landing server-side, so the tab-binding
    // nonce has to travel with it or a 2FA member from an invitation lands on
    // their dashboard instead of back on the invitation.
    appendFamilyInviteReturnParam(params, familyInviteReturnNonce);
    const query = params.toString();
    const suffix = query ? `?${query}` : "";
    return status.enrolled
      ? `/login/verify${suffix}`
      : `/login/enroll${suffix}`;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setEmailNotVerified(false);
    setResendSuccess(false);
    setLoading(true);

    try {
      const result = await signIn("credentials", {
        email,
        password,
        redirect: false,
        redirectTo,
      });

      if (result?.error) {
        // NextAuth v5 sets result.code from CredentialsSignin subclass code
        if (result.code === "EMAIL_NOT_VERIFIED" || result.error === "EMAIL_NOT_VERIFIED") {
          setEmailNotVerified(true);
        } else if (result.code === LOGIN_THROTTLED_CODE) {
          // #4609: the same words for every account, real or not.
          setError(
            "Too many sign-in attempts for this account. Please wait a few minutes and try again" +
              (magicLinkEnabled || googleLoginEnabled
                ? ", or use another way to sign in below."
                : "."),
          );
        } else {
          setError("Invalid email or password. Please try again.");
        }
        setLoading(false);
      } else {
        // Full document navigation, never router.push: the client router's
        // cache can hold the logged-out RSC entry for the destination (the
        // very bounce that brought us here), and replaying it returns the
        // user to /login with no error — the silent login loop (#1669).
        // A hard load always sends the fresh session cookie and starts the
        // authenticated app from a clean router state. `loading` stays true
        // so the button cannot be re-submitted while the page unloads.
        //
        // Check the 2FA gate FIRST (#2090). When a challenge is open we hand off
        // to /login/enroll or /login/verify, which re-resolve the default landing
        // server-side from the fully-authed session — so we skip the client
        // landing resolver on the detour path entirely, removing the race that
        // could bake a stale /dashboard default into the detour. Only when no
        // detour is needed do we resolve the landing here and navigate straight
        // to it.
        const twoFactorPath = await resolveTwoFactorPath();
        window.location.assign(
          twoFactorPath ?? (await resolvePostAuthLanding()),
        );
      }
    } catch {
      setError("Something went wrong. Please try again.");
      setLoading(false);
    }
  }

  async function handleResendVerification() {
    setResendLoading(true);
    setResendSuccess(false);
    try {
      const res = await fetch("/api/auth/resend-verification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (res.ok) {
        setResendSuccess(true);
      }
    } catch {
      // Silently fail
    } finally {
      setResendLoading(false);
    }
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader className="space-y-1 items-center">
        <h1 className="sr-only">Sign in</h1>
        <WebsiteLogo
          label={club.name}
          className="mb-2 max-h-14 max-w-52"
          textClassName="mb-2 text-center text-2xl text-foreground"
        />
        <CardDescription className="text-center">
          Sign in to your account to manage bookings
        </CardDescription>
      </CardHeader>

      <form onSubmit={handleSubmit}>
        <CardContent className="space-y-4">
          {verified && (
            <Alert variant="success">
              Your email has been verified. You can now sign in.
            </Alert>
          )}

          {emailChanged && (
            <Alert variant="success">
              Your email has been changed successfully.
            </Alert>
          )}

          {verifyError && (
            <Alert variant="error">
              {verifyError === "expired"
                ? "Your verification link has expired. Please request a new one."
                : verifyError === "invalid"
                ? "Invalid verification link."
                : "An error occurred during email verification."}
            </Alert>
          )}

          {oauthError && (
            <Alert variant="error">{oauthErrorMessage(oauthError)}</Alert>
          )}

          {error && (
            <Alert variant="error">{error}</Alert>
          )}

          {emailNotVerified && (
            <Alert variant="warning" title="Please verify your email">
              <p>
                Check your inbox for a verification email. Click the link to verify your account.
              </p>
              {resendSuccess ? (
                <p className="font-medium text-success">Verification email sent!</p>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleResendVerification}
                  disabled={resendLoading}
                >
                  {resendLoading ? "Sending..." : "Resend verification email"}
                </Button>
              )}
            </Alert>
          )}

          {authBounceRef && (
            <p className="text-sm text-muted-foreground">
              Trouble signing in? Reference:{" "}
              <code data-testid="auth-bounce-ref" className="font-mono">
                {authBounceRef}
              </code>
            </p>
          )}

          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              {...emailHint.fieldProps}
            />
            <FieldHint {...emailHint.hintProps}>
              Example: you@example.com
            </FieldHint>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="password">Password</Label>
              <Link
                href="/forgot-password"
                className="text-sm text-muted-foreground hover:text-foreground underline-offset-4 hover:underline"
              >
                Forgot password?
              </Link>
            </div>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
            />
          </div>
        </CardContent>

        <CardFooter className="flex flex-col gap-4">
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "Signing in..." : "Sign in"}
          </Button>

          <p className="text-sm text-center text-muted-foreground">
            Didn&apos;t get your account setup or invite email? Check your spam
            folder, then use{" "}
            <Link
              href="/forgot-password"
              className="text-foreground font-medium underline-offset-4 hover:underline"
            >
              forgot password
            </Link>{" "}
            to send yourself a fresh link — it works even before your first
            sign-in.
          </p>

          <p className="text-sm text-center text-muted-foreground">
            Need to join the club?{" "}
            <Link
              href="/join/apply"
              className="text-foreground font-medium underline-offset-4 hover:underline"
            >
              Apply for membership
            </Link>
          </p>

          {/* No public "request a booking without an account" link here (#2421):
              whether the club hosts non-members is the club's own policy, and
              advertising open guest bookings reads as commercial accommodation.
              /booking-requests still works by direct URL — the club shares that
              link privately with guests it is willing to host (an admin copies
              it from Admin > Booking Requests > Public Requests). With this link
              gone, no page a visitor can browse to reaches the form; the only
              other path in is the rebook button on a tokenised /pay/[token]
              link the club itself emails to an already-vetted requester. */}
          <p className="text-sm text-center text-muted-foreground">
            Booking for a school group?{" "}
            <Link
              href="/school-bookings"
              className="text-foreground font-medium underline-offset-4 hover:underline"
            >
              Request a school group booking
            </Link>
          </p>
        </CardFooter>
      </form>

      {googleLoginEnabled && (
        <CardContent>
          <div className="mt-2 border-t pt-4">
            <p className="mb-3 text-sm text-muted-foreground">
              Linked your Google account? Sign in with it below.
            </p>
            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={() =>
                // Google resolves the destination server-side: with an explicit
                // deep link the provider returns straight to it; otherwise it
                // returns to /login, whose authenticated self-heal resolves the
                // landing preference / admin role default (#2090). There is no
                // client post-auth seam on the OAuth round-trip, so /login is
                // that seam — which is why the #2974 tab-binding nonce has to be
                // in the address the provider returns to. It is tokenless, and
                // `Referrer-Policy: strict-origin-when-cross-origin` means the
                // provider is sent this origin and no path or query at all.
                void signIn("google", {
                  callbackUrl:
                    explicitCallbackUrl ??
                    buildFamilyInviteLoginPath(familyInviteReturnNonce),
                })
              }
            >
              Continue with Google
            </Button>
          </div>
        </CardContent>
      )}

      {magicLinkEnabled && (
        <CardContent>
          <MagicLinkRequestForm />
        </CardContent>
      )}
    </Card>
  );
}
