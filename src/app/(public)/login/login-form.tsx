"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import Link from "next/link";
import { useClubIdentity } from "@/components/club-identity-provider";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader } from "@/components/ui/card";
import { WebsiteLogo } from "@/components/website-logo";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// The login query params (verified / verifyError / emailChanged / callbackUrl)
// are read on the server and passed in as props. Reading them here via
// useSearchParams() forced this client subtree into a Suspense boundary, whose
// hard-load hydration is the suspected cause of the transient input duplication
// (#email briefly resolving to two nodes — the E2E flake tracked in #1207/#1140).
// Server-resolved props keep the render deterministic. redirectTo is the
// already-sanitised post-login destination (resolvePostLoginPath ran server-side).
export function LoginForm({
  verified,
  verifyError,
  emailChanged,
  redirectTo,
  authBounceRef,
}: {
  verified: boolean;
  verifyError?: string;
  emailChanged: boolean;
  redirectTo: string;
  authBounceRef?: string;
}) {
  const club = useClubIdentity();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [emailNotVerified, setEmailNotVerified] = useState(false);
  const [resendLoading, setResendLoading] = useState(false);
  const [resendSuccess, setResendSuccess] = useState(false);

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

    const params = new URLSearchParams({ callbackUrl: redirectTo });
    return status.enrolled
      ? `/login/verify?${params.toString()}`
      : `/login/enroll?${params.toString()}`;
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
        window.location.assign((await resolveTwoFactorPath()) ?? redirectTo);
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
            <div className="rounded-md bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-800">
              Your email has been verified. You can now sign in.
            </div>
          )}

          {emailChanged && (
            <div className="rounded-md bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-800">
              Your email has been changed successfully.
            </div>
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

          {error && (
            <Alert variant="error">
              {error}
            </Alert>
          )}

          {emailNotVerified && (
            <Alert variant="warning">
              <div className="space-y-2">
                <p className="font-medium">Please verify your email</p>
                <p>
                  Check your inbox for a verification email. Click the link to verify your account.
                </p>
                {resendSuccess ? (
                  <p className="text-green-700 font-medium">Verification email sent!</p>
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
              </div>
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
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
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

          <p className="text-sm text-center text-muted-foreground">
            Just want to stay with us?{" "}
            <Link
              href="/booking-requests"
              className="text-foreground font-medium underline-offset-4 hover:underline"
            >
              Request a booking without an account
            </Link>
          </p>

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
    </Card>
  );
}
