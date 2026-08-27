// @vitest-environment jsdom

import { render, screen, cleanup, fireEvent } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectStep } from "../xero-wizard-steps";
import type {
  XeroOrgReadError,
  XeroWizardContext,
} from "../use-xero-wizard-context";
import type { WizardStepHelpers } from "@/components/admin/integration-wizard";

/*
  #2394 — the connect step must never sit on "Confirming the organisation
  name…" for ever.

  Before this, a single transient failure (a Xero 429, a 5xx, a dropped socket)
  left the wizard on that message with no error, no retry, and no way forward:
  the wizard context swallowed the failure in a bare `catch {}`, the org read
  negative-cached for 60 seconds, and the post-OAuth refresh was a one-shot
  mount effect.

  The owner's binding decision was to SHOW the failure and offer a manual Try
  again — deliberately not an automatic retry, which would spend Xero quota
  nobody asked for and, on a rate limit, make things worse. The wording has to
  separate the three things an operator does differently: reconnect, wait, or
  press the button. These tests pin all of that, plus the fourth (client-only)
  case where this site refuses the read because the role has no finance access.

  The hook side — that Try again genuinely re-fetches, bypassing the negative
  cache — is pinned in `use-xero-wizard-context-org-retry.test.tsx`.
*/

function makeContext(
  overrides: Partial<XeroWizardContext> = {},
): XeroWizardContext {
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

function makeHelpers(
  overrides: Partial<WizardStepHelpers> = {},
): WizardStepHelpers {
  return {
    canEdit: true,
    refresh: vi.fn(),
    goNext: vi.fn(),
    isVerified: true,
    optional: false,
    acknowledged: false,
    skip: vi.fn(),
    ancestorRendersViewOnlyBanner: true,
    ...overrides,
  };
}

function failure(overrides: Partial<XeroOrgReadError>): XeroOrgReadError {
  return {
    kind: "unavailable",
    rateLimit: null,
    retryAfterSeconds: null,
    ...overrides,
  };
}

const tryAgain = () => screen.queryByRole("button", { name: /try again/i });

beforeEach(() => {
  // ConnectStep mounts `useXeroConnection`, which reads /api/admin/xero/status.
  // Answer it so the step's own connection-error alert stays empty and these
  // assertions are about the ORGANISATION read only.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        connected: true,
        needsReentry: false,
        tenantId: "tenant-1",
        tokenExpiresAt: null,
      }),
    })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState({}, "", "/admin/xero/setup");
});

describe("ConnectStep: a successful organisation read is unchanged (#2394)", () => {
  it("confirms the organisation by name, with no error and no retry control", () => {
    render(
      <ConnectStep
        context={makeContext({ orgName: "Alpine Sports Club" })}
        helpers={makeHelpers()}
      />,
    );

    expect(screen.getByText(/Alpine Sports Club/)).toBeTruthy();
    expect(screen.getByText(/right Xero organisation/i)).toBeTruthy();
    expect(tryAgain()).toBeNull();
  });

  // The placeholder is still correct while the read is genuinely in flight —
  // what must never happen is settling there.
  it("still shows the interim 'Confirming…' message while nothing has failed", () => {
    render(
      <ConnectStep
        context={makeContext({ orgName: null, orgError: null, orgLoading: true })}
        helpers={makeHelpers()}
      />,
    );

    expect(
      screen.getByText(/Confirming the organisation name/i),
    ).toBeTruthy();
    expect(tryAgain()).toBeNull();
  });
});

