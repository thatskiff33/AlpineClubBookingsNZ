// The recovery-alert focus contract, as a single assertion (#2597, #2635).
//
// Eighteen admin and member surfaces render a permanently mounted `role="alert"`
// that a failed action populates and then takes focus, so a keyboard or
// screen-reader user is not left on a control that has just been re-enabled while
// the explanation appears somewhere else on the page. Sixteen of them use
// `src/components/focused-action-error.tsx`; `policy-exception-requests-panel.tsx`
// and `roster-editor.tsx` call the same failure primitive through
// `useActionAttention`. All of them focus through `src/hooks/use-scroll-to-feedback.ts`
// (#2934), which is why one assertion fits every surface.
//
// The contract is that the alert HOLDS focus. Two obvious spellings of that are
// both wrong, and this repo has now shipped both of them:
//
//   * A synchronous `expect(document.activeElement).toBe(alert)` taken straight
//     after `await waitFor(() => expect(alert).toHaveTextContent(...))` passes
//     only by luck. Focus is applied in a passive effect, which React flushes in a
//     Scheduler task AFTER the commit that puts the message in the DOM. Measured
//     on this stack: at the mutation-observer checkpoint where `waitFor`'s
//     callback first succeeds, focus had landed in 0 of 30 runs, arriving exactly
//     one event-loop turn later. The assertion survived only because React Testing
//     Library's `asyncWrapper` happens to drain one `setTimeout(0)` before handing
//     control back — a one-turn margin inside a library internal that nothing
//     guarantees. A loaded CI runner is enough to lose it, and `main` went red on
//     a commit that passed on a rerun of the identical SHA.
//
//   * A bare `await waitFor(() => expect(document.activeElement).toBe(alert))` is
//     not the fix either. `waitFor` resolves on the FIRST poll where the condition
//     holds, so focus that lands and is then stolen by a later commit passes it.
//     That is a weaker guarantee than the one being claimed. #2618 relaxed the
//     member-facing waitlist card to this spelling to dodge the race above, and an
//     earlier review recorded that as a finding rather than a fix; the settled
//     re-assertion below is what closes it.
//
// `expectRecoveryAlertToHoldFocus` asserts both halves — focus lands, and it is
// still there once every pending render and effect has settled — so it depends on
// no ordering between React's flush and the test runner's drain.
import { act, waitFor } from "@testing-library/react";
import { expect, vi } from "vitest";

// How many fully settled event-loop turns the alert must still hold focus for
// after receiving it. Two, because the known way to lose it — a closing Radix
// dialog releasing its focus scope — restores focus from a passive effect cleanup
// via its own `setTimeout(0)`, so it lands on the turn after the one that
// populated the alert.
const SETTLED_TURNS = 2;

/**
 * Assert that a permanently mounted recovery alert holds focus.
 *
 * Stronger than a synchronous `activeElement` check (which pins an arbitrary
 * instant chosen by effect-flush ordering) and stronger than a bare `waitFor`
 * (which is satisfied by focus that is immediately stolen).
 */
export async function expectRecoveryAlertToHoldFocus(
  alert: Element | null | undefined,
): Promise<void> {
  if (!alert) {
    throw new Error(
      "expectRecoveryAlertToHoldFocus: the recovery alert element was not found — " +
        "check the id or role the surface renders before asserting focus on it.",
    );
  }

  // Liveness: focus must actually arrive. Waiting for it — rather than asserting
  // it at the instant the message appears — is what stops this depending on
  // whether React's effect flush or the test runner's drain wins the race.
  await waitFor(() => {
    expect(document.activeElement).toBe(alert);
  });

  // Safety: and it must still be there afterwards. This is the half a bare
  // `waitFor` drops.
  for (let turn = 1; turn <= SETTLED_TURNS; turn += 1) {
    await settlePendingReactWork();
    expect(
      document.activeElement,
      `the recovery alert received focus but lost it ${turn} settled event-loop ` +
        "turn(s) later — something re-rendered or released a focus scope and " +
        "moved focus away",
    ).toBe(alert);
  }
}

async function settlePendingReactWork(): Promise<void> {
  // `act` flushes React's own queue; the macrotask inside it is what lets a
  // Scheduler task or a `setTimeout(0)` that was already queued before this call
  // actually land.
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  });
}

// ---------------------------------------------------------------------------
// The reveal contract (#2934), as a fixture and one assertion.
//
// jsdom implements no layout, so `Element.prototype.scrollIntoView` does not
// exist on it at all: a reveal test has to install a spy and take it away
// again. Three files had written that same six-line fixture out verbatim, each
// retyping `{ behavior: "smooth", block: "start" }` — which is the attention
// module's OWN default, not a per-call-site choice. Retyped in every file, a
// changed default goes unnoticed in all of them at once; stated here, it is one
// line to change and every call site re-checks it (`INV-SSOT-001`).
// ---------------------------------------------------------------------------

export type ScrollIntoViewSpy = ReturnType<
  typeof vi.fn<(arg?: boolean | ScrollIntoViewOptions) => void>
>;

/**
 * What `revealEditor` / `scrollToError(…, block: "start")` ask the browser for
 * when the platform states no motion preference. jsdom has no `matchMedia`, so
 * `resolveScrollBehavior` treats it as no preference and returns `"smooth"`.
 */
const REVEAL_OPTIONS: ScrollIntoViewOptions = {
  behavior: "smooth",
  block: "start",
};

/**
 * Install the `scrollIntoView` spy every reveal assertion reads. Call it from a
 * `beforeEach`, and {@link removeScrollIntoViewSpy} from the matching
 * `afterEach` — leaving the stub on the prototype would hand the next file a
 * `scrollIntoView` that silently does nothing.
 */
export function installScrollIntoViewSpy(): ScrollIntoViewSpy {
  const spy = vi.fn<(arg?: boolean | ScrollIntoViewOptions) => void>();
  Element.prototype.scrollIntoView = spy;
  return spy;
}

export function removeScrollIntoViewSpy(): void {
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
}

/**
 * Assert that the shared attention primitive revealed `target`: it holds focus,
 * it is what was scrolled, and it was scrolled exactly `times` times in total.
 *
 * The count is the half that discriminates. Asserting only that a reveal
 * happened cannot tell a reveal driven by an explicit action from one that also
 * fires on every re-render, which is the defect this rule exists to prevent.
 */
export function expectRevealed(
  spy: ScrollIntoViewSpy,
  target: Element | null | undefined,
  { times = 1 }: { times?: number } = {},
): void {
  if (!target) {
    throw new Error(
      "expectRevealed: the reveal target element was not found — check what the " +
        "surface renders before asserting the reveal on it.",
    );
  }
  expect(
    document.activeElement,
    "the revealed region must hold focus, or a keyboard user gets a scroll and " +
      "nothing else",
  ).toBe(target);
  expect(spy).toHaveBeenCalledTimes(times);
  expect(spy.mock.instances[times - 1]).toBe(target);
  expect(spy.mock.calls[times - 1]?.[0]).toEqual(REVEAL_OPTIONS);
}
