// E2E bootstrap: seed Stripe *test-mode* credentials into the encrypted C1
// IntegrationCredential store (#2082). The app is DB-only now — it no longer
// reads STRIPE_* env vars — so the payment specs need the test-mode keys present
// in the store, and the publishable key is delivered to the card form at runtime
// from there. Run by scripts/e2e-stack.sh after seeding, before the app starts.
//
// Skip-unless-configured: with only placeholder keys this is a no-op (the
// payment specs skip too, via stripeTestModeConfigured()). Live keys are refused
// outright — the E2E suite is test-mode only.
import { setIntegrationCredential } from "../../src/lib/integration-credentials";
import type { CredentialActor } from "../../src/lib/integration-credential-actor";
import { STRIPE_CREDENTIAL_KEYS } from "../../src/lib/stripe-config";
import { prisma } from "../../src/lib/prisma";

function readEnv(name: string): string {
  return (process.env[name] ?? "").trim();
}

function looksLikeTestKey(value: string, prefix: string): boolean {
  return (
    value.startsWith(prefix) &&
    !value.toLowerCase().includes("placeholder") &&
    !value.toLowerCase().includes("fake") &&
    value.length > 30
  );
}

async function main() {
  // Belt-and-braces alongside the live-key refusal below: this script exists
  // only for the E2E staging stack and must never point at a real deployment
  // (#2082 security review hardening).
  if (
    process.env.NODE_ENV === "production" &&
    process.env.APP_RUNTIME_ROLE !== "staging"
  ) {
    throw new Error(
      "Refusing to seed Stripe credentials in a real production runtime — E2E staging stack only.",
    );
  }

  const secretKey = readEnv("STRIPE_SECRET_KEY");
  const publishableKey = readEnv("NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY");
  const webhookSecret = readEnv("STRIPE_WEBHOOK_SECRET");

  if (secretKey.startsWith("sk_live") || publishableKey.startsWith("pk_live")) {
    throw new Error(
      "Refusing to seed live Stripe keys — the E2E suite is test-mode only.",
    );
  }

  if (
    !looksLikeTestKey(secretKey, "sk_test_") ||
    !looksLikeTestKey(publishableKey, "pk_test_")
  ) {
    console.log(
      "Stripe test-mode keys not configured — skipping Stripe credential seed (payment specs will skip).",
    );
    return;
  }

  // This seed is a named system actor like any other background writer
  // (#2723), so its rows are distinguishable from an operator's in the very
  // audit trail the staging stack produces.
  const actor: CredentialActor = { kind: "system", actor: "e2e-stripe-seed" };
  await setIntegrationCredential({
    provider: "stripe",
    key: STRIPE_CREDENTIAL_KEYS.secretKey,
    value: secretKey,
    actor,
    // A fresh stack has no row; a re-run replaces whatever the last run left.
    expect: { expect: "any" },
  });
  await setIntegrationCredential({
    provider: "stripe",
    key: STRIPE_CREDENTIAL_KEYS.publishableKey,
    value: publishableKey,
    actor,
    expect: { expect: "any" },
  });
  if (webhookSecret) {
    await setIntegrationCredential({
      provider: "stripe",
      key: STRIPE_CREDENTIAL_KEYS.webhookSecret,
      value: webhookSecret,
      actor,
      expect: { expect: "any" },
    });
  }

  console.log(
    `Seeded Stripe test-mode credentials into the encrypted store (secret + publishable${
      webhookSecret ? " + webhook secret" : ""
    }).`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