describe("ConnectStep: each failure class says something different (#2394)", () => {
  it("tells a disconnected operator to reconnect, and offers no retry", () => {
    render(
      <ConnectStep
        context={makeContext({ orgError: failure({ kind: "disconnected" }) })}
        helpers={makeHelpers()}
      />,
    );

    expect(screen.getByText(/needs re-authorising/i)).toBeTruthy();
    expect(screen.getByText(/Connect again/i)).toBeTruthy();
    // Retrying cannot fix a revoked authorisation; offering the button would
    // teach the operator it does nothing.
    expect(tryAgain()).toBeNull();
    // …and the "Confirming…" placeholder is gone.
    expect(screen.queryByText(/Confirming the organisation name/i)).toBeNull();
  });

  it("tells a daily-limited operator when the limit resets, and offers a retry", () => {
    render(
      <ConnectStep
        context={makeContext({
          orgError: failure({ kind: "rate_limited", rateLimit: "day" }),
        })}
        helpers={makeHelpers()}
      />,
    );

    expect(screen.getByText(/daily limit/i)).toBeTruthy();
    // The owner asked for the reset to be stated in terms a NZ club can act on.
    expect(screen.getByText(/midnight UTC/i)).toBeTruthy();
    expect(screen.getByText(/midday in New Zealand/i)).toBeTruthy();
    expect(tryAgain()).not.toBeNull();
  });

  // Review F7. Xero omits Retry-After on plenty of daily 429s and our retry
  // layer then fabricates 86400, so quoting it produced "resets at midnight UTC
  // … Xero suggests waiting about 24 hours" — two different answers to the one
  // question this class exists to answer. The reset time is the only answer now.
  it("gives ONE answer for the daily limit, even when a Retry-After is present", () => {
    render(
      <ConnectStep
        context={makeContext({
          orgError: failure({
            kind: "rate_limited",
            rateLimit: "day",
            retryAfterSeconds: 86400,
          }),
        })}
        helpers={makeHelpers()}
      />,
    );

    expect(screen.getByText(/midnight UTC/i)).toBeTruthy();
    expect(screen.queryByText(/24 hours/i)).toBeNull();
    expect(screen.queryByText(/suggests waiting/i)).toBeNull();
  });

  it("passes on Xero's Retry-After for a per-minute limit", () => {
    render(
      <ConnectStep
        context={makeContext({
          orgError: failure({
            kind: "rate_limited",
            rateLimit: "minute",
            retryAfterSeconds: 42,
          }),
        })}
        helpers={makeHelpers()}
      />,
    );

    expect(screen.getByText(/limiting how quickly/i)).toBeTruthy();
    expect(screen.getByText(/about 40 seconds/i)).toBeTruthy();
    expect(tryAgain()).not.toBeNull();
  });

  it("treats a transient failure as 'try again now'", () => {
    render(
      <ConnectStep
        context={makeContext({ orgError: failure({ kind: "unavailable" }) })}
        helpers={makeHelpers()}
      />,
    );

    expect(screen.getByText(/could not reach Xero/i)).toBeTruthy();
    expect(tryAgain()).not.toBeNull();
  });

  // Review F7. This kind covers BOTH Xero's own Retry-After and our own
  // process-wide cooldown after repeated failures, and the message cannot tell
  // which — so it must not put words in Xero's mouth.
  it("states a wait without attributing it to Xero", () => {
    render(
      <ConnectStep
        context={makeContext({
          orgError: failure({ kind: "unavailable", retryAfterSeconds: 120 }),
        })}
        helpers={makeHelpers()}
      />,
    );

    expect(screen.getByText(/Give it about 2 minutes/i)).toBeTruthy();
    expect(screen.queryByText(/Xero suggests waiting/i)).toBeNull();
  });

  // Review F6. The old copy vouched for the connection ("Your Xero connection
  // itself is fine; only the name check failed") on branches that had never
  // asked Xero anything — flatly false when the browser is simply offline.
  it("never vouches for the Xero connection on a failure", () => {
    for (const kind of ["unavailable", "check_failed", "signed_out"] as const) {
      cleanup();
      render(
        <ConnectStep
          context={makeContext({ orgError: failure({ kind }) })}
          helpers={makeHelpers()}
        />,
      );
      expect(screen.queryByText(/connection itself is fine/i)).toBeNull();
    }
  });

  it("says we never asked Xero when our own site did not answer", () => {
    render(
      <ConnectStep
        context={makeContext({ orgError: failure({ kind: "check_failed" }) })}
        helpers={makeHelpers()}
      />,
    );

    expect(screen.getByText(/could not check your Xero organisation/i)).toBeTruthy();
    expect(screen.getByText(/nothing was asked of Xero/i)).toBeTruthy();
    // It could be a passing blip on our side, so the button is worth offering.
    expect(tryAgain()).not.toBeNull();
  });

  it("names the permission problem when this site refuses the read", () => {
    render(
      <ConnectStep
        context={makeContext({ orgError: failure({ kind: "forbidden" }) })}
        helpers={makeHelpers()}
      />,
    );

    expect(screen.getByText(/cannot read the Xero organisation details/i)).toBeTruthy();
    expect(screen.getByText(/finance access/i)).toBeTruthy();
    expect(tryAgain()).toBeNull();
  });

  // Review F8. A 401 and a 403 both used to say "ask for finance access", but
  // 401 means the SESSION went — and that is the likelier of the two here,
  // because a plain permission problem fails the status read first and never
  // reaches this branch. The advice and the retry are both different.
  it("tells an operator whose session expired to sign in, and keeps the retry", () => {
    render(
      <ConnectStep
        context={makeContext({ orgError: failure({ kind: "signed_out" }) })}
        helpers={makeHelpers()}
      />,
    );

    expect(screen.getByText(/sign-in has expired/i)).toBeTruthy();
    expect(screen.getByText(/Sign in again/i)).toBeTruthy();
    expect(screen.queryByText(/finance access/i)).toBeNull();
    expect(tryAgain()).not.toBeNull();
  });
});

