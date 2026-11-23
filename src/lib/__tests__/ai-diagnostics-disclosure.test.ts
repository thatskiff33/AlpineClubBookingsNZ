import { describe, expect, it } from "vitest";

import { AI_DIAGNOSTICS_DISCLOSURE } from "@/lib/ai-diagnostics-disclosure";
import { PRIVACY_RECIPIENTS } from "@/lib/privacy-recipient-classification";

// The Diagnostics disclosure (#5243) and the privacy recipient register (#4918)
// must name the same recipient and the same place, or the admin page and the
// starter privacy policy tell a club two different things.
describe("AI Diagnostics disclosure and the privacy recipient register", () => {
  it("names the register's Anthropic recipient and links its privacy notice", () => {
    expect(AI_DIAGNOSTICS_DISCLOSURE.providerName).toBe("Anthropic");
    expect(PRIVACY_RECIPIENTS.anthropic.name.startsWith(`${AI_DIAGNOSTICS_DISCLOSURE.providerName} (`)).toBe(true);
    expect(AI_DIAGNOSTICS_DISCLOSURE.providerPrivacyUrl).toBe(PRIVACY_RECIPIENTS.anthropic.privacyUrl);
  });

  it("lists the conversation history and private notes in both places", () => {
    expect(AI_DIAGNOSTICS_DISCLOSURE.dataSent).toContain("earlier questions and answers in the same conversation");
    expect(AI_DIAGNOSTICS_DISCLOSURE.dataSent.some((line) => line.includes("any private notes this deployment adds"))).toBe(true);
    expect(PRIVACY_RECIPIENTS.anthropic.dataSent).toContain("earlier questions and answers in the same conversation");
    expect(PRIVACY_RECIPIENTS.anthropic.dataSent).toContain("any private notes the deployment adds");
  });

  // Owner decision, 22 Nov 2026 (#5243): processing outside New Zealand is a
  // possibility, not a certainty — "may" / "can be", as the starter policy says.
  it("says data may be processed outside New Zealand, in both places, without stating it as certain", () => {
    expect(AI_DIAGNOSTICS_DISCLOSURE.summary).toContain("which may process them outside New Zealand");
    expect(AI_DIAGNOSTICS_DISCLOSURE.acknowledgementLabel).toContain("which may process them outside New Zealand");
    expect(PRIVACY_RECIPIENTS.anthropic.processing).toMatch(/^Can be processed outside New Zealand;/);
    for (const text of [
      AI_DIAGNOSTICS_DISCLOSURE.summary,
      AI_DIAGNOSTICS_DISCLOSURE.acknowledgementLabel,
      PRIVACY_RECIPIENTS.anthropic.processing,
    ]) {
      expect(text).not.toMatch(/\b(?:processes them|for processing|Processed) outside New Zealand/);
    }
  });

  // The personal-details and people-search boxes gate what TOOLS may fetch.
  // The question text and a screen's filter values reach the provider with any
  // names intact (`resolve.ts` -> `boundedRedacted`, which keeps names), ticked
  // or not, so the statement must not claim typed text is gated.
  it("does not claim the consent boxes gate text the administrator types", () => {
    const consentLine = AI_DIAGNOSTICS_DISCLOSURE.dataSent.find((line) => line.includes("personal-details box"));
    expect(consentLine).toBeDefined();
    expect(consentLine).toMatch(/^personal details held in member records only when/);
    expect(consentLine).toContain("anything typed into the question or a screen's search, including a name, is sent as typed");
    expect(consentLine).not.toMatch(/^members' personal details only when/);
  });

  // The earlier conversation is replayed with every question
  // (`buildDiagnosticsConversationBlock` in `diagnostics/answer/prompt.ts`), and
  // no consent box gates it: an answer holding personal details from a ticked
  // question goes again with later, unticked ones. Both places must say so.
  it("says personal details in an earlier answer are sent again with later questions", () => {
    const consentLine = AI_DIAGNOSTICS_DISCLOSURE.dataSent.find((line) => line.includes("personal-details box"));
    expect(consentLine).toContain(
      "once an answer includes personal details, they stay in the conversation and are sent again with later questions in it, ticked or not",
    );
    expect(PRIVACY_RECIPIENTS.anthropic.dataSent).toContain(
      "an answer that includes it is sent again with later questions in the same conversation",
    );
  });
});
