/**
 * Who a bulk email may reach (#4987, INV-PRIV-023).
 *
 * Every bulk send — Admin → Messages → Communications and a Notice's "Also
 * email this notice to the audience" — declares one category, and each
 * category reads one member preference with one documented no-row default:
 *
 *  - `clubNotice`: club business (AGM, closures, subscriptions due). Opt-OUT:
 *    sent unless the member's row has `clubNotices === false`. A member with
 *    no saved preferences receives it.
 *  - `newsletter`: optional club news. Opt-IN: sent only when the member's row
 *    has `marketingEmails === true`. A member with no saved preferences does
 *    NOT receive it, and nothing here may change that.
 *
 * This module is the only place that rule is written. Both send paths and the
 * Communications recipient preview partition their audience through
 * `partitionBulkAudience`, so the count an admin sees and the members emailed
 * cannot drift apart. It is pure (no Prisma, no server-only imports) so the
 * compose page can share the category list and labels.
 */

export const BULK_EMAIL_CATEGORIES = ["clubNotice", "newsletter"] as const;

export type BulkEmailCategory = (typeof BULK_EMAIL_CATEGORIES)[number];

/** The preference columns the rule reads. Select exactly these. */
export const BULK_EMAIL_PREFERENCE_SELECT = {
  clubNotices: true,
  marketingEmails: true,
} as const;

export type BulkEmailPreference = {
  clubNotices: boolean;
  marketingEmails: boolean;
};

export type BulkAudienceMember = {
  notificationPreference: BulkEmailPreference | null;
};

export type BulkAudiencePartition<T> = {
  /** Members the email is sent to. */
  eligible: T[];
  /** Members with saved preferences that exclude this category. */
  optedOut: T[];
  /** Members with no saved preferences, excluded by an opt-in category. */
  neverOptedIn: T[];
};

/** Plain wording for the compose page and the guides. */
export const BULK_EMAIL_CATEGORY_LABELS: Record<
  BulkEmailCategory,
  { label: string; description: string }
> = {
  clubNotice: {
    label: "Club notice",
    description:
      "Club business such as AGM notices, lodge closures and subscription reminders. Sent to every member in the group except those who turned off Club notices.",
  },
  newsletter: {
    label: "Club newsletter",
    description:
      "Optional club news. Sent only to members who turned on Club newsletters.",
  },
};

export function partitionBulkAudience<T extends BulkAudienceMember>(
  members: readonly T[],
  category: BulkEmailCategory,
): BulkAudiencePartition<T> {
  const partition: BulkAudiencePartition<T> = {
    eligible: [],
    optedOut: [],
    neverOptedIn: [],
  };
  for (const member of members) {
    const pref = member.notificationPreference;
    if (category === "clubNotice") {
      if (pref && pref.clubNotices === false) partition.optedOut.push(member);
      else partition.eligible.push(member);
    } else if (!pref) {
      partition.neverOptedIn.push(member);
    } else if (pref.marketingEmails === true) {
      partition.eligible.push(member);
    } else {
      partition.optedOut.push(member);
    }
  }
  return partition;
}
