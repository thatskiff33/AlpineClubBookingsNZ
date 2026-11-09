import { defineHub } from "../define";

/**
 * Members. The prefix is not `members`: `/admin/members` is already the Members
 * page and a `membership`-area route prefix, and `/admin/members/[id]` would sit
 * under the hub prefix (see the prefix census).
 */
export const MEMBERS_HUB = defineHub({
  key: "members",
  label: "Members",
  prefix: "membership",
  pages: [
    {
      id: "members",
      label: "Members",
      oldPath: "/admin/members",
      area: "membership",
      keywords: ["users", "people", "contacts", "membership"],
      moved: false,
    },
    {
      id: "member-detail",
      label: "Member",
      oldPath: "/admin/members/[id]",
      area: "membership",
      kind: "detail",
      moved: false,
    },
    {
      id: "member-merge",
      label: "Merge Member",
      oldPath: "/admin/members/[id]/merge",
      area: "membership",
      kind: "detail",
      moved: false,
    },
    {
      id: "member-applications",
      label: "Applications",
      oldPath: "/admin/member-applications",
      area: "membership",
      moved: false,
    },
    {
      // S1 (#4796): the settings tab holds what was
      // `/admin/membership-cancellation` and `/admin/setup/cancellation`.
      id: "membership-cancellations",
      label: "Cancellation Requests",
      oldPath: "/admin/membership-cancellations",
      area: "membership",
      tabs: ["requests", "settings"],
      moved: false,
    },
    {
      // S1 (#4796): the suggestions tab is what was `/admin/family-suggestions`.
      id: "family-groups",
      label: "Family Groups",
      oldPath: "/admin/family-groups",
      area: "membership",
      tabs: ["groups", "suggestions"],
      keywords: ["family suggestions", "suggested families"],
      moved: false,
    },
    {
      id: "induction",
      label: "Induction",
      oldPath: "/admin/induction",
      area: "membership",
      flags: ["induction"],
      moved: false,
    },
    {
      id: "induction-print",
      label: "Print Induction",
      oldPath: "/admin/induction/[id]/print",
      area: "membership",
      flags: ["induction"],
      kind: "print",
      moved: false,
    },
    {
      id: "induction-settings",
      label: "Induction Settings",
      oldPath: "/admin/induction/settings",
      area: "membership",
      flags: ["induction"],
      moved: false,
    },
    {
      id: "deletion-requests",
      label: "Deletion Requests",
      oldPath: "/admin/deletion-requests",
      area: "membership",
      moved: false,
    },
    {
      id: "committee",
      label: "Committee",
      oldPath: "/admin/committee",
      area: "membership",
      moved: false,
    },
    {
      id: "membership-setup",
      label: "Membership & Members",
      oldPath: "/admin/membership-setup",
      area: "membership",
      moved: false,
    },
    {
      id: "membership-types",
      label: "Membership Types",
      oldPath: "/admin/membership-types",
      area: "membership",
      moved: false,
    },
    {
      id: "member-fields",
      label: "Member Fields",
      oldPath: "/admin/member-fields",
      area: "membership",
      moved: false,
    },
    {
      // #4581: the area of its API, /api/admin/membership-lockout-settings. It
      // was support, so a Membership Officer could call the API but not open
      // the page; the panel hides its finance and bookings sections from a
      // viewer whose matrix lacks them.
      id: "subscription-lockout",
      label: "Subscription Lockout",
      oldPath: "/admin/subscription-lockout",
      area: "membership",
      moved: false,
    },
  ],
});
