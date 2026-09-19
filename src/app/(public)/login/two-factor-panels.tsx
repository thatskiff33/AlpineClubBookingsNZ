"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Copy, KeyRound, Loader2, Mail, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiErrorMessageFromResponse } from "@/lib/api-error-message";

type EnrollMethod = "TOTP" | "EMAIL";
type VerifyMethod = "TOTP" | "EMAIL" | "RECOVERY";

type TotpSetup = {
  secret: string;
  otpauthUrl: string;
  issuer: string;
  label: string;
};

function RecoveryCodes({
  callbackUrl,
  codes,
}: {
  callbackUrl: string;
  codes: string[];
}) {
  const router = useRouter();
  const [copied, setCopied] = useState(false);

  async function copyCodes() {
    await navigator.clipboard.writeText(codes.join("\n"));
    setCopied(true);
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader className="space-y-1">
        <h1 className="sr-only">Save your recovery codes</h1>
        <CardTitle>Save your recovery codes</CardTitle>
        <CardDescription>
          Each code works once if your usual two-factor method is unavailable.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-2 rounded-md border bg-muted p-3 font-mono text-sm">
          {codes.map((code) => (
            <div key={code}>{code}</div>
          ))}
        </div>
      </CardContent>
      <CardFooter className="flex flex-col gap-3 sm:flex-row">
        <Button type="button" variant="outline" onClick={() => void copyCodes()}>
          <Copy className="h-4 w-4" />
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button type="button" onClick={() => router.replace(callbackUrl)}>
          Continue
        </Button>
      </CardFooter>
    </Card>
  );
}

export function TwoFactorEnrollPanel({ callbackUrl }: { callbackUrl: string }) {
  const [method, setMethod] = useState<EnrollMethod>("TOTP");
  const [totpSetup, setTotpSetup] = useState<TotpSetup | null>(null);
  const [totpCode, setTotpCode] = useState("");
  const [emailCode, setEmailCode] = useState("");
  const [emailSent, setEmailSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  useEffect(() => {
    if (method !== "TOTP" || totpSetup) return;

    let cancelled = false;
    async function loadSetup() {
      setError("");
      const response = await fetch("/api/auth/2fa/totp/setup", {
        credentials: "same-origin",
      });
      if (!response.ok) {
        if (!cancelled) {
          setError(await apiErrorMessageFromResponse(response, "Failed to prepare authenticator setup"));
        }
        return;
      }
      const body = (await response.json()) as TotpSetup;
      if (!cancelled) setTotpSetup(body);
    }

    void loadSetup();
    return () => {
      cancelled = true;
    };
  }, [method, totpSetup]);

  async function sendEmailCode() {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/auth/2fa/email/send", {
        method: "POST",
        credentials: "same-origin",
      });
      if (!response.ok) {
        throw new Error(await apiErrorMessageFromResponse(response, "Failed to send code"));
      }
      setEmailSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send code");
    } finally {
      setLoading(false);
    }
  }

  async function enrollTotp() {
    if (!totpSetup) return;
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/auth/2fa/enroll/totp", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret: totpSetup.secret, code: totpCode }),
      });
      if (!response.ok) {
        throw new Error(await apiErrorMessageFromResponse(response, "Invalid code"));
      }
      const body = (await response.json()) as { recoveryCodes: string[] };
      setRecoveryCodes(body.recoveryCodes);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Enrollment failed");
    } finally {
      setLoading(false);
    }
  }

  async function enrollEmail() {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/auth/2fa/enroll/email", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: emailCode }),
      });
      if (!response.ok) {
        throw new Error(await apiErrorMessageFromResponse(response, "Invalid code"));
      }
      const body = (await response.json()) as { recoveryCodes: string[] };
      setRecoveryCodes(body.recoveryCodes);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Enrollment failed");
    } finally {
      setLoading(false);
    }
  }

  if (recoveryCodes) {
    return <RecoveryCodes callbackUrl={callbackUrl} codes={recoveryCodes} />;
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader className="space-y-1">
        <h1 className="sr-only">Set up two-factor authentication</h1>
        <CardTitle>Set up two-factor authentication</CardTitle>
        <CardDescription>
          Choose how you want to verify future sign-ins.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {error ? (
          <div className="rounded-md border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        ) : null}

        <div className="grid grid-cols-2 gap-2">
          <Button
            type="button"
            variant={method === "TOTP" ? "default" : "outline"}
            onClick={() => setMethod("TOTP")}
          >
            <KeyRound className="h-4 w-4" />
            App
          </Button>
          <Button
            type="button"
            variant={method === "EMAIL" ? "default" : "outline"}
            onClick={() => setMethod("EMAIL")}
          >
            <Mail className="h-4 w-4" />
            Email
          </Button>
        </div>

        {method === "TOTP" ? (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Manual setup key</Label>
              <div className="break-all rounded-md border bg-muted p-3 font-mono text-sm">
                {totpSetup?.secret ?? "Preparing setup key..."}
              </div>
              {totpSetup ? (
                <a
                  className="text-sm font-medium underline underline-offset-4"
                  href={totpSetup.otpauthUrl}
                >
                  Open authenticator app
                </a>
              ) : null}
            </div>
            <div className="space-y-2">
              <Label htmlFor="totp-code">Authenticator code</Label>
              <Input
                autoComplete="one-time-code"
                id="totp-code"
                inputMode="numeric"
                maxLength={6}
                value={totpCode}
                onChange={(event) => setTotpCode(event.target.value)}
              />
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => void sendEmailCode()}
              disabled={loading}
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
              {emailSent ? "Send another code" : "Send email code"}
            </Button>
            <div className="space-y-2">
              <Label htmlFor="email-code">Email code</Label>
              <Input
                autoComplete="one-time-code"
                id="email-code"
                inputMode="numeric"
                maxLength={6}
                value={emailCode}
                onChange={(event) => setEmailCode(event.target.value)}
              />
            </div>
          </div>
        )}
      </CardContent>
      <CardFooter>
        <Button
          className="w-full"
          type="button"
          disabled={loading || (method === "TOTP" && !totpSetup)}
          onClick={() =>
            method === "TOTP" ? void enrollTotp() : void enrollEmail()
          }
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
          Enroll
        </Button>
      </CardFooter>
    </Card>
  );
}

