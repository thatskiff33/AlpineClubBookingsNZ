// @vitest-environment jsdom

import { useEffect } from "react";
import type { ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IntegrationWizard } from "../integration-wizard";
import type { WizardStepConfig } from "../types";
import { ViewOnlyActionButton } from "@/components/admin/view-only-action";
import { ADMIN_VIEW_ONLY_ACTION_REASON } from "@/hooks/use-admin-area-edit-access";

interface Ctx {
  bReady: boolean;
  cReady: boolean;
}

function steps(): WizardStepConfig<Ctx>[] {
  return [
    {
      id: "a",
      title: "Step A",
      isVerified: () => true, // instructions step — never blocks
      render: () => <div>Step A body</div>,
    },
    {
      id: "b",
      title: "Step B",
      isVerified: (ctx) => ctx.bReady,
      render: () => <div>Step B body</div>,
    },
    {
      id: "c",
      title: "Step C",
      isVerified: (ctx) => ctx.cReady,
      render: () => <div>Step C body</div>,
    },
  ];
}

// Per-test persisted cursor; null = fresh run (no saved progress).
let mockedProgress: {
  currentStepId?: string;
  completedStepIds?: string[];
} | null = null;

beforeEach(() => {
  mockedProgress = null;
  // Cursor GET returns the configured persisted progress; POST is a no-op success.
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET") {
      return {
        ok: true,
        json: async () => ({ wizardId: "test", progress: mockedProgress }),
      } as Response;
    }
    return { ok: true, json: async () => ({ ok: true }) } as Response;
  }) as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderWizard(context: Ctx) {
  return render(
    <IntegrationWizard<Ctx>
      wizardId="test"
      title="Test wizard"
      steps={steps()}
      context={context}
      contextLoading={false}
      onRefresh={() => {}}
      canEdit={true}
      viewOnlyBanner={<>view only</>}
    />,
  );
}

/**
 * Wait for the wizard to open on `bodyText`, then let the shell settle.
 *
 * The commit that paints an interactive wizard and the effect that settles its
 * resume step are two separate React steps, and `waitFor` can return between
 * them (#2781). Every case below that clicks after opening means to exercise
 * ordinary navigation, so flush the pending effect first instead of leaving that
 * order to chance — clicking BEFORE the shell settles has its own test.
 */
async function openedAt(bodyText: string) {
  await screen.findByText(bodyText);
  // One macrotask turn inside act(): React's pending passive effects run, then
  // act flushes whatever they queued.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("IntegrationWizard gating (#2080)", () => {
  it("starts a FIRST run at step one even when it verifies trivially", async () => {
    // Step A is an always-verified instructions step; without a persisted
    // cursor the wizard must still open on it, not auto-advance past the
    // guide (the #2080 E2E caught exactly this).
    renderWizard({ bReady: false, cReady: false });
    await waitFor(() => {
      expect(screen.getByText("Step A body")).toBeTruthy();
    });
  });

  it("resumes at the persisted cursor, clamped to the reachable range", async () => {
    mockedProgress = { currentStepId: "b" };
    renderWizard({ bReady: false, cReady: false });
    await waitFor(() => {
      expect(screen.getByText("Step B body")).toBeTruthy();
    });
  });

  it("gates Continue on the current step verifying", async () => {
    const { rerender } = renderWizard({ bReady: false, cReady: false });

    // Fresh run opens on A; B is reachable (A verified) — walk forward to it.
    await openedAt("Step A body");
    fireEvent.click(screen.getByRole("button", { name: /Step B/ }));
    await waitFor(() => {
      expect(screen.getByText("Step B body")).toBeTruthy();
    });
    const continueBtn = screen.getByRole("button", { name: "Continue" });
    expect((continueBtn as HTMLButtonElement).disabled).toBe(true);

    // The gated step C is not reachable yet (its stepper entry is disabled).
    const stepCButton = screen.getByRole("button", { name: /Step C/ });
    expect((stepCButton as HTMLButtonElement).disabled).toBe(true);

    // Once B verifies, Continue enables.
    rerender(
      <IntegrationWizard<Ctx>
        wizardId="test"
        title="Test wizard"
        steps={steps()}
        context={{ bReady: true, cReady: false }}
        contextLoading={false}
        onRefresh={() => {}}
        canEdit={true}
        viewOnlyBanner={<>view only</>}
      />,
    );
    await waitFor(() => {
      expect(
        (screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    });
  });

  it("shows the completion state when every step is verified", async () => {
    renderWizard({ bReady: true, cReady: true });
    await waitFor(() => {
      expect(screen.getByText(/Setup complete/i)).toBeTruthy();
    });
  });

  it("uses provider completion copy when supplied (never 'the whole thing is done')", async () => {
    render(
      <IntegrationWizard<Ctx>
        wizardId="test"
        title="Test wizard"
        steps={steps()}
        context={{ bReady: true, cReady: true }}
        contextLoading={false}
        onRefresh={() => {}}
        canEdit={true}
        viewOnlyBanner={<>view only</>}
        completion={{
          badgeLabel: "Connected",
          message: "Connected",
          hint: "Configure mappings below to finish.",
        }}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText(/Configure mappings below/i)).toBeTruthy();
    });
    expect(screen.queryByText(/Setup complete/i)).toBeNull();
  });
});

