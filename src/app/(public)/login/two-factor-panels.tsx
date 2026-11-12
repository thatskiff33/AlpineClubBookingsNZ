"use client";

import { useEffect, useState, type FormEvent } from "react";
import { startAuthentication } from "@simplewebauthn/browser";
import { Copy, Fingerprint, KeyRound, Loader2, Mail, ShieldCheck } from "lucide-react";
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
import { OptionCard, OptionCardGroup } from "@/components/ui/option-card";
import { useQrDataUrl } from "@/hooks/use-qr-data-url";
import { apiErrorMessageFromResponse } from "@/lib/api-error-message";
import { RetiredRecoveryCodesNotice } from "@/components/retired-recovery-codes-notice";

type EnrollMethod = "TOTP" | "EMAIL";
type VerifyMethod = "TOTP" | "EMAIL" | "RECOVERY";

type TotpSetup = {
  secret: string;
  otpauthUrl: string;
  issuer: string;
  label: string;
};

// Start a fresh document at the destination already resolved by the server.
// Both successful exits share this policy; keep private invite paths out of DOM attributes.
function completeTwoFactorSignIn(callbackUrl: string) {
  window.location.replace(callbackUrl);
}

function RecoveryCodes({
  callbackUrl,
  codes,
}: {
  callbackUrl: string;
  codes: string[];
}) {
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
        <Button type="button" onClick={() => completeTwoFactorSignIn(callbackUrl)}>
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
  const setupQrDataUrl = useQrDataUrl(totpSetup?.otpauthUrl ?? null, 192);
  const canEnroll = !loading && (method !== "TOTP" || totpSetup !== null);

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

  // A real form, so Enter in a code field enrols (#4952). preventDefault keeps
  // the code out of the URL; the guard stops Enter doing what the disabled
  // button would not.
  function submitEnroll(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canEnroll) return;
    void (method === "TOTP" ? enrollTotp() : enrollEmail());
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
      <form noValidate onSubmit={submitEnroll}>
        <CardContent className="space-y-5">
          {error ? (
            <div className="rounded-md border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          ) : null}

          <OptionCardGroup label="Verification method">
            <OptionCard
              icon={KeyRound}
              title="App"
              selected={method === "TOTP"}
              onSelect={() => setMethod("TOTP")}
            />
            <OptionCard
              icon={Mail}
              title="Email"
              selected={method === "EMAIL"}
              onSelect={() => setMethod("EMAIL")}
            />
          </OptionCardGroup>

          {method === "TOTP" ? (
            <div className="space-y-4">
              {setupQrDataUrl ? (
                <div className="flex flex-col items-center gap-2">
                  {/* eslint-disable-next-line @next/next/no-img-element -- a QR bitmap
                      drawn in the browser as a data URL; next/image cannot optimise
                      one. */}
                  <img
                    src={setupQrDataUrl}
                    alt="QR code to scan with your authenticator app"
                    className="h-48 w-48 rounded-md border"
                  />
                  <p className="text-center text-sm text-muted-foreground">
                    Scan this QR code with your authenticator app.
                  </p>
                </div>
              ) : null}
              <div className="space-y-2">
                <Label htmlFor="totp-setup-key">Or type this setup key</Label>
                <output
                  id="totp-setup-key"
                  className="block break-all rounded-md border bg-muted p-3 font-mono text-sm"
                >
                  {totpSetup?.secret ?? "Preparing setup key..."}
                </output>
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
          <Button className="w-full" type="submit" disabled={!canEnroll}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
            Enroll
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

export function TwoFactorVerifyPanel({
  callbackUrl,
  enrolledMethod,
  hasPasskey = false,
  recoveryCodesRetired = false,
}: {
  callbackUrl: string;
  enrolledMethod: "TOTP" | "EMAIL" | null;
  /** A passkey is saved. It sits beside the app or email code. */
  hasPasskey?: boolean;
  /** The member's saved recovery codes were retired by a key change (#4456). */
  recoveryCodesRetired?: boolean;
}) {
  const [method, setMethod] = useState<VerifyMethod>(enrolledMethod ?? "RECOVERY");
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
      completeTwoFactorSignIn(callbackUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setLoading(false);
    }
  }

  // A real form, so Enter in the code field verifies (#4952); see submitEnroll.
  function submitVerify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!enrolledMethod || loading) return;
    void verify();
  }

  async function signInWithPasskey() {
    setLoading(true);
    setError("");
    try {
      const optionsResponse = await fetch("/api/auth/2fa/webauthn/authenticate/options", {
        method: "POST",
        credentials: "same-origin",
      });
      if (!optionsResponse.ok) {
        throw new Error(
          await apiErrorMessageFromResponse(optionsResponse, "That passkey didn't work. Try again."),
        );
      }
      const optionsJSON: unknown = await optionsResponse.json();
      const assertion = await startAuthentication({
        optionsJSON: optionsJSON as Parameters<typeof startAuthentication>[0]["optionsJSON"],
      });
      const verifyResponse = await fetch("/api/auth/2fa/webauthn/authenticate/verify", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response: assertion }),
      });
      if (!verifyResponse.ok) {
        throw new Error(
          await apiErrorMessageFromResponse(verifyResponse, "That passkey didn't work. Try again."),
        );
      }
      completeTwoFactorSignIn(callbackUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That passkey didn't work. Try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader className="space-y-1">
        <CardTitle>Verify your sign-in</CardTitle>
        <CardDescription>
          {enrolledMethod
            ? "Enter a two-factor code to continue."
            : "Use your passkey to continue."}
        </CardDescription>
      </CardHeader>
      <form noValidate onSubmit={submitVerify}>
        <CardContent className="space-y-5">
          {error ? (
            <div className="rounded-md border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          ) : null}

          {recoveryCodesRetired ? (
            <RetiredRecoveryCodesNotice>
              Sign in with your {enrolledMethod === "EMAIL" ? "email" : "app"} code, then
              generate new recovery codes from your profile.
            </RetiredRecoveryCodesNotice>
          ) : null}

          {enrolledMethod ? (
            <OptionCardGroup label="Verification method">
              <OptionCard
                icon={enrolledMethod === "EMAIL" ? Mail : KeyRound}
                title={enrolledMethod === "EMAIL" ? "Email" : "App"}
                selected={method === enrolledMethod}
                onSelect={() => setMethod(enrolledMethod)}
              />
              <OptionCard
                icon={ShieldCheck}
                title="Recovery"
                selected={method === "RECOVERY"}
                onSelect={() => setMethod("RECOVERY")}
              />
            </OptionCardGroup>
          ) : null}

          {hasPasskey ? (
            <Button
              type="button"
              variant="outline"
              disabled={loading}
              onClick={() => void signInWithPasskey()}
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Fingerprint className="h-4 w-4" />}
              Use your passkey
            </Button>
          ) : null}

          {enrolledMethod && method === "EMAIL" ? (
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

          {enrolledMethod ? (
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
          ) : null}
        </CardContent>
        {enrolledMethod ? (
          <CardFooter>
            <Button className="w-full" type="submit" disabled={loading}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
              Verify
            </Button>
          </CardFooter>
        ) : null}
      </form>
    </Card>
  );
}
