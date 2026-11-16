// @vitest-environment jsdom

/*
  #4975 (ALP-577) — the Stripe, Google and Xero setup wizards: a failed save,
  verify or disconnect takes focus, and takes it AGAIN when the same failure
  repeats, so a keyboard or screen-reader admin hears it every time. What the
  page found on arrival (a failed status read, Google's verify-return error)
  stays passive and moves nothing.
*/

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WizardStepHelpers } from "@/components/admin/integration-wizard";
import { expectRecoveryAlertToHoldFocus } from "@/lib/__tests__/helpers/focus";
import {
  CredentialsStep as StripeCredentialsStep,
  WebhookStep as StripeWebhookStep,
} from "../stripe/setup/stripe-wizard-steps";
import type { StripeWizardContext } from "../stripe/setup/use-stripe-wizard-context";
import {
  CredentialsStep as GoogleCredentialsStep,
  VerifyStep as GoogleVerifyStep,
} from "../google/setup/google-wizard-steps";
import type { GoogleWizardContext } from "../google/setup/use-google-wizard-context";
import {
  ConnectStep as XeroConnectStep,
  CredentialsStep as XeroCredentialsStep,
} from "../finance/xero/setup/xero-wizard-steps";
import { WebhooksStep as XeroWebhooksStep } from "../finance/xero/setup/xero-completion-steps";
import type { XeroWizardContext } from "../finance/xero/setup/use-xero-wizard-context";

const navigation = vi.hoisted(() => ({ search: "" }));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(navigation.search),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/admin/setup",
}));

vi.mock("next-auth/react", () => ({ signIn: vi.fn() }));

const helpers: WizardStepHelpers = {
  canEdit: true,
  refresh: vi.fn(),
  goNext: vi.fn(),
  isVerified: false,
  optional: false,
  acknowledged: false,
  skip: vi.fn(),
  reportSaving: vi.fn(),
  ancestorRendersViewOnlyBanner: true,
};

function stripeContext(): StripeWizardContext {
  return {
    webhookEndpointUrl: "https://example.test/api/webhooks/stripe",
    legacyEnvVars: [],
    credentials: {
      secret_key: { set: false, setAt: null },
      publishable_key: { set: false, setAt: null },
      webhook_secret: { set: false, setAt: null },
    },
    isFullAdmin: true,
    connected: false,
    accountName: null,
    keysNeedReentry: false,
    webhookSecretNeedsReentry: false,
    webhookVerified: false,
  };
}

function googleContext(): GoogleWizardContext {
  return {
    redirectUri: "https://example.test/api/auth/callback/google",
    legacyEnvVars: [],
    credentials: {
      client_id: { set: true, setAt: null },
      client_secret: { set: true, setAt: null },
    },
    isFullAdmin: true,
    needsReentry: false,
    verified: false,
  } as GoogleWizardContext;
}

function xeroContext(overrides: Partial<XeroWizardContext> = {}): XeroWizardContext {
  return {
    redirectUri: "https://example.test/api/admin/xero/callback",
    companyUrl: "https://example.test",
    legacyEnvVars: [],
    credentials: {
      client_id: { set: true, setAt: null },
      client_secret: { set: true, setAt: null },
      webhook_key: { set: false, setAt: null },
    },
    isFullAdmin: true,
    connected: true,
    needsReentry: false,
    orgName: "Alpine Sports Club",
    orgBaseCurrency: null,
    clubChargeCurrencyCode: "NZD",
    orgError: null,
    orgErrorAt: null,
    orgErrorAttempts: 0,
    orgLoading: false,
    webhookDeliveryUrl: "https://example.test/api/webhooks/xero",
    webhooksVerifiable: true,
    webhookVerified: false,
    ...overrides,
  };
}

function failingWrite(message: string) {
  return {
    ok: false,
    status: 500,
    json: async () => ({ error: message }),
  };
}

/** A failure, then the same failure again with focus moved off the alert. */
async function expectFocusOnEachFailure(
  alertId: string,
  message: string,
  press: () => HTMLElement,
) {
  const first = press();
  fireEvent.click(first);
  const alert = document.getElementById(alertId);
  await waitFor(() => expect(alert).toHaveTextContent(message));
  await expectRecoveryAlertToHoldFocus(alert);

  // The admin goes back to the control and presses it again: the identical
  // failure must take focus again, not sit silently where it already was.
  const second = press();
  second.focus();
  expect(document.activeElement).toBe(second);
  fireEvent.click(second);
  await expectRecoveryAlertToHoldFocus(alert);
  expect(alert).toHaveTextContent(message);
}

beforeEach(() => {
  navigation.search = "";
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState({}, "", "/");
});