interface OptCtx {
  bVerified: boolean;
}

function optionalSteps(): WizardStepConfig<OptCtx>[] {
  return [
    {
      id: "a",
      title: "Step A",
      isVerified: () => true,
      render: () => <div>Step A body</div>,
    },
    {
      id: "b",
      title: "Step B",
      // Optional + unverified ⇒ skippable via the shell's skip action.
      optional: { skipLabel: "Skip B for now", skipDescription: "Do it later." },
      isVerified: (ctx) => ctx.bVerified,
      render: () => <div>Step B body</div>,
    },
    {
      id: "c",
      title: "Step C",
      isVerified: () => true,
      render: () => <div>Step C body</div>,
    },
  ];
}

function renderOptional(context: OptCtx, steps = optionalSteps()) {
  return render(
    <IntegrationWizard<OptCtx>
      wizardId="test"
      title="Test wizard"
      steps={steps}
      context={context}
      contextLoading={false}
      onRefresh={() => {}}
      canEdit={true}
      viewOnlyBanner={<>view only</>}
    />,
  );
}

describe("IntegrationWizard optional-step skip (#2080 UX-F1)", () => {
  it("skips an optional unverified step, which advances past the gate", async () => {
    renderOptional({ bVerified: false });

    // Fresh run opens on A; walk to the optional step B, which is gated
    // (Continue is not offered on an unpassed non-last step) but offers
    // the shell's provider-labelled skip action.
    await openedAt("Step A body");
    fireEvent.click(screen.getByRole("button", { name: /Step B/ }));
    await waitFor(() => {
      expect(screen.getByText("Step B body")).toBeTruthy();
    });
    const skip = screen.getByRole("button", { name: "Skip B for now" });
    expect(skip).toBeTruthy();

    fireEvent.click(skip);

    // Skipping acknowledges B and advances to C (now reachable).
    await waitFor(() => {
      expect(screen.getByText("Step C body")).toBeTruthy();
    });
    // The skipped step is marked "Skipped for now" in the stepper (amber state).
    expect(screen.getByText(/Skipped for now/i)).toBeTruthy();
  });

  it("clears the skipped (amber) state once the step later verifies", async () => {
    const { rerender } = renderOptional({ bVerified: false });
    await openedAt("Step A body");
    fireEvent.click(screen.getByRole("button", { name: /Step B/ }));
    await waitFor(() => screen.getByText("Step B body"));
    fireEvent.click(screen.getByRole("button", { name: "Skip B for now" }));
    await waitFor(() => expect(screen.getByText(/Skipped for now/i)).toBeTruthy());

    // B now verifies (verified > acknowledged): the amber "skipped" note clears.
    rerender(
      <IntegrationWizard<OptCtx>
        wizardId="test"
        title="Test wizard"
        steps={optionalSteps()}
        context={{ bVerified: true }}
        contextLoading={false}
        onRefresh={() => {}}
        canEdit={true}
        viewOnlyBanner={<>view only</>}
      />,
    );
    await waitFor(() => {
      expect(screen.queryByText(/Skipped for now/i)).toBeNull();
    });
  });

  it("never offers a skip action for a required unverified step", async () => {
    // Reuse the standard steps() where B is required + unverified.
    renderWizard({ bReady: false, cReady: false });
    await openedAt("Step A body");
    fireEvent.click(screen.getByRole("button", { name: /Step B/ }));
    await waitFor(() => screen.getByText("Step B body"));
    expect(screen.queryByRole("button", { name: /skip/i })).toBeNull();
  });
});

