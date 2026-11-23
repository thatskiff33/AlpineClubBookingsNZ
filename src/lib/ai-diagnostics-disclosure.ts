/**
 * The AI Diagnostics provider disclosure (ADR-006 §2, #5243): the one statement
 * an administrator reads before switching Diagnostics on, and the version the
 * modules route records when they acknowledge it.
 *
 * Client-safe on purpose — the Modules page (a client component) shows it beside
 * the switch, the AI Diagnostics page (a server component) shows it in place, and
 * the route checks the version. One source, so the three cannot say different
 * things.
 *
 * The provider's name and privacy link come from the privacy recipient register,
 * so this and the starter privacy policy name the same recipient (#4918).
 *
 * RAISE THE VERSION when the statement changes in substance (a new kind of data,
 * a different provider or place). A stale page then cannot enable Diagnostics on
 * an acknowledgement of words the administrator was not shown. Clubs already on
 * are not re-asked (owner decision on #5243).
 */
import { PRIVACY_RECIPIENTS } from "@/lib/privacy-recipient-classification";

export const AI_DIAGNOSTICS_DISCLOSURE_VERSION = 1;

const recipient = PRIVACY_RECIPIENTS.anthropic;

/**
 * The register names a recipient "<organisation> (<the features that use it>)";
 * the statement names the organisation alone.
 */
const providerName = recipient.name.replace(/\s*\(.*\)$/, "");

export const AI_DIAGNOSTICS_DISCLOSURE = {
  providerName,
  providerPrivacyUrl: recipient.privacyUrl,
  heading: "Where your data goes",
  summary: `To answer a question, AI Diagnostics sends excerpts of the club's data to ${providerName}, which may process them outside New Zealand.`,
  dataSentIntro: "Each question can send:",
  dataSent: [
    "the question, and the admin screen it was asked from, including that screen's filters and search",
    "earlier questions and answers in the same conversation",
    "excerpts of this application's code, its built-in guides, and any private notes this deployment adds",
    "records looked up to answer it, such as bookings, payments, settings and job runs",
    "personal details held in member records only when the administrator ticks the personal-details box for that question, and a search for people only when the search box is ticked; once an answer includes personal details, they stay in the conversation and are sent again with later questions in it, ticked or not; anything typed into the question or a screen's search, including a name, is sent as typed",
  ],
  retention: `This application sends ${providerName} no instruction about how long to keep the excerpts. Retention, including zero retention, is arranged between the club and ${providerName} on the club's own ${providerName} account — the one behind the Diagnostics key.`,
  acknowledgementLabel: `I understand that switching on AI Diagnostics sends these excerpts to ${providerName}, which may process them outside New Zealand.`,
  acknowledgementRequired:
    "Tick the statement about where AI Diagnostics sends data before saving.",
} as const;
