import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import { logAudit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import { getStripe } from "@/lib/stripe";
import { getOperationalStripeSecretKey } from "@/lib/stripe-config";

const providerTestSchema = z.object({
  provider: z.enum(["stripe", "smtp", "sentry", "xero"]),
});

type Provider = z.infer<typeof providerTestSchema>["provider"];

async function withTimeout<T>(label: string, promise: Promise<T>): Promise<T> {
  const timeoutMs = 10_000;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(new Error(`${label} timed out after ${timeoutMs / 1000}s`)),
        timeoutMs,
      ),
    ),
  ]);
}

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

async function testStripe() {
  // DB-only (#2082): the secret key is captured in-app, not from the env.
  if (!(await getOperationalStripeSecretKey())) {
    throw new Error("Stripe secret key is not configured");
  }

  const stripe = await getStripe();
  await withTimeout("Stripe balance check", stripe.balance.retrieve());
  return "Stripe responded to a balance read using the configured key.";
}

/**
 * A provider connection test that CANNOT send (#3035): `verifyEmailTransport`
 * returns the mode label and no transport, so this route has nothing to mail a
 * member with. It also inherits the ambiguous-configuration refusal — an
 * installation that is not confirmed production and sets neither `USE_AWS_SES`
 * nor `USE_SMTP_RELAY` is told to set one instead of quietly connecting to the
 * club's live AWS SES account.
 */
async function testSmtp() {
  const { verifyEmailTransport } = await import("@/lib/email/internal");
  const { modeLabel } = await withTimeout(
    "SMTP verify",
    verifyEmailTransport(),
  );
  return `${modeLabel} verification completed successfully.`;
}

async function testSentry() {
  if (!readEnv("SENTRY_DSN")) {
    throw new Error("SENTRY_DSN is not configured");
  }

  Sentry.captureMessage("Setup wizard diagnostic event", {
    level: "info",
    tags: { source: "setup-wizard" },
  });
  const flushed = await withTimeout("Sentry flush", Sentry.flush(5000));
  if (!flushed) {
    throw new Error("Sentry did not flush the diagnostic event before timeout");
  }
  return "Sentry accepted a diagnostic event flush.";
}

async function testOperationalXero() {
  const token = await prisma.xeroToken.findFirst({
    orderBy: { updatedAt: "desc" },
    select: { expiresAt: true, tenantId: true },
  });
  if (!token) {
    throw new Error("Operational Xero is not connected");
  }
  if (token.expiresAt <= new Date()) {
    throw new Error("Operational Xero token is expired");
  }
  return `Operational Xero token is active for tenant ${token.tenantId ?? "unknown"}.`;
}

async function runProviderTest(provider: Provider) {
  switch (provider) {
    case "stripe":
      return testStripe();
    case "smtp":
      return testSmtp();
    case "sentry":
      return testSentry();
    case "xero":
      return testOperationalXero();
  }
}

export async function POST(request: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = providerTestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const checkedAt = new Date().toISOString();
  try {
    const message = await runProviderTest(parsed.data.provider);
    await logAudit({
      action: "setup_provider_test",
      memberId: session.user.id,
      category: "system",
      outcome: "success",
      summary: `Setup provider test succeeded: ${parsed.data.provider}`,
      metadata: { provider: parsed.data.provider },
    });
    return NextResponse.json({
      ok: true,
      provider: parsed.data.provider,
      checkedAt,
      message,
    });
  } catch (error) {
    // Provider SDK error messages can embed redacted credential fragments
    // (e.g. Stripe's "Invalid API Key provided: sk_test_****abcd"), so only
    // the error NAME reaches the audit row and the response stays generic —
    // the C1 exposure contract keeps key material, even redacted, out of
    // audit rows (#2082 security review).
    const errorName = error instanceof Error ? error.name : "UnknownError";
    await logAudit({
      action: "setup_provider_test",
      memberId: session.user.id,
      category: "system",
      outcome: "failure",
      summary: `Setup provider test failed: ${parsed.data.provider}`,
      metadata: { provider: parsed.data.provider, error: errorName },
    });
    return NextResponse.json({
      ok: false,
      provider: parsed.data.provider,
      checkedAt,
      message:
        "Provider test failed — the provider rejected the request. Check the stored credentials and try again.",
    });
  }
}