// Review F4. A failed read still serves the last known summary, so a name can
// arrive ALONGSIDE a failure — and the failure that most often does this is the
// one that matters most: the club revoked the app inside Xero's own
// Connected-apps screen, so our token row still looks healthy and the status
// route still says "connected". Suppressing the failure because a name happened
// to be present rendered that as a green "Connected to <club>" tick, with no
// hint, on the very step whose job is confirming the authorisation.
describe("ConnectStep: a stale name never swallows the failure (#2394)", () => {
  it("shows the reconnect warning even when a cached name came back with it", () => {
    render(
      <ConnectStep
        context={makeContext({
          orgName: "Alpine Sports Club",
          orgError: failure({ kind: "disconnected" }),
        })}
        helpers={makeHelpers()}
      />,
    );

    expect(screen.getByText(/needs re-authorising/i)).toBeTruthy();
  });

  it("presents that name as the last one seen, not as a confirmation", () => {
    const { container } = render(
      <ConnectStep
        context={makeContext({
          orgName: "Alpine Sports Club",
          orgError: failure({ kind: "disconnected" }),
        })}
        helpers={makeHelpers()}
      />,
    );

    expect(screen.getByText(/last organisation we saw/i)).toBeTruthy();
    expect(screen.getByText(/could not re-check/i)).toBeTruthy();
    // …and the unqualified "check this is the right organisation" tick is gone,
    // along with the success styling that made it read as "all set".
    expect(screen.queryByText(/right Xero organisation/i)).toBeNull();
    expect(container.querySelectorAll(".bg-success-3").length).toBe(0);
  });
});

describe("ConnectStep: the failure is announced, not just drawn (#2394)", () => {
  it("renders the explanation inside a live region", () => {
    const { container } = render(
      <ConnectStep
        context={makeContext({ orgError: failure({ kind: "unavailable" }) })}
        helpers={makeHelpers()}
      />,
    );

    const alerts = Array.from(container.querySelectorAll('[role="alert"]'));
    expect(
      alerts.some((node) => /could not reach Xero/i.test(node.textContent ?? "")),
    ).toBe(true);
  });

  // The live-region convention (AGENTS.md): the region is mounted even when
  // empty, so a message injected into it later is actually announced.
  it("keeps the live region mounted while there is nothing to say", () => {
    const { container } = render(
      <ConnectStep context={makeContext({ orgName: "Alpine Sports Club" })} helpers={makeHelpers()} />,
    );

    expect(container.querySelectorAll('[role="alert"]').length).toBeGreaterThan(0);
  });

  // Review F5. A repeat failure of the SAME class used to render byte-identical
  // text: React mutates no DOM node, so the alert region announces nothing at
  // all and the page is visually unchanged. Sharpest on the daily limit, where
  // the wording cannot change for hours and the button therefore looks inert.
  it("changes the message on a repeat failure of the same class", () => {
    const alertText = (container: HTMLElement) =>
      Array.from(container.querySelectorAll('[role="alert"]'))
        .map((node) => node.textContent ?? "")
        .join(" ");

    const first = render(
      <ConnectStep
        context={makeContext({
          orgError: failure({ kind: "rate_limited", rateLimit: "day" }),
          orgErrorAt: Date.parse("2026-07-31T02:32:00.000Z"),
          orgErrorAttempts: 1,
        })}
        helpers={makeHelpers()}
      />,
    );
    const before = alertText(first.container);
    expect(before).toMatch(/Checked once/i);
    cleanup();

    const second = render(
      <ConnectStep
        context={makeContext({
          // Same class, same wording — only the check tally moved.
          orgError: failure({ kind: "rate_limited", rateLimit: "day" }),
          orgErrorAt: Date.parse("2026-07-31T02:33:00.000Z"),
          orgErrorAttempts: 2,
        })}
        helpers={makeHelpers()}
      />,
    );
    const after = alertText(second.container);

    expect(after).toMatch(/Checked 2 times/i);
    expect(after).not.toBe(before);
  });

  it("says nothing about check counts when there is no failure", () => {
    render(
      <ConnectStep
        context={makeContext({ orgName: "Alpine Sports Club" })}
        helpers={makeHelpers()}
      />,
    );

    expect(screen.queryByText(/Checked once/i)).toBeNull();
  });
});