describe("IntegrationWizard focus management (#2080 UX-F3)", () => {
  it("does not steal focus on the initial resume render", async () => {
    mockedProgress = { currentStepId: "c" };
    renderOptional({ bVerified: true });
    await openedAt("Step C body");
    // Focus was not yanked to the step container on mount.
    expect((document.activeElement as HTMLElement)?.tagName).not.toBe(
      undefined,
    );
    expect(document.activeElement).toBe(document.body);
  });

  it("moves focus to the new step container on a step change", async () => {
    mockedProgress = { currentStepId: "c" };
    renderOptional({ bVerified: true });
    await openedAt("Step C body");

    // Jump to Step A via its (reachable) stepper button.
    fireEvent.click(screen.getByRole("button", { name: /Step A/ }));

    await waitFor(() => {
      const active = document.activeElement as HTMLElement | null;
      expect(active?.getAttribute("tabindex")).toBe("-1");
      expect(active?.textContent).toContain("Step A body");
    });
  });
});

// ---------------------------------------------------------------------------
// #2781 — a step the operator clicked before the shell settled must survive.
//
// The defect was a race, so this does NOT race it. The order is pinned:
//
//  - the cursor GET is held open, so the test decides exactly when the saved
//    progress resolves;
//  - the click is dispatched from the step body's own mount effect. React
//    flushes a child's effects BEFORE its parent's, so the navigation is
//    guaranteed to land in the window between the wizard painting a clickable
//    stepper and the shell's initialisation effect running.
//
// That window is NOT "while `wizard-progress` is in flight" — the shell renders
// a spinner until `cursor.loaded`, so no stepper button exists to click. It is
// the React turn AFTER the GET resolves: `loaded`, `persistedStepId` and
// `acknowledged` batch into one commit, that commit paints an interactive
// stepper, and the init effect placing the cursor is flushed after it. So the
// window's length is main-thread scheduling, not network latency — which is
// exactly why it fired under contended CI load and never locally.
//
// This ordering failed three times in CI and was written off as a flake each
// time (#2738, #2775 twice). Nothing here depends on timing: revert the fix and
// it fails every run.
// ---------------------------------------------------------------------------

/**
 * A one-shot permit. The click must happen exactly once even if the step body
 * remounts — without the fix the wizard snaps back to step one and remounts it,
 * and a second click would then land after initialisation and hide the defect.
 */
function clickPermit() {
  let taken = false;
  return {
    get taken() {
      return taken;
    },
    take() {
      if (taken) return false;
      taken = true;
      return true;
    },
  };
}

/** Clicks a stepper button once, from inside a step body's mount effect. */
function ClickStepOnMount({
  label,
  permit,
  children,
}: {
  label: RegExp;
  permit: { take: () => boolean };
  children: ReactNode;
}) {
  useEffect(() => {
    if (!permit.take()) return;
    // A native dispatch rather than fireEvent: this runs while React is already
    // flushing effects, and the point is to queue the operator's navigation
    // there, not to open a nested act() scope around it.
    screen.getByRole("button", { name: label }).click();
  }, [label, permit]);
  return <>{children}</>;
}

