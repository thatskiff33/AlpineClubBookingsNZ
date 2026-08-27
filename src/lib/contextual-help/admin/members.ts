/**
 * Help for the "Members" admin section: the roll, applications, subscriptions,
 * induction, family groups and member communications.
 *
 * Section per the sidebar's `buildAdminNavSections`.
 */
import { entry, help, type HelpEntry } from "../types";

export const adminMembersHelpEntries: HelpEntry[] = [
  entry(
    "/admin/member-applications",
    help(
      "Applications",
      "This page tracks membership applications, nomination progress, and admin approval or rejection.",
      [
        "Filter to pending applications, review applicant details, and inspect nomination status.",
        "Refresh or replace nominators only when the applicant's nomination path needs recovery.",
        "Approve or reject only after checking required evidence and committee policy.",
      ],
      [
        {
          name: "Application status",
          description:
            "Tracks whether the applicant is waiting for nominators, waiting for admin review, approved, or rejected.",
        },
        {
          name: "Nominator slots",
          description:
            "Show who has been asked to nominate and whether each confirmation is complete or stale.",
        },
        {
          name: "Admin decision",
          description:
            "Records the final approval or rejection action and associated audit history.",
        },
      ],
      [
        "Application decisions affect membership lifecycle and login access. Confirm the applicant identity before approval.",
      ],
    ),
  ),
  entry(
    "/admin/family-groups",
    help(
      "Family Groups",
      "Family groups link adults and dependents so shared bookings, dependents, inherited emails, and family requests can be reviewed safely.",
      [
        "Review pending join, adult, child, and removal requests before changing relationships.",
        "Open a group to inspect adults, dependents, login holders, and inherited contact details.",
        "Use explicit approve, reject, link, or unlink actions rather than editing unrelated member fields.",
      ],
      [
        {
          name: "Login holder",
          description:
            "The adult account that can manage family/dependent records for the group.",
        },
        {
          name: "Dependent",
          description:
            "A child or non-login family member whose contact and booking context is managed through the group.",
        },
        {
          name: "Request status",
          description:
            "Shows whether a family change is waiting, approved, rejected, or completed.",
        },
      ],
      [
        "Family changes can affect account access and member privacy. Check names and emails carefully before approving.",
      ],
    ),
  ),
  entry(
    "/admin/membership-cancellations",
    help(
      "Cancellations",
      "This page handles membership cancellation, archive, and related lifecycle action requests.",
      [
        "Review requested cancellations and any participant confirmations.",
        "Check blockers such as future bookings, unpaid obligations, or family participant state.",
        "Approve, reject, withdraw, archive, or complete the request only after the blockers are clear.",
      ],
      [
        {
          name: "Participant status",
          description:
            "Shows whether each affected family member has confirmed, declined, or still needs action.",
        },
        {
          name: "Blockers",
          description:
            "Future bookings, payments, or account constraints that should stop completion until resolved.",
        },
        {
          name: "Lifecycle action",
          description:
            "The requested account change, such as cancellation, archive, delete, or rejoin follow-up.",
        },
      ],
      [
        "Membership lifecycle changes can remove access. Confirm the requested members before completing the action.",
      ],
    ),
  ),
  entry(
    "/admin/members",
    help(
      "Members",
      "Members is the main directory for member records, login access, profile data, roles, imports, and member-level actions.",
      [
        "Search or filter first, then use the member name or Open action to read the detail page; choose Edit inside a section only when you intend to change it.",
        "Use Reset to restore the list search, filters, sort, and page in one action.",
        "Use bulk import/update only with reviewed CSV data and clear rollback expectations.",
        "Check access roles, seasonal membership type, family group, and subscription status separately.",
      ],
      [
        {
          name: "Access",
          description:
            "Shows account readiness, not role: No login, Not invited, Invited, or Can log in. The warning, information, and success tones carry the same meaning here and on Subscriptions.",
        },
        {
          name: "Access role",
          description:
            "The member detail page separately controls app access such as user, admin, finance, lodge, or organisation access. On-behalf booking family selection works from a Booking Officer's bookings:edit permission, so dropping membership:view from a customised role does not break member pricing.",
        },
        {
          name: "Seasonal membership type",
          description:
            "Controls season-specific booking rate, block-booking behavior, and subscription policy.",
        },
        {
          name: "Can login",
          description:
            "Only one member per email should be login-capable; shared-email family members may be non-login records.",
        },
      ],
      [
        "Member changes can affect privacy, access, bookings, and subscriptions. Confirm the target member before saving.",
      ],
    ),
  ),
  entry(
    "/admin/subscriptions",
    help(
      "Subscriptions",
      "Subscriptions tracks membership subscription invoices, payment state, lockout behavior, and season-specific dues.",
      [
        "Filter by season, member, status, or overdue state.",
        "Use Reset to restore list filters, sort, and page without changing the selected season.",
        "Inspect the linked member and Xero/payment records before marking or retrying anything; member names open detail only when your role also has membership view.",
        "Use subscription lockout settings for policy changes rather than one-off manual edits.",
      ],
      [
        {
          name: "Access",
          description:
            "Shows the same No login, Not invited, Invited, or Can log in account-readiness state used on Members; it is not an access-role label.",
        },
        {
          name: "Subscription status",
          description:
            "Shows unpaid, paid, overdue, not required, or not invoiced state.",
        },
        {
          name: "Season",
          description:
            "The membership year or seasonal period the subscription belongs to.",
        },
        {
          name: "Invoice",
          description:
            "The Xero or payment record used to settle the subscription.",
        },
      ],
    ),
  ),
  entry(
    "/admin/induction",
    help(
      "Induction",
      "Induction pages manage induction templates, sign-offs, and member completion tracking.",
      [
        "Review outstanding induction requirements and signed-off members.",
        "Edit templates carefully because wording may be used for future member compliance.",
        "Use print or detail views when a physical sign-off record is needed.",
      ],
      [
        {
          name: "Template",
          description:
            "The induction content or checklist members must complete.",
        },
        {
          name: "Sign-off",
          description:
            "A recorded member acknowledgement for a specific induction.",
        },
        {
          name: "Status",
          description:
            "Shows whether an induction is pending, completed, or needs follow-up.",
        },
      ],
    ),
  ),
  entry(
    "/admin/communications",
    help(
      "Communications",
      "Communications sends and reviews member email or notification messages.",
      [
        "Choose the audience carefully before composing or sending.",
        "Preview message content and token output when available.",
        "Review delivery history for failures, suppressions, or follow-up needs.",
      ],
      [
        {
          name: "Audience",
          description:
            "The selected member group or recipients for the message.",
        },
        {
          name: "Template",
          description:
            "Reusable subject/body content, often with supported tokens.",
        },
        {
          name: "Delivery history",
          description:
            "Shows sent, failed, suppressed, or pending communications.",
        },
      ],
      [
        "Email changes can expose private information. Verify recipients before sending.",
      ],
    ),
  ),
  entry(
    "/admin/notices",
    help(
      "Member Notices",
      "Member Notices posts committee news to targeted member audiences and tracks who has read each notice.",
      [
        "Target a notice to everyone or to specific members, membership types, lodges, or committee roles.",
        "Publish when ready; optionally email the notice to the audience once on publish.",
        "Open a notice to see the read-status report and, where required, acknowledgements.",
      ],
      [
        {
          name: "Audience",
          description:
            "Who can see the notice: everyone, or a targeted set of members, types, lodges, or roles.",
        },
        {
          name: "Financial members only",
          description:
            "When set, group audiences reach only paid-up or exempt members; individually targeted members always see it.",
        },
        {
          name: "Read receipts",
          description:
            "Records when each member first opened the notice, and their acknowledgement when required.",
        },
      ],
      [
        "Notices can carry private committee information. Check the audience before publishing.",
      ],
    ),
  ),
  entry(
    "/admin/family-suggestions",
    help(
      "Family Suggestions",
      "Family Suggestions surfaces likely family relationships based on member data so admins can create or dismiss groups deliberately.",
      [
        "Review each suggestion against names, emails, ages, and addresses.",
        "Create the family group only when the relationship is clear.",
        "Dismiss suggestions that are wrong or not useful.",
      ],
      [
        {
          name: "Suggested members",
          description:
            "Records that appear related based on shared details.",
        },
        {
          name: "Confidence clues",
          description:
            "Shared email, address, surname, or dependent age information that explains the suggestion.",
        },
      ],
    ),
  ),
];