describe("ConnectStep: the Try again control (#2394)", () => {
  it("re-runs the context read, which forces a fresh organisation call", () => {
    const helpers = makeHelpers();
    render(
      <ConnectStep
        context={makeContext({ orgError: failure({ kind: "unavailable" }) })}
        helpers={helpers}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    expect(helpers.refresh).toHaveBeenCalledTimes(1);
  });

  // Review F3 / AGENTS.md / `restore-built-ins.tsx`: the busy state is carried
  // by the label and `aria-busy`, NEVER by `disabled`. `orgLoading` flips in the
  // same turn as the click, so a disabled button cannot keep focus — the browser
  // drops it to <body> and a keyboard or screen-reader operator loses their
  // place in the one state where pressing again is the whole point. Re-entrancy
  // is dropped by the in-flight ref inside `useXeroWizardContext` instead
  // (pinned in `use-xero-wizard-context-org-retry.test.tsx`).
  it("marks itself busy while a read is running, and stays focusable", () => {
    render(
      <ConnectStep
        context={makeContext({
          orgError: failure({ kind: "unavailable" }),
          orgLoading: true,
        })}
        helpers={makeHelpers()}
      />,
    );

    const button = screen.getByRole("button", {
      name: /trying again/i,
    }) as HTMLButtonElement;
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.disabled).toBe(false);

    // Focusable in the literal sense the finding is about: it can still take
    // focus while it works, so focus is never dropped to <body>.
    button.focus();
    expect(document.activeElement).toBe(button);
  });

  it("is offered to a view-only admin, who can still clear a transient failure", () => {
    // The read changes nothing and the wizard already performs it on load for
    // any admin who can open the page, so gating the retry on finance EDIT
    // would strand a view-only admin on an error with no way to clear it.
    render(
      <ConnectStep
        context={makeContext({ orgError: failure({ kind: "unavailable" }) })}
        helpers={makeHelpers({ canEdit: false })}
      />,
    );

    const button = screen.getByRole("button", {
      name: /try again/i,
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });
});

// Review F9. This step renders `useXeroConnection`'s `error`, which is sourced
// from the `?error=` the OAuth callback redirects back with — now in a
// danger-styled box on a second admin page. React escapes it, so this is not
// XSS; it is a phishing surface, and the fix is to enforce the SAME allow-list
// on read that the callback route already enforces on write.
describe("ConnectStep: the OAuth ?error= is allow-listed on read (#2394)", () => {
  it("renders our own callback message verbatim", async () => {
    window.history.replaceState(
      {},
      "",
      "/admin/xero/setup?error=" +
        encodeURIComponent(
          "Invalid Xero OAuth state. Please reconnect from the admin page.",
        ),
    );

    render(<ConnectStep context={makeContext()} helpers={makeHelpers()} />);

    expect(await screen.findByText(/Invalid Xero OAuth state/i)).toBeTruthy();
  });

  it("never renders prose a crafted link supplied", async () => {
    window.history.replaceState(
      {},
      "",
      "/admin/xero/setup?error=" +
        encodeURIComponent(
          "Your Xero account is suspended. Call 0800-000-000 to restore access.",
        ),
    );

    render(<ConnectStep context={makeContext()} helpers={makeHelpers()} />);

    expect(
      await screen.findByText(/Xero connection failed\. Please reconnect/i),
    ).toBeTruthy();
    expect(screen.queryByText(/0800-000-000/)).toBeNull();
  });
});

// The other half of review F3. Keeping Try again enabled means it holds focus
// while it works — but a successful retry removes the whole failure box, so the
// button unmounts under the operator's focus and it would fall to <body> after
// all. The press hands focus to the confirmation it produced instead.
describe("ConnectStep: focus survives a successful retry (#2394)", () => {
  it("moves focus to the confirmation when the failure clears", async () => {
    const helpers = makeHelpers();
    const failing = makeContext({ orgError: failure({ kind: "unavailable" }) });
    const { rerender } = render(
      <ConnectStep context={failing} helpers={helpers} />,
    );

    const button = screen.getByRole("button", { name: /try again/i });
    button.focus();
    fireEvent.click(button);

    // The retry succeeded: the failure box (and its button) unmount.
    rerender(
      <ConnectStep
        context={makeContext({ orgName: "Alpine Sports Club" })}
        helpers={helpers}
      />,
    );

    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.textContent).toMatch(/Alpine Sports Club/);
  });

  it("does not steal focus on an ordinary load", () => {
    render(
      <ConnectStep
        context={makeContext({ orgName: "Alpine Sports Club" })}
        helpers={makeHelpers()}
      />,
    );

    expect(document.activeElement).toBe(document.body);
  });
});