export function TwoFactorVerifyPanel({
  callbackUrl,
  enrolledMethod,
}: {
  callbackUrl: string;
  enrolledMethod: "TOTP" | "EMAIL";
}) {
  const router = useRouter();
  const [method, setMethod] = useState<VerifyMethod>(enrolledMethod);
  const [code, setCode] = useState("");
  const [emailSent, setEmailSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function sendEmailCode() {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/auth/2fa/email/send", {
        method: "POST",
        credentials: "same-origin",
      });
      if (!response.ok) {
        throw new Error(await apiErrorMessageFromResponse(response, "Failed to send code"));
      }
      setEmailSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send code");
    } finally {
      setLoading(false);
    }
  }

  async function verify() {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/auth/2fa/verify", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method, code }),
      });
      if (!response.ok) {
        throw new Error(await apiErrorMessageFromResponse(response, "Invalid code"));
      }
      router.replace(callbackUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader className="space-y-1">
        <CardTitle>Verify your sign-in</CardTitle>
        <CardDescription>
          Enter a two-factor code to continue.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {error ? (
          <div className="rounded-md border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        ) : null}

        <div className="grid grid-cols-2 gap-2">
          <Button
            type="button"
            variant={method === enrolledMethod ? "default" : "outline"}
            onClick={() => setMethod(enrolledMethod)}
          >
            {enrolledMethod === "EMAIL" ? (
              <Mail className="h-4 w-4" />
            ) : (
              <KeyRound className="h-4 w-4" />
            )}
            {enrolledMethod === "EMAIL" ? "Email" : "App"}
          </Button>
          <Button
            type="button"
            variant={method === "RECOVERY" ? "default" : "outline"}
            onClick={() => setMethod("RECOVERY")}
          >
            <ShieldCheck className="h-4 w-4" />
            Recovery
          </Button>
        </div>

        {method === "EMAIL" ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => void sendEmailCode()}
            disabled={loading}
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
            {emailSent ? "Send another code" : "Send email code"}
          </Button>
        ) : null}

        <div className="space-y-2">
          <Label htmlFor="two-factor-code">
            {method === "RECOVERY" ? "Recovery code" : "Two-factor code"}
          </Label>
          <Input
            autoComplete={method === "RECOVERY" ? "off" : "one-time-code"}
            id="two-factor-code"
            inputMode={method === "RECOVERY" ? "text" : "numeric"}
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
        </div>
      </CardContent>
      <CardFooter>
        <Button
          className="w-full"
          type="button"
          disabled={loading}
          onClick={() => void verify()}
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
          Verify
        </Button>
      </CardFooter>
    </Card>
  );
}
