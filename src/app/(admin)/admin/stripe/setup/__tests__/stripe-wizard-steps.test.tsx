// @vitest-environment jsdom

import {
  render,
  screen,
  cleanup,
  fireEvent,
} from "@/lib/__tests__/support/club-time-render";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CredentialsStep, WebhookStep } from "../stripe-wizard-steps";
import {
  credentialsStepVerified,
  type StripeWizardContext,
} from "../use-stripe-wizard-context";
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
    keysNeedReentry: false,
    webhookSecretNeedsReentry: false,
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
  reportSaving: vi.fn(),
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

/*
  #3975 — Stripe's Workbench has no "Send test webhook" button, so the hint
  names the current screen and a fallback that works for a brand-new endpoint
  in either mode. It is shown once, in the not-yet-verified box.
*/
describe("Stripe WebhookStep how-to-verify hint (#3975)", () => {
  const SCREEN = "Workbench → Webhooks (Developers → Webhooks)";
  const FALLBACK_RE = /make a payment \(a test payment in test mode\)/;

  afterEach(() => vi.unstubAllGlobals());

  it("names the current Stripe screen on the link and in the hint", () => {
    render(<WebhookStep context={makeContext()} helpers={helpers} />);
    expect(screen.getByRole("link", { name: SCREEN })).toBeTruthy();
    expect(screen.getByText(FALLBACK_RE).textContent).toContain(SCREEN);
  });

  it("gives the fallback whether or not a signing secret is saved", () => {
    render(
      <WebhookStep
        context={makeContext({
          credentials: {
            secret_key: { set: false, setAt: null },
            publishable_key: { set: false, setAt: null },
            webhook_secret: { set: true, setAt: "2026-07-01T00:00:00.000Z" },
          },
        })}
        helpers={helpers}
      />,
    );
    expect(screen.getAllByText(FALLBACK_RE)).toHaveLength(1);
  });

  it("shows the hint once after a save, not again in the success message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
    );
    render(<WebhookStep context={makeContext()} helpers={helpers} />);
    fireEvent.change(screen.getByLabelText(/Signing secret/i), {
      target: { value: "whsec_new" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save signing secret" }));
    expect((await screen.findByRole("status")).textContent).toBe(
      "Signing secret saved.",
    );
    expect(screen.getAllByText(FALLBACK_RE)).toHaveLength(1);
  });
});

/*
  #4104 — the events the endpoint must send come from the one shared list, so
  the wizard, DEPLOYMENT.md and the dispatcher cannot disagree.
*/
describe("Stripe WebhookStep lists the events to send (#4104)", () => {
  it("shows every event of the shared list, refund.failed among them", async () => {
    const { STRIPE_WEBHOOK_EVENT_TYPES } = await import("@/lib/stripe-webhook-events");
    render(<WebhookStep context={makeContext()} helpers={helpers} />);
    const list = screen.getByRole("list", { name: "Stripe events to send" });
    const shown = Array.from(list.querySelectorAll("code")).map((code) => code.textContent);
    expect(shown).toEqual([...STRIPE_WEBHOOK_EVENT_TYPES]);
    expect(shown).toContain("refund.failed");
  });
});

/*
  #98 — after an auth-secret change, an unreadable webhook secret used to block
  "Enter keys" (Continue disabled) although only the later webhook step can
  replace it, so the wizard deadlocked. Each step now warns about, and blocks
  on, only the credential it captures.
*/
describe("Stripe re-entry is per step (#98)", () => {
  const bothKeysSet = {
    secret_key: { set: true, setAt: "2026-07-01T00:00:00.000Z" },
    publishable_key: { set: true, setAt: "2026-07-01T00:00:00.000Z" },
    webhook_secret: { set: true, setAt: "2026-06-01T00:00:00.000Z" },
  };
  const KEYS_WARNING = /A stored Stripe key can no longer be read/;
  const WEBHOOK_WARNING = /stored signing secret can no longer be read/;

  it("only the webhook secret unreadable: keys step passes and shows no warning; webhook step warns", () => {
    const context = makeContext({
      credentials: bothKeysSet,
      webhookSecretNeedsReentry: true,
    });
    expect(credentialsStepVerified(context)).toBe(true);

    render(<CredentialsStep context={context} helpers={helpers} />);
    expect(screen.queryByText(KEYS_WARNING)).toBeNull();
    cleanup();

    render(<WebhookStep context={context} helpers={helpers} />);
    expect(screen.getByText(WEBHOOK_WARNING)).toBeTruthy();
    expect(
      (screen.getByLabelText("Signing secret") as HTMLInputElement).disabled,
    ).toBe(false);
  });

  it("a key unreadable: keys step blocks and warns, as before", () => {
    const context = makeContext({
      credentials: bothKeysSet,
      keysNeedReentry: true,
    });
    expect(credentialsStepVerified(context)).toBe(false);

    render(<CredentialsStep context={context} helpers={helpers} />);
    expect(screen.getByText(KEYS_WARNING)).toBeTruthy();
    cleanup();

    render(<WebhookStep context={context} helpers={helpers} />);
    expect(screen.queryByText(WEBHOOK_WARNING)).toBeNull();
  });

  it("everything replaced: no warning on either step and the keys step passes", () => {
    const context = makeContext({ credentials: bothKeysSet });
    expect(credentialsStepVerified(context)).toBe(true);

    render(<CredentialsStep context={context} helpers={helpers} />);
    expect(screen.queryByText(KEYS_WARNING)).toBeNull();
    cleanup();

    render(<WebhookStep context={context} helpers={helpers} />);
    expect(screen.queryByText(WEBHOOK_WARNING)).toBeNull();
  });

  it("a key not yet stored still blocks the keys step", () => {
    expect(
      credentialsStepVerified(
        makeContext({
          credentials: { ...bothKeysSet, publishable_key: { set: false, setAt: null } },
        }),
      ),
    ).toBe(false);
  });
});
