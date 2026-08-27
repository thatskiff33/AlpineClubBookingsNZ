// @vitest-environment jsdom

import { render, screen, cleanup } from "@/lib/__tests__/support/club-time-render";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CredentialsStep } from "../xero-wizard-steps";
import { WebhooksStep } from "../xero-completion-steps";
import type { XeroWizardContext } from "../use-xero-wizard-context";
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

  The Stripe equivalent lives in `../../stripe/setup/__tests__`; the Google one
  in `../../google/setup/__tests__`.
*/

// `useClubIdentity` (pulled in by the completion-steps module) needs its
// provider; these renders only exercise the webhook step's own copy.
vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ name: "Test Club", bookingsName: "Test Bookings" }),
}));

function makeContext(
  overrides: Partial<XeroWizardContext> = {},
): XeroWizardContext {
  return {
    redirectUri: "https://example.test/api/admin/xero/callback",
    companyUrl: "https://example.test",
    legacyEnvVars: [],
    credentials: {
      client_id: { set: false, setAt: null },
      client_secret: { set: false, setAt: null },
      webhook_key: { set: false, setAt: null },
    },
    isFullAdmin: true,
    connected: false,
    needsReentry: false,
    orgName: null,
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
const CREDENTIALS_NOTICE_RE = /can enter or replace Xero\s+credentials/i;
const WEBHOOK_NOTICE_RE = /can enter or replace the Xero/i;

afterEach(() => cleanup());

describe("Xero CredentialsStep Full-Admin notice is tri-state (#2324)", () => {
  it("shows the notice only once the session says NOT a Full Admin", () => {
    render(
      <CredentialsStep
        context={makeContext({ isFullAdmin: false })}
        helpers={helpers}
      />,
    );
    expect(screen.getByText(CREDENTIALS_NOTICE_RE)).toBeTruthy();
    // …and the button states the same narrower permission, because an admin
    // with finance edit but no Full Admin meets no banner at all.
    expect(
      screen
        .getByRole("button", { name: /save credentials/i })
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
    expect(screen.queryByText(CREDENTIALS_NOTICE_RE)).toBeNull();
    const save = screen.getByRole("button", {
      name: /save credentials/i,
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(save.getAttribute("title")).toBeNull();
    expect(
      (screen.getByLabelText(/Client ID/i) as HTMLInputElement).disabled,
    ).toBe(true);
  });

  it("shows no notice for a resolved Full Admin", () => {
    render(<CredentialsStep context={makeContext()} helpers={helpers} />);
    expect(screen.queryByText(CREDENTIALS_NOTICE_RE)).toBeNull();
    expect(
      (screen.getByLabelText(/Client ID/i) as HTMLInputElement).disabled,
    ).toBe(false);
  });
});

describe("Xero WebhooksStep Full-Admin notice is tri-state (#2324)", () => {
  it("shows the notice only once the session says NOT a Full Admin", () => {
    render(
      <WebhooksStep
        context={makeContext({ isFullAdmin: false })}
        helpers={helpers}
      />,
    );
    expect(screen.getByText(WEBHOOK_NOTICE_RE)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /save key/i }).getAttribute("title"),
    ).toBe(ADMIN_FULL_ADMIN_ONLY_ACTION_REASON);
  });

  it("shows no notice, and no reason, while the session is still resolving", () => {
    render(
      <WebhooksStep
        context={makeContext({ isFullAdmin: undefined })}
        helpers={helpers}
      />,
    );
    expect(screen.queryByText(WEBHOOK_NOTICE_RE)).toBeNull();
    const save = screen.getByRole("button", {
      name: /save key/i,
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(save.getAttribute("title")).toBeNull();
    expect(
      (screen.getByLabelText(/Webhooks key/i) as HTMLInputElement).disabled,
    ).toBe(true);
  });

  it("shows no notice for a resolved Full Admin", () => {
    render(<WebhooksStep context={makeContext()} helpers={helpers} />);
    expect(screen.queryByText(WEBHOOK_NOTICE_RE)).toBeNull();
    expect(
      (screen.getByLabelText(/Webhooks key/i) as HTMLInputElement).disabled,
    ).toBe(false);
  });
});
