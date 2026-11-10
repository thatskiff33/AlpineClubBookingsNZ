import { defineHub } from "../define";

/** Messages & email. Mixes the `membership` and `support` areas. */
export const MESSAGES_HUB = defineHub({
  key: "messages",
  label: "Messages & email",
  prefix: "messages",
  pages: [
    {
      id: "notifications",
      label: "Notifications & Email",
      oldPath: "/admin/notifications",
      area: "support",
      moved: true,
    },
    {
      id: "communications",
      label: "Communications",
      oldPath: "/admin/communications",
      area: "membership",
      flags: ["communications"],
      keywords: ["email", "newsletter", "bulk message", "broadcast"],
      moved: true,
    },
    {
      id: "notices",
      label: "Member Notices",
      oldPath: "/admin/notices",
      area: "membership",
      flags: ["memberNotices"],
      keywords: ["news", "recent news", "notice", "announcement", "committee"],
      moved: true,
    },
    {
      id: "notice-detail",
      label: "Member Notice",
      oldPath: "/admin/notices/[id]",
      area: "membership",
      flags: ["memberNotices"],
      kind: "detail",
      moved: true,
    },
    {
      id: "notice-new",
      label: "New Member Notice",
      oldPath: "/admin/notices/new",
      area: "membership",
      flags: ["memberNotices"],
      moved: true,
    },
    {
      // #2998: moderation sits with notices, because the people who curate what
      // members read are the same people; every handler enforces
      // requireAdmin({ area: "membership" }).
      id: "message-board",
      label: "Message Board",
      oldPath: "/admin/message-board",
      area: "membership",
      flags: ["commsPortal"],
      keywords: [
        "message board", "posts", "member posts", "moderation", "hide post",
        "remove post",
      ],
      moved: true,
    },
    {
      id: "email-messages",
      label: "Email Messages",
      oldPath: "/admin/email-messages",
      area: "support",
      moved: true,
    },
    {
      id: "booking-messages",
      label: "Booking Messages",
      oldPath: "/admin/booking-messages",
      area: "support",
      moved: true,
    },
    {
      id: "notification-rules",
      label: "Notification Rules",
      oldPath: "/admin/notification-rules",
      area: "support",
      moved: true,
    },
    {
      id: "notification-recipients",
      label: "Notification Recipients",
      oldPath: "/admin/notification-recipients",
      area: "support",
      moved: true,
    },
  ],
});
