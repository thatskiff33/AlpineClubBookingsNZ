import "server-only";

import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { toPagePath } from "@/lib/page-content";
import { adminHref } from "@/lib/admin-hubs";
import type { PrivacyPolicyPageState } from "@/lib/analytics-settings-shared";

/**
 * The club's canonical privacy policy, as the Google Analytics setup panel needs to
 * describe it (#2573, owner clarification 5).
 *
 * There is deliberately NO Google-Analytics-specific privacy-policy URL setting. The
 * application already has one canonical privacy policy — the built-in `/privacy`
 * page in the admin-authored content tree (`isBuiltinPageSlug("privacy")`, linked
 * from every public footer) — and adding a second field would let a club end up with
 * two answers to one question, with the analytics panel pointing at the one nobody
 * maintains.
 *
 * So this reads the existing page and reports three things the panel needs: does the
 * page exist, is it published, and where does the admin go to edit it. A club with no
 * published privacy policy gets a prominent warning and a link to the website content
 * settings — but setup is NOT blocked on it, which is the clarification's other half.
 *
 * The same state answers a second question, for the VISITOR rather than the admin:
 * `resolveAnalyticsRuntimeConfig` uses it to decide whether the consent banner may
 * link the policy at the point of the decision. {@link PrivacyPolicyPageState}
 * therefore lives in `analytics-settings-shared.ts`, which the `"use client"` admin
 * card can import; this module keeps the read.
 *
 * The admin edits the policy in the existing website content editor, Page Content,
 * linked by its hub registry id (epic #4468, C4 #4801), not in a new screen. The
 * link is made here and in the card, never in the shared module, so the public
 * consent banner's bundle does not carry the admin page registry.
 */

const PRIVACY_PAGE_SLUG = "privacy";

/**
 * Never throws. A database failure reports "not published", which makes the panel
 * show its warning — the fail-closed direction for a prompt whose whole job is to
 * remind an admin to disclose the club's use of analytics.
 */
export async function loadPrivacyPolicyPageState(): Promise<PrivacyPolicyPageState> {
  const base = {
    publicPath: toPagePath(PRIVACY_PAGE_SLUG),
    adminHref: adminHref("page-content"),
  };

  try {
    const page = await prisma.pageContent.findUnique({
      where: { slug: PRIVACY_PAGE_SLUG },
      select: { published: true },
    });
    return {
      ...base,
      exists: Boolean(page),
      published: Boolean(page?.published),
    };
  } catch (err) {
    logger.error(
      { err },
      "Could not resolve the privacy policy page state for the analytics setup panel",
    );
    return { ...base, exists: false, published: false };
  }
}
