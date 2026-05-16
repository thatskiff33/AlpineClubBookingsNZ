"use client";

import { Suspense, useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { useClubIdentity } from "@/components/club-identity-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { resolvePostLoginPath } from "@/lib/auth-redirect";

function LoginForm() {
  const club = useClubIdentity();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [emailNotVerified, setEmailNotVerified] = useState(false);
  const [resendLoading, setResendLoading] = useState(false);
  const [resendSuccess, setResendSuccess] = useState(false);

  const verified = searchParams.get("verified") === "true";
  const verifyError = searchParams.get("verifyError");
  const emailChanged = searchParams.get("emailChanged") === "true";
  const redirectTo = resolvePostLoginPath(searchParams.get("callbackUrl"));

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
      } else {
        router.push(redirectTo);
      }
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
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
        <Image
          src="/branding/logo.png"
          alt={club.name}
          width={180}
          height={60}
          className="h-14 w-auto mb-2"
          priority
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
            <div className="rounded-md bg-destructive/10 border border-destructive/20 px-4 py-3 text-sm text-destructive">
              {verifyError === "expired"
                ? "Your verification link has expired. Please request a new one."
                : verifyError === "invalid"
                ? "Invalid verification link."
                : "An error occurred during email verification."}
            </div>
          )}

          {error && (
            <div className="rounded-md bg-destructive/10 border border-destructive/20 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          )}

          {emailNotVerified && (
            <div className="rounded-md bg-yellow-50 border border-yellow-200 px-4 py-3 text-sm space-y-2">
              <p className="text-yellow-800 font-medium">Please verify your email</p>
              <p className="text-yellow-700">
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
            Need to join the club?{" "}
            <Link
              href="/join/apply"
              className="text-foreground font-medium underline-offset-4 hover:underline"
            >
              Apply for membership
            </Link>
          </p>
        </CardFooter>
      </form>
    </Card>
  );
}

export default function LoginPage() {
  const club = useClubIdentity();

  return (
    <Suspense fallback={
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-1 items-center">
          <Image
            src="/branding/logo.png"
            alt={club.name}
            width={180}
            height={60}
            className="h-14 w-auto"
          />
        </CardHeader>
      </Card>
    }>
      <LoginForm />
    </Suspense>
  );
}
