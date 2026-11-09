import { defineHub } from "../define";

/**
 * Club settings. The four setup wizards (`stripe`, `google`, `alpine-server`,
 * `video-meetings`) sit beside Integrations on the plan's recommendation,
 * pending the owner's answer on #4480.
 *
 * `setup` holds only this hub's pages since S1 (#4796) retired the three that
 * belonged to other hubs (`setup/booking-rules`, `setup/cancellation`,
 * `setup/integrations`; `retired.ts`), so its directory moves in one `git mv`.
 * The registry suite still refuses a moved page with an unmoved page beneath it.
 */
export const SETTINGS_HUB = defineHub({
  key: "settings",
  label: "Club settings",
  prefix: "settings",
  pages: [
    {
      id: "setup",
      label: "Setup",
      oldPath: "/admin/setup",
      area: "support",
      moved: false,
    },
    {
      id: "setup-finance",
      label: "Finance Setup",
      oldPath: "/admin/setup/finance",
      area: "finance",
      moved: false,
    },
    {
      id: "setup-foundations",
      label: "Foundations Setup",
      oldPath: "/admin/setup/foundations",
      area: "support",
      moved: false,
    },
    {
      id: "modules",
      label: "Modules",
      oldPath: "/admin/modules",
      area: "support",
      moved: false,
    },
    {
      // Login & Security (epic #2030, #2033): system configuration, like Modules.
      id: "security",
      label: "Login & Security",
      oldPath: "/admin/security",
      area: "support",
      moved: false,
    },
    {
      id: "access-roles",
      label: "Access Roles",
      oldPath: "/admin/access-roles",
      area: "support",
      fullAdminOnly: true,
      moved: false,
    },
    {
      id: "privacy-retention",
      label: "Privacy & Retention",
      oldPath: "/admin/privacy-retention",
      area: "support",
      moved: false,
    },
    {
      id: "club-time",
      label: "Club Time Zone",
      oldPath: "/admin/club-time",
      area: "support",
      fullAdminOnly: true,
      moved: false,
    },
    {
      id: "club-format",
      label: "Club Currency & Locale",
      oldPath: "/admin/club-format",
      area: "support",
      admission: "any-admin",
      moved: false,
    },
    {
      id: "environment",
      label: "Environment Safety",
      oldPath: "/admin/environment",
      area: "support",
      fullAdminOnly: true,
      moved: false,
    },
    {
      id: "config-transfer",
      label: "Export & Import",
      oldPath: "/admin/config-transfer",
      area: "support",
      fullAdminOnly: true,
      moved: false,
    },
    {
      id: "integrations",
      label: "Integrations",
      oldPath: "/admin/integrations",
      area: "finance",
      moved: false,
    },
    {
      id: "stripe-setup",
      label: "Stripe Setup",
      oldPath: "/admin/stripe/setup",
      area: "finance",
      moved: false,
    },
    {
      // On the Integrations hub (finance), like Xero and Stripe (#2087). NOT
      // gated by googleLogin: setup and verify must work while it is still off.
      id: "google-setup",
      label: "Google Sign-in Setup",
      oldPath: "/admin/google/setup",
      area: "finance",
      moved: false,
    },
    {
      id: "alpine-server-setup",
      label: "Alpine Central Server Setup",
      oldPath: "/admin/alpine-server/setup",
      area: "finance",
      flags: ["alpineCentralServer"],
      moved: false,
    },
    {
      // MiroTalk setup (#2940), finance like the other integrations; its API is
      // under /api/admin/integrations. No module gate: there is no module to
      // turn off, and the page is where the club sets what was env-only.
      id: "video-meetings-setup",
      label: "Video Meetings Setup",
      oldPath: "/admin/video-meetings/setup",
      area: "finance",
      moved: false,
    },
  ],
});