describe("Stripe setup wizard", () => {
  it("focuses a failed key save, and focuses it again when it repeats", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => failingWrite("Stripe rejected the key.")));
    render(<StripeCredentialsStep context={stripeContext()} helpers={helpers} />);
    fireEvent.change(screen.getByLabelText("Secret key"), {
      target: { value: "sk_test_x" },
    });

    await expectFocusOnEachFailure(
      "stripe-wizard-credentials-error",
      "Stripe rejected the key.",
      () => screen.getByRole("button", { name: /save keys/i }),
    );
  });

  it("focuses a failed signing-secret save", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => failingWrite("Secret not stored.")));
    render(<StripeWebhookStep context={stripeContext()} helpers={helpers} />);
    fireEvent.change(screen.getByLabelText("Signing secret"), {
      target: { value: "whsec_x" },
    });

    await expectFocusOnEachFailure(
      "stripe-wizard-webhook-error",
      "Secret not stored.",
      () => screen.getByRole("button", { name: /save signing secret/i }),
    );
  });
});

describe("Google setup wizard", () => {
  it("focuses a failed credential save, and focuses it again when it repeats", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => failingWrite("Client ID refused.")));
    render(<GoogleCredentialsStep context={googleContext()} helpers={helpers} />);
    fireEvent.change(screen.getByLabelText("Client ID"), {
      target: { value: "id.apps.googleusercontent.com" },
    });

    await expectFocusOnEachFailure(
      "google-wizard-credentials-error",
      "Client ID refused.",
      () => screen.getByRole("button", { name: /credentials/i }),
    );
  });

  it("focuses a verification that could not start, and focuses it again when it repeats", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => failingWrite("Verification is busy.")));
    render(<GoogleVerifyStep context={googleContext()} helpers={helpers} />);

    await expectFocusOnEachFailure(
      "google-wizard-verify-error",
      "Verification is busy.",
      () => screen.getByRole("button", { name: /verify with google/i }),
    );
  });

  it("leaves focus alone when the page arrives with a failed verification", async () => {
    navigation.search = "googleVerifyError=1";
    vi.stubGlobal("fetch", vi.fn());
    render(<GoogleVerifyStep context={googleContext()} helpers={helpers} />);

    expect(
      screen.getByText("Verification couldn't be completed"),
    ).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(document.body));
    expect(document.getElementById("google-wizard-verify-error")).toBeEmptyDOMElement();
  });
});

describe("Xero setup wizard", () => {
  it("focuses a failed credential save, and focuses it again when it repeats", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => failingWrite("Secret refused.")));
    render(<XeroCredentialsStep context={xeroContext()} helpers={helpers} />);
    fireEvent.change(screen.getByLabelText(/client secret/i), {
      target: { value: "secret" },
    });

    await expectFocusOnEachFailure(
      "xero-wizard-credentials-error",
      "Secret refused.",
      () => screen.getByRole("button", { name: /credentials/i }),
    );
  });

  it("focuses a failed webhook-key save, and focuses it again when it repeats", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => failingWrite("Webhook key refused.")));
    render(<XeroWebhooksStep context={xeroContext()} helpers={helpers} />);
    fireEvent.change(screen.getByLabelText(/webhooks key/i), {
      target: { value: "key" },
    });

    await expectFocusOnEachFailure(
      "xero-wizard-webhook-error",
      "Webhook key refused.",
      () => screen.getByRole("button", { name: /save/i }),
    );
  });

  it("shows a failed connection-status read without moving focus", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })),
    );
    render(<XeroConnectStep context={xeroContext()} helpers={helpers} />);

    expect(
      await screen.findByText("Failed to load Xero connection status"),
    ).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(document.body));
    expect(document.getElementById("xero-wizard-disconnect-error")).toBeEmptyDOMElement();
  });

  it("focuses a failed disconnect, and focuses it again when it repeats", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) =>
        init?.method === "POST"
          ? { ok: false, status: 500, json: async () => ({}) }
          : {
              ok: true,
              json: async () => ({
                connected: true,
                needsReentry: false,
                tenantId: "tenant-1",
                tokenExpiresAt: null,
              }),
            },
      ),
    );
    vi.stubGlobal("confirm", vi.fn(() => true));
    render(<XeroConnectStep context={xeroContext()} helpers={helpers} />);
    const disconnect = await screen.findByRole("button", { name: "Disconnect Xero" });
    const alert = document.getElementById("xero-wizard-disconnect-error");

    for (let attempt = 0; attempt < 2; attempt += 1) {
      disconnect.focus();
      fireEvent.click(disconnect);
      fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
      await waitFor(() => expect(alert).toHaveTextContent("Failed to disconnect Xero"));
      await expectRecoveryAlertToHoldFocus(alert);
    }
  });
});
