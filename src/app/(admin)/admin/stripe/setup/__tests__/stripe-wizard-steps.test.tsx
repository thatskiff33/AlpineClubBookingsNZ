// @vitest-environment jsdom

import { render, screen, cleanup } from "@/lib/__tests__/support/club-time-render";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CredentialsStep, WebhookStep } from "../stripe-wizard-steps";
import type { StripeWizardContext } from "../use-stripe-wizard-context";
import type { WizardStepHelpers } from "@/components/admin/integration-wizard";
import { ADMIN_FULL_ADMIN_ONLY_ACTION_REASON } from "@/hooks/use-admin-area-edit-access";

/*
  #2324 — the Full-Admin notices in these steps must be TRI-STATE.

  `isFullAdmin` is derived from `useSession()`, not from the wizard's own fetch,
  and the shell renders a step as soon as its CONTEXT loads. Reading an
  unresolved session as `false` therefore showed "Only a Full Admin can…" and
  then removed it again for an actual Full Admin. The flag is tri-state, so
  `undefined` must render neutrally: no notice, no per-button reason, and the
  action still disabled — never an enabled control offered to someone who may not
  have the permission (`use-admin-area-edit-access.ts`).

  The Xero equivalent lives in `../../xero/setup/__tests__`; the Google one in
  `../../google/setup/__tests__`.
*/

function makeContext(
  overrides: Partial<StripeWizardContext> = {},
): StripeWizardContext {
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
    needsReentry: false,
    webhookVerified: false,
    ...overrides,
  };
}

const helpers: WizardStepHelpers = {
  canEdit: true,
  refresh: vi.fn(),
  goNext: vi.fn(),
  isVerified: false,
  optional: false,
  acknowledged: false,
  skip: vi.fn(),
  // Required, and typed as the literal `true` (#2324): the shell always renders
  // the view-only banner above a step body.
  ancestorRendersViewOnlyBanner: true,
};

// Each notice reads `Only a <strong>Full Admin</strong> can …`, so the sentence
// spans three nodes; match the tail, which is one text node.
const KEYS_NOTICE_RE = /can enter or replace Stripe keys/i;
const SECRET_NOTICE_RE = /can enter the signing secret/i;

afterEach(() => cleanup());

describe("Stripe CredentialsStep Full-Admin notice is tri-state (#2324)", () => {
  it("shows the notice only once the session says NOT a Full Admin", () => {
    render(
      <CredentialsStep
        context={makeContext({ isFullAdmin: false })}
        helpers={helpers}
      />,
    );
    expect(screen.getByText(KEYS_NOTICE_RE)).toBeTruthy();
    // …and the button states the same narrower permission, because an admin
    // with finance edit but no Full Admin meets no banner at all.
    expect(
      screen
        .getByRole("button", { name: /save keys/i })
        .getAttribute("title"),
    ).toBe(ADMIN_FULL_ADMIN_ONLY_ACTION_REASON);
  });

  it("shows no notice, and no reason, while the session is still resolving", () => {
    render(
      <CredentialsStep
        context={makeContext({ isFullAdmin: undefined })}
        helpers={helpers}
      />,
    );
    expect(screen.queryByText(KEYS_NOTICE_RE)).toBeNull();
    const save = screen.getByRole("button", {
      name: /save keys/i,
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(save.getAttribute("title")).toBeNull();
    expect(
      (screen.getByLabelText(/Secret key/i) as HTMLInputElement).disabled,
    ).toBe(true);
  });

  it("shows no notice for a resolved Full Admin", () => {
    render(<CredentialsStep context={makeContext()} helpers={helpers} />);
    expect(screen.queryByText(KEYS_NOTICE_RE)).toBeNull();
    expect(
      (screen.getByLabelText(/Secret key/i) as HTMLInputElement).disabled,
    ).toBe(false);
  });
});

describe("Stripe WebhookStep Full-Admin notice is tri-state (#2324)", () => {
  it("shows the notice only once the session says NOT a Full Admin", () => {
    render(
      <WebhookStep
        context={makeContext({ isFullAdmin: false })}
        helpers={helpers}
      />,
    );
    expect(screen.getByText(SECRET_NOTICE_RE)).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: /save signing secret/i })
        .getAttribute("title"),
    ).toBe(ADMIN_FULL_ADMIN_ONLY_ACTION_REASON);
  });

  it("shows no notice, and no reason, while the session is still resolving", () => {
    render(
      <WebhookStep
        context={makeContext({ isFullAdmin: undefined })}
        helpers={helpers}
      />,
    );
    expect(screen.queryByText(SECRET_NOTICE_RE)).toBeNull();
    const save = screen.getByRole("button", {
      name: /save signing secret/i,
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(save.getAttribute("title")).toBeNull();
    expect(
      (screen.getByLabelText(/Signing secret/i) as HTMLInputElement).disabled,
    ).toBe(true);
  });

  it("shows no notice for a resolved Full Admin", () => {
    render(<WebhookStep context={makeContext()} helpers={helpers} />);
    expect(screen.queryByText(SECRET_NOTICE_RE)).toBeNull();
    expect(
      (screen.getByLabelText(/Signing secret/i) as HTMLInputElement).disabled,
    ).toBe(false);
  });
});
