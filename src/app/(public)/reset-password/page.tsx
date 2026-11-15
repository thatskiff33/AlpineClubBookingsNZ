"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FocusedActionError } from "@/components/focused-action-error";
import { focusAndKeepInView } from "@/hooks/use-scroll-to-feedback";
import { usePasswordPolicyHints } from "@/hooks/use-password-policy-hints";

function ResetPasswordForm() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const policy = usePasswordPolicyHints();

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [confirmError, setConfirmError] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);
  // #4949: after a failed check, focus moves to the first failing field once its
  // error is committed, so its description reads the error before the
  // requirements. A fresh object each time re-runs the move on a repeat failure.
  const [invalidField, setInvalidField] = useState<{ id: string } | null>(null);

  useEffect(() => {
    if (invalidField) focusAndKeepInView(document.getElementById(invalidField.id));
  }, [invalidField]);

  if (!token) {
    return (
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-1">
          <CardTitle className="text-2xl font-bold text-center">Invalid link</CardTitle>
          <CardDescription className="text-center">
            This password reset link is missing a token. Please request a new one.
          </CardDescription>
        </CardHeader>
        <CardFooter>
          <Button asChild variant="outline" className="w-full">
            <Link href="/forgot-password">Request new link</Link>
          </Button>
        </CardFooter>
      </Card>
    );
  }

  if (success) {
    return (
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-1">
          <CardTitle className="text-2xl font-bold text-center">Password updated</CardTitle>
          <CardDescription className="text-center">
            Your password has been reset successfully. You can now sign in with your new
            password.
          </CardDescription>
        </CardHeader>
        <CardFooter>
          <Button asChild className="w-full">
            <Link href="/login">Sign in</Link>
          </Button>
        </CardFooter>
      </Card>
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setPasswordError("");
    setConfirmError("");

    let firstInvalid: string | null = null;

    if (password.length < policy.minPasswordLength) {
      setPasswordError(
        `Password must be at least ${policy.minPasswordLength} characters`,
      );
      firstInvalid = "password";
    }

    if (!confirmPassword) {
      setConfirmError("Please confirm your new password");
      firstInvalid ??= "confirmPassword";
    } else if (password !== confirmPassword) {
      setConfirmError("Passwords do not match");
      firstInvalid ??= "confirmPassword";
    }

    if (firstInvalid) {
      setInvalidField({ id: firstInvalid });
      return;
    }

    setLoading(true);

    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Failed to reset password. Please try again.");
        return;
      }

      setSuccess(true);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader className="space-y-1">
        <CardTitle className="text-2xl font-bold text-center">Reset your password</CardTitle>
        <CardDescription className="text-center">
          Enter a new password for your account.
        </CardDescription>
      </CardHeader>

      <form onSubmit={handleSubmit}>
        <CardContent className="space-y-4">
          <FocusedActionError
            id="reset-password-error"
            error={error}
            action={
              error.includes("expired") || error.includes("already been used") ? (
                <Link
                  href="/forgot-password"
                  className="font-medium underline underline-offset-4"
                >
                  Request a new link
                </Link>
              ) : undefined
            }
          />

          <div className="space-y-2">
            <Label htmlFor="password">New password</Label>
            <Input
              id="password"
              type="password"
              placeholder={`At least ${policy.minPasswordLength} characters`}
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setPasswordError("");
              }}
              minLength={policy.minPasswordLength}
              maxLength={policy.maxPasswordLength}
              autoComplete="new-password"
              required
              aria-invalid={passwordError ? true : undefined}
              aria-describedby={
                passwordError
                  ? "password-error password-requirements"
                  : "password-requirements"
              }
            />
            <ul
              id="password-requirements"
              className="mt-1 space-y-0.5 text-xs text-muted-foreground"
            >
              {policy.hints.map((hint) => (
                <li key={hint}>{hint}</li>
              ))}
            </ul>
            {passwordError && (
              <p id="password-error" className="text-xs text-destructive">
                {passwordError}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="confirmPassword">Confirm new password</Label>
            <Input
              id="confirmPassword"
              type="password"
              placeholder="Repeat your new password"
              value={confirmPassword}
              onChange={(e) => {
                setConfirmPassword(e.target.value);
                setConfirmError("");
              }}
              autoComplete="new-password"
              required
              aria-invalid={confirmError ? true : undefined}
              aria-describedby={confirmError ? "confirm-password-error" : undefined}
            />
            {confirmError && (
              <p id="confirm-password-error" className="text-xs text-destructive">
                {confirmError}
              </p>
            )}
          </div>
        </CardContent>

        <CardFooter>
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "Updating password…" : "Update password"}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense
      fallback={
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="text-center">Loading…</CardTitle>
          </CardHeader>
        </Card>
      }
    >
      <ResetPasswordForm />
    </Suspense>
  );
}
