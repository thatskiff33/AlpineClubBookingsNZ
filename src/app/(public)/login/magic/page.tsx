"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// Fallback post-login destination for a magic-link sign-in. A magic link never
// carries a callbackUrl, so there is never an explicit deep link; the landing
// is resolved post-auth from the member's preference / admin role default
// (#2090), falling back to this default only if resolution fails.
const POST_LOGIN_PATH = "/dashboard";

// Post-auth landing (#2090). A magic-link sign-in has no explicit callbackUrl,
// so the resolver returns the member's preference / admin role default. Any
// failure falls back to the default authenticated home.
async function resolvePostAuthLanding(): Promise<string> {
  // A hung resolver must never strand the user on the "Signing you in…" spinner:
  // abort after a short timeout and fall back to the default authenticated home
  // (the same fallback the catch below uses for any network failure).
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch("/api/auth/post-login-landing", {
      credentials: "same-origin",
      signal: controller.signal,
    });
    if (!response.ok) return POST_LOGIN_PATH;
    const body = (await response.json()) as { path?: string };
    return typeof body.path === "string" && body.path
      ? body.path
      : POST_LOGIN_PATH;
  } catch {
    return POST_LOGIN_PATH;
  } finally {
    clearTimeout(timeout);
  }
}

// Mirror the password login's post-login navigation so a 2FA-enabled member is
// still challenged after a magic-link sign-in. Returns the 2FA / change-password
// detour path, or null when no challenge is open (navigate to the resolved
// landing instead). Determinism (#2090): a magic link never carries an explicit
// deep link, so the detour carries NO callbackUrl — the default landing is
// re-resolved server-side at /login/enroll and /login/verify from the
// fully-authed session, never a raced post-signIn resolver fetch.
async function resolveTwoFactorPath(): Promise<string | null> {
  const response = await fetch("/api/auth/2fa/status", {
    credentials: "same-origin",
  });
  if (!response.ok) return null;
  const twoFactorStatus = (await response.json()) as {
    required?: boolean;
    verified?: boolean;
    enrolled?: boolean;
    forcePasswordChange?: boolean;
  };

  if (twoFactorStatus.forcePasswordChange) {
    return "/change-password";
  }

  if (!twoFactorStatus.required || twoFactorStatus.verified) {
    return null;
  }

  return twoFactorStatus.enrolled ? "/login/verify" : "/login/enroll";
}

type Status = "verifying" | "error" | "password-change";

function MagicSignIn() {
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<Status>("verifying");
  // Strict-mode / re-render guard: the sign-in must fire exactly once, since the
  // token is single-use — a second attempt would always fail as "already used".
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const token = searchParams.get("token") ?? "";

    // Remove the token from the visible URL / history so the single-use secret
    // does not linger in the address bar or the back/forward stack.
    if (typeof window !== "undefined" && token) {
      window.history.replaceState(null, "", "/login/magic");
    }

    if (!token) {
      setStatus("error");
      return;
    }

    async function run() {
      try {
        const result = await signIn("magic-link", {
          token,
          redirect: false,
        });

        if (!result || result.error) {
          if (
            result?.code === "PASSWORD_CHANGE_REQUIRED" ||
            result?.error === "PASSWORD_CHANGE_REQUIRED"
          ) {
            setStatus("password-change");
          } else {
            // Invalid / expired / already-used / unverified all collapse to the
            // same generic message — nothing about which case applies leaks.
            setStatus("error");
          }
          return;
        }

        // Signed in. Check the 2FA gate FIRST (#2090): when a challenge is open
        // the detour (/login/enroll or /login/verify) re-resolves the default
        // landing server-side, so we skip the client landing resolver on that
        // path. Only a directly-authenticated member (no challenge) resolves the
        // landing here. Full document navigation (never router.push) sends the
        // fresh session cookie and avoids the logged-out RSC cache bounce (#1669).
        const twoFactorPath = await resolveTwoFactorPath();
        window.location.assign(
          twoFactorPath ?? (await resolvePostAuthLanding()),
        );
      } catch {
        setStatus("error");
      }
    }

    void run();
  }, [searchParams]);

  if (status === "verifying") {
    return (
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-1">
          <CardTitle className="text-center text-2xl font-bold">
            Signing you in…
          </CardTitle>
          <CardDescription className="text-center">
            Please wait while we verify your sign-in link.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (status === "password-change") {
    return (
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-1">
          <CardTitle className="text-center text-2xl font-bold">
            Set a new password to continue
          </CardTitle>
          <CardDescription className="text-center">
            Your account needs a password change before you can sign in. Use
            Forgot password to set a new one, then sign in.
          </CardDescription>
        </CardHeader>
        <CardFooter>
          <Button asChild className="w-full">
            <Link href="/forgot-password">Forgot password</Link>
          </Button>
        </CardFooter>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader className="space-y-1">
        <CardTitle className="text-center text-2xl font-bold">
          This sign-in link didn&apos;t work
        </CardTitle>
        <CardDescription className="text-center">
          It may have expired, already been used, or be invalid. Request a fresh
          link, or sign in with your password.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Button asChild className="w-full">
          <Link href="/login">Back to sign in</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

export default function MagicLinkPage() {
  return (
    <>
      {/* Keep the single-use token out of the Referer header on any outbound
          navigation or subresource load from this page. */}
      <meta name="referrer" content="no-referrer" />
      <Suspense
        fallback={
          <Card className="w-full max-w-md">
            <CardHeader>
              <CardTitle className="text-center">Loading…</CardTitle>
            </CardHeader>
          </Card>
        }
      >
        <MagicSignIn />
      </Suspense>
    </>
  );
}
