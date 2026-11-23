/**
 * Whether a module-settings save switches AI Diagnostics on, and whether it may
 * (ADR-006 §2, #5243).
 *
 * Diagnostics sends excerpts of club data to its provider, which may process
 * them outside New Zealand, so switching it on needs the administrator to have
 * acknowledged the CURRENT disclosure. Any save that would turn it on is
 * judged, whichever screen sent it. Switching it off, or saving while it is
 * already on, needs no acknowledgement. The modules route makes its write
 * conditional on the `before` value judged here, so the judgement cannot go
 * stale between the read and the write.
 */
import { AI_DIAGNOSTICS_DISCLOSURE_VERSION } from "@/lib/ai-diagnostics-disclosure";

interface AiDiagnosticsEnableJudgement {
  /** The save switches Diagnostics from off to on. */
  enables: boolean;
  /** Why the save is refused, or null when it may go ahead. */
  refusal: string | null;
}

const AI_DIAGNOSTICS_ACKNOWLEDGEMENT_MISSING =
  "Read and tick the statement about where AI Diagnostics sends data, on Admin → Modules, before switching it on. Reload the page if you have already ticked it.";

export function judgeAiDiagnosticsEnable(
  before: { aiDiagnostics: boolean },
  after: { aiDiagnostics: boolean },
  acknowledgedVersion: number | undefined,
): AiDiagnosticsEnableJudgement {
  const enables = !before.aiDiagnostics && after.aiDiagnostics;
  const acknowledged = acknowledgedVersion === AI_DIAGNOSTICS_DISCLOSURE_VERSION;
  return {
    enables,
    refusal: enables && !acknowledged ? AI_DIAGNOSTICS_ACKNOWLEDGEMENT_MISSING : null,
  };
}
