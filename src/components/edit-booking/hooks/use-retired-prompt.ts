"use client";

import { useEffect, useState } from "react";

import { hostingCoverageMutationSignature } from "@/lib/hosting-coverage-override-client";

/** A refused save's prompt, bound to the exact proposal it refused. */
export interface RetiredPromptState<TPrompt> {
  prompt: TPrompt;
  proposalSignature: string;
  notifyMemberChoice: boolean | undefined;
}

/**
 * Hold a refused save's prompt only while it still describes the edit on screen.
 *
 * ONE PATTERN, NOT TWO, WHICH IS WHAT `useHostingCoverageLinkedMove`'S OWN
 * DOCBLOCK ASKED FOR AND THEN BROKE. It was a renamed copy of
 * `useHostingCoverageOverride`: the same slot shape, the same render-time
 * comparison, the same effect guard and the same dependency array, differing only
 * in the prompt type and which extra slots the effect clears. This is a
 * correctness rule about never honouring a stale answer, and the copy left behind
 * was the one carrying a PRICE — so a divergence between them would be a member
 * shown a total that had quietly stopped applying (`INV-SSOT-001`).
 *
 * THE PROMPT IS RETIRED THE MOMENT THE PROPOSAL CHANGES. A member who changes
 * their dates after seeing an offer must not be able to submit the old answer.
 * The server would refuse it anyway — its state key is bound to what was shown —
 * but a stale prompt left on screen shows a figure that is no longer true while
 * they decide, so it is cleared locally and they are re-asked.
 *
 * `buildSavePayload` IS CALLED DURING RENDER, never from a dependency array, so
 * its identity is irrelevant and it is deliberately not memoised.
 *
 * `clearAnswer` clears whatever the caller stores BESIDE the prompt — an officer's
 * confirmation and reason, a member's chosen arm. It is called only on the render
 * that retires the prompt: an answer given for one proposal is not an answer for a
 * different one at a different price. Deliberately not memoised either; the effect
 * body is guarded on `state && !stillCurrent`, so re-running it is a no-op.
 *
 * The raw state slot is NOT returned. Callers must read `activeState`, which is
 * null the moment the prompt stops describing the edit on screen; handing out the
 * slot would let a caller render a retired prompt.
 */
export function useRetiredPrompt<TPrompt>(
  buildSavePayload: (notifyMemberChoice?: boolean) => Record<string, unknown>,
  clearAnswer: () => void,
) {
  const [state, setState] = useState<RetiredPromptState<TPrompt> | null>(null);

  const stillCurrent = Boolean(
    state &&
      state.proposalSignature ===
        hostingCoverageMutationSignature(
          buildSavePayload(state.notifyMemberChoice),
        ),
  );
  const activeState = stillCurrent ? state : null;

  useEffect(() => {
    if (state && !stillCurrent) {
      setState(null);
      clearAnswer();
    }
  }, [stillCurrent, state, clearAnswer]);

  return { setState, activeState };
}
