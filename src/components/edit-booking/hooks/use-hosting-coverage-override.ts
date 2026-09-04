"use client";

import { useState } from "react";

import {
  useRetiredPrompt,
  type RetiredPromptState,
} from "@/components/edit-booking/hooks/use-retired-prompt";
import type { HostingCoverageOverridePromptData } from "@/lib/hosting-coverage-override-client";

/**
 * The refused save's hosting-coverage prompt, bound to the proposal it refused.
 */
export type HostingOverrideState =
  RetiredPromptState<HostingCoverageOverridePromptData>;

/**
 * Hold an officer's hosting-coverage override only while it still describes the
 * edit on screen.
 *
 * Extracted from `edit-booking-panel.tsx` (#2690); the retire-on-change machinery
 * itself moved to `useRetiredPrompt` (#3232), shared with the linked-move offer
 * rather than duplicated. This hook owns the two slots the retire clears.
 */
export function useHostingCoverageOverride(
  buildSavePayload: (notifyMemberChoice?: boolean) => Record<string, unknown>,
) {
  const [hostingOverrideConfirmed, setHostingOverrideConfirmed] = useState(false);
  const [hostingOverrideReason, setHostingOverrideReason] = useState("");

  const { setState, activeState } =
    useRetiredPrompt<HostingCoverageOverridePromptData>(buildSavePayload, () => {
      setHostingOverrideConfirmed(false);
      setHostingOverrideReason("");
    });

  return {
    setHostingOverrideState: setState,
    hostingOverrideConfirmed,
    setHostingOverrideConfirmed,
    hostingOverrideReason,
    setHostingOverrideReason,
    activeHostingOverrideState: activeState,
  };
}
