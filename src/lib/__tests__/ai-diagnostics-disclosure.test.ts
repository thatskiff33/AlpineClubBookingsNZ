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

  it("says outside New Zealand in both places", () => {
    expect(AI_DIAGNOSTICS_DISCLOSURE.summary).toContain("outside New Zealand");
    expect(PRIVACY_RECIPIENTS.anthropic.processing).toContain("outside New Zealand");
  });
});