describe("IntegrationWizard cursor race (#2781)", () => {
  function racingSteps(permit: {
    take: () => boolean;
  }): WizardStepConfig<Ctx>[] {
    return [
      {
        id: "a",
        title: "Step A",
        isVerified: () => true,
        render: () => (
          <ClickStepOnMount label={/Step B/} permit={permit}>
            <div>Step A body</div>
          </ClickStepOnMount>
        ),
      },
      {
        id: "b",
        title: "Step B",
        isVerified: (ctx) => ctx.bReady,
        render: () => <div>Step B body</div>,
      },
      {
        id: "c",
        title: "Step C",
        isVerified: (ctx) => ctx.cReady,
        render: () => <div>Step C body</div>,
      },
    ];
  }

  /**
   * Hold the cursor GET open. The returned function releases it and flushes the
   * render + effects it triggers, so the whole race happens inside one await.
   */
  function deferCursorLoad() {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    global.fetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if ((init?.method ?? "GET") === "GET") {
          await gate;
          return {
            ok: true,
            json: async () => ({ wizardId: "test", progress: mockedProgress }),
          } as Response;
        }
        return { ok: true, json: async () => ({ ok: true }) } as Response;
      },
    ) as unknown as typeof fetch;
    return async () => {
      await act(async () => {
        release?.();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    };
  }

  function renderRacing(
    permit: { take: () => boolean },
    initialStepId?: string,
  ) {
    return render(
      <IntegrationWizard<Ctx>
        wizardId="test"
        title="Test wizard"
        steps={racingSteps(permit)}
        context={{ bReady: false, cReady: false }}
        contextLoading={false}
        onRefresh={() => {}}
        canEdit={true}
        viewOnlyBanner={<>view only</>}
        initialStepId={initialStepId}
      />,
    );
  }

  // The premise every explanation of this defect rests on, pinned so the
  // explanations cannot drift back to the wrong one. The window is NOT "the GET
  // is in flight": while it is, there is no stepper at all, so there is nothing
  // to click. Make the stepper render during loading and this fails — which is
  // the signal to revisit the changelog, `docs/guides/display.md` and
  // `docs/xero/ARCHITECTURE.md`, because the window they describe would change.
  it("shows NO clickable stepper at all while the cursor GET is in flight", async () => {
    const releaseCursor = deferCursorLoad();
    render(
      <IntegrationWizard<Ctx>
        wizardId="test"
        title="Test wizard"
        steps={steps()}
        context={{ bReady: false, cReady: false }}
        contextLoading={false}
        onRefresh={() => {}}
        canEdit={true}
        viewOnlyBanner={<>view only</>}
      />,
    );

    // Not "step B is unreachable" — no step button exists in any state, not
    // even the always-reachable first one, and no step body has rendered.
    expect(screen.queryByRole("button", { name: /Step A/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Step B/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Step C/ })).toBeNull();
    expect(screen.queryByText("Step A body")).toBeNull();

    await releaseCursor();

    // The stepper only becomes clickable once the saved position has arrived,
    // so the race window can only open after that.
    expect(screen.getByRole("button", { name: /Step A/ })).toBeTruthy();
    expect(screen.getByText("Step A body")).toBeTruthy();
  });

  it("keeps a step clicked before a FIRST-RUN cursor is applied", async () => {
    const releaseCursor = deferCursorLoad();
    const clicked = clickPermit();
    renderRacing(clicked);

    // Nothing to click yet: the wizard is still waiting on the saved cursor.
    expect(screen.queryByRole("button", { name: /Step B/ })).toBeNull();

    await releaseCursor();

    // The click really did land before the shell settled...
    expect(clicked.taken).toBe(true);
    // ...and it was not discarded: no snap back to step one.
    expect(screen.getByText("Step B body")).toBeTruthy();
    expect(screen.queryByText("Step A body")).toBeNull();
    // The shell agrees, not just the body.
    expect(screen.getByText("Step 2 of 3")).toBeTruthy();
    // Focus followed the click, exactly as it does for any other stepper click.
    // This is the one case where the operator's own placement is the FIRST one
    // the focus effect ever sees, so it is the only test that pins the
    // `owner === "operator"` arm of that first-observation branch: a resume
    // first-observation must stay silent (see "does not steal focus on the
    // initial resume render"), but this one must not.
    const active = document.activeElement as HTMLElement | null;
    expect(active?.getAttribute("tabindex")).toBe("-1");
    expect(active?.textContent).toContain("Step B body");
  });

  // Clicking the step you are ALREADY on is how an operator says "stay here",
  // and before initialisation it is the only thing standing between them and a
  // persisted cursor that moves them. So `goTo` must claim ownership even when
  // the index does not change: add an `if (clamped === index) return;` fast path
  // and this fails, because the resume then still wins.
  it("keeps the ALREADY-ACTIVE step when that is what the operator clicked", async () => {
    mockedProgress = { currentStepId: "b" };
    const releaseCursor = deferCursorLoad();
    const clicked = clickPermit();
    // Step A is the pre-initialisation index, and Step A is what gets clicked.
    render(
      <IntegrationWizard<Ctx>
        wizardId="test"
        title="Test wizard"
        steps={[
          {
            id: "a",
            title: "Step A",
            isVerified: () => true,
            render: () => (
              <ClickStepOnMount label={/Step A/} permit={clicked}>
                <div>Step A body</div>
              </ClickStepOnMount>
            ),
          },
          ...steps().slice(1),
        ]}
        context={{ bReady: false, cReady: false }}
        contextLoading={false}
        onRefresh={() => {}}
        canEdit={true}
        viewOnlyBanner={<>view only</>}
      />,
    );

    await releaseCursor();

    expect(clicked.taken).toBe(true);
    // The persisted cursor says "b"; the operator said "a" first, so a wins.
    expect(screen.getByText("Step A body")).toBeTruthy();
    expect(screen.queryByText("Step B body")).toBeNull();
    expect(screen.getByText("Step 1 of 3")).toBeTruthy();
  });

  it("keeps a step clicked before a PERSISTED cursor is applied", async () => {
    mockedProgress = { currentStepId: "a" };
    const releaseCursor = deferCursorLoad();
    const clicked = clickPermit();
    renderRacing(clicked);

    await releaseCursor();

    expect(clicked.taken).toBe(true);
    expect(screen.getByText("Step B body")).toBeTruthy();
    expect(screen.queryByText("Step A body")).toBeNull();
  });

  it("keeps a step clicked before a ?step= DEEP LINK is applied", async () => {
    const releaseCursor = deferCursorLoad();
    const clicked = clickPermit();
    renderRacing(clicked, "a");

    await releaseCursor();

    expect(clicked.taken).toBe(true);
    expect(screen.getByText("Step B body")).toBeTruthy();
  });

  it("still resumes a deep link, clamped, when nobody clicks first", async () => {
    // Same held-open cursor, no click: the deep link to the gated step C is
    // clamped back to the furthest reachable step (B), exactly as before.
    const releaseCursor = deferCursorLoad();
    render(
      <IntegrationWizard<Ctx>
        wizardId="test"
        title="Test wizard"
        steps={steps()}
        context={{ bReady: false, cReady: false }}
        contextLoading={false}
        onRefresh={() => {}}
        canEdit={true}
        viewOnlyBanner={<>view only</>}
        initialStepId="c"
      />,
    );

    await releaseCursor();

    expect(screen.getByText("Step B body")).toBeTruthy();
    expect(screen.queryByText("Step C body")).toBeNull();
  });

  it("still opens a first run on step one when nobody clicks first", async () => {
    const releaseCursor = deferCursorLoad();
    render(
      <IntegrationWizard<Ctx>
        wizardId="test"
        title="Test wizard"
        steps={steps()}
        context={{ bReady: false, cReady: false }}
        contextLoading={false}
        onRefresh={() => {}}
        canEdit={true}
        viewOnlyBanner={<>view only</>}
      />,
    );

    await releaseCursor();

    // Step A verifies trivially, but a first run must still see it (#2080).
    expect(screen.getByText("Step A body")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// #2324 — the shell's view-only vouch, checked BEHAVIOURALLY.
//
// `view-only-banner-contract.test.ts` proves the same property statically, by
// reading this file's source. This is deliberately independent of that: it
// renders the real shell and looks at what a view-only admin actually gets, so
// a bug in the static analysis cannot make the guarantee vacuous.
//
// Three things, and all three are the vouch:
//
//  - the banner is mounted in EVERY branch, the loading one included, because
//    that is the promise the flag makes on the shell's behalf;
//  - the helpers really carry `ancestorRendersViewOnlyBanner === true`, so a
//    step reading it gets a vouch rather than `undefined`;
//  - a step control that uses the vouch drops its per-button reason and STAYS
//    DISABLED, while the same control without it keeps the reason. Gating never
//    depends on the flag; only who states the reason does.
// ---------------------------------------------------------------------------

describe("IntegrationWizard view-only vouch (#2324)", () => {
  function vouchSteps(seen: { value?: unknown }): WizardStepConfig<Ctx>[] {
    return [
      {
        id: "a",
        title: "Step A",
        isVerified: () => true,
        render: (_ctx, helpers) => {
          seen.value = helpers.ancestorRendersViewOnlyBanner;
          return (
            <div>
              {/* TEST-ONLY shape. A real step body takes the vouch as a prop
                  defaulting to false and writes `describeReason={!prop}`; the
                  contract test rejects reading it straight off `helpers` like
                  this (test files are outside its scan). Inlined here so this
                  case depends on nothing but the shell. */}
              <ViewOnlyActionButton
                canEdit={helpers.canEdit}
                describeReason={!helpers.ancestorRendersViewOnlyBanner}
              >
                Vouched action
              </ViewOnlyActionButton>
              <ViewOnlyActionButton canEdit={helpers.canEdit}>
                Self-explaining action
              </ViewOnlyActionButton>
            </div>
          );
        },
      },
    ];
  }

  function renderVouchWizard(seen: { value?: unknown }, loading: boolean) {
    return render(
      <IntegrationWizard<Ctx>
        wizardId="test"
        title="Test wizard"
        steps={vouchSteps(seen)}
        context={{ bReady: true, cReady: true }}
        contextLoading={loading}
        onRefresh={() => {}}
        canEdit={false}
        viewOnlyBanner={<>you can look at this wizard</>}
      />,
    );
  }

  it("mounts the banner in the LOADING branch, before any step body exists", () => {
    // No step body yet, but the live region is already registered and already
    // saying why — that is what the vouch promises every step.
    renderVouchWizard({}, true);
    expect(screen.getByTestId("admin-view-only-banner")).toBeTruthy();
    expect(screen.getByText(/you can look at this wizard/i)).toBeTruthy();
  });

  it("still mounts the banner once the step body is on screen", async () => {
    renderVouchWizard({}, false);
    await waitFor(() => screen.getByText("Vouched action"));
    expect(screen.getByTestId("admin-view-only-banner")).toBeTruthy();
    expect(screen.getByText(/you can look at this wizard/i)).toBeTruthy();
  });

  it("hands each step a literal true vouch", async () => {
    const seen: { value?: unknown } = {};
    renderVouchWizard(seen, false);
    await waitFor(() => screen.getByText("Vouched action"));
    expect(seen.value).toBe(true);
  });

  it("lets a step drop its own reason without dropping the gate", async () => {
    const seen: { value?: unknown } = {};
    renderVouchWizard(seen, false);

    const vouched = (await screen.findByRole("button", {
      name: /^Vouched action$/,
    })) as HTMLButtonElement;
    const unvouched = (await screen.findByRole("button", {
      name: /Self-explaining action/i,
    })) as HTMLButtonElement;

    // Gating is identical; only the explanation moved.
    expect(vouched.disabled).toBe(true);
    expect(unvouched.disabled).toBe(true);

    expect(vouched.getAttribute("title")).toBeNull();
    expect(vouched.getAttribute("aria-describedby")).toBeNull();

    expect(unvouched.getAttribute("title")).toBe(ADMIN_VIEW_ONLY_ACTION_REASON);
    const describedBy = unvouched.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy ?? "")?.textContent).toBe(
      ADMIN_VIEW_ONLY_ACTION_REASON,
    );
  });
});
