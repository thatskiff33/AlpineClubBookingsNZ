/**
 * Help for the "Setup & Configuration" admin section: the guided setup hubs and
 * every settings page they lead to.
 *
 * Section per the sidebar's `navSections`. The pages with no menu entry of
 * their own are placed by the hub that links them — membership types, member
 * fields and the subscription lockout under Membership setup; rooms and beds
 * and the booking messages under Bookings setup.
 */
import { entry, help, type HelpEntry } from "../types";

export const adminSetupAndConfigurationHelpEntries: HelpEntry[] = [
  entry(
    "/admin/setup",
    help(
      "Setup",
      "Setup collects first-install readiness and links to focused setup hubs.",
      [
        "Complete required setup steps before opening public workflows.",
        "Use provider tests and progress indicators to confirm configuration is working.",
        "Open the setup hub cards for lower-frequency membership, booking, finance, integration, cancellation, and notification setup pages.",
        "Review Finance Report Mappings from the Finance drill-down when Xero-backed reports are enabled.",
      ],
      [
        {
          name: "Setup progress",
          description:
            "Shows which required configuration areas are complete or still missing.",
        },
        {
          name: "Provider tests",
          description:
            "Safe checks that confirm external configuration without using exploratory live data.",
        },
        {
          name: "Setup hubs",
          description:
            "Cards that route setup work into focused drill-down pages instead of one long checklist.",
        },
      ],
    ),
  ),
  entry(
    "/admin/setup/foundations",
    help(
      "Initial Setup",
      "Initial Setup groups first-install readiness, modules, lodge records, and health checks.",
      [
        "Open Setup Checklist before marking setup complete.",
        "Review Modules and Lodges before enabling module-backed or multi-lodge workflows.",
        "Use System Health to confirm runtime readiness before launch.",
      ],
      [
        {
          name: "Setup Checklist",
          description:
            "Readiness KPIs, blockers, provider tests, and setup progress.",
        },
        {
          name: "Modules",
          description:
            "Club-level activation controls for optional workflows.",
        },
        {
          name: "System Health",
          description:
            "Runtime and provider readiness checks used before launch.",
        },
      ],
    ),
  ),
  entry(
    "/admin/setup/finance",
    help(
      "Finance setup",
      "Finance setup groups finance reporting, Xero setup, sync mappings, and the finance report mapping editor.",
      [
        "Open Finance Dashboard for reporting views and sync-health context.",
        "Open Xero Setup or Xero Mappings before changing accounting sync behavior.",
        "Expand Finance Report Mappings only when editing the report groups used by the finance dashboard.",
      ],
      [
        {
          name: "Finance Dashboard",
          description:
            "Finance reporting views that read from synced accounting data.",
        },
        {
          name: "Xero Mappings",
          description:
            "Account and item-code mappings used by operational Xero sync.",
        },
        {
          name: "Finance Report Mappings",
          description:
            "Collapsed editor for grouping Xero profit-and-loss lines into dashboard report sections.",
        },
      ],
    ),
  ),
  entry(
    "/admin/setup/booking-rules",
    help(
      "Booking Rules",
      "Booking Rules groups the setup pages that define booking eligibility, pricing, capacity, and booking copy.",
      [
        "Open Booking Policies before changing cancellation, minimum-stay, public-request, or group-discount behavior.",
        "Review Hut Fees & Seasons and Age Groups before accepting priced bookings.",
        "Use Rooms & Beds and Booking Messages for inventory and member-facing booking copy.",
      ],
      [
        {
          name: "Booking Policies",
          description:
            "Rules that affect holds, cancellation, minimum stays, public requests, and group discounts.",
        },
        {
          name: "Hut Fees & Seasons",
          description:
            "Season windows and nightly rates used by booking pricing.",
        },
        {
          name: "Rooms & Beds",
          description:
            "Capacity and allocation inventory used by lodge stays.",
        },
      ],
    ),
  ),
  entry(
    "/admin/setup/integrations",
    help(
      "Operational Integrations",
      "Operational Integrations groups provider-backed setup pages for accounting, email, modules, and health checks.",
      [
        "Open Xero Setup before connecting or changing operational accounting sync.",
        "Review Modules before enabling provider-backed workflows.",
        "Use Email Deliverability and Provider Health for runtime diagnostics.",
      ],
      [
        {
          name: "Xero Setup",
          description:
            "OAuth connection and accounting settings used by Xero-backed workflows.",
        },
        {
          name: "Email Deliverability",
          description:
            "SES/SMTP delivery and suppression diagnostics.",
        },
        {
          name: "Provider Health",
          description:
            "Safe runtime checks for provider readiness.",
        },
      ],
    ),
  ),
  entry(
    "/admin/setup/cancellation",
    help(
      "Cancellation setup",
      "Cancellation setup groups member cancellation settings, request handling, and related email copy.",
      [
        "Open Membership Cancellation before changing cancellation warning or rejoin-process text.",
        "Review Cancellation Requests before changing live policy that affects pending requests.",
        "Use Email Messages for cancellation and lifecycle message wording.",
      ],
      [
        {
          name: "Membership Cancellation",
          description:
            "Settings for cancellation copy and Xero cancellation handling.",
        },
        {
          name: "Cancellation Requests",
          description:
            "Pending member requests that may be affected by policy changes.",
        },
        {
          name: "Email Messages",
          description:
            "Audited templates used by cancellation and member lifecycle workflows.",
        },
      ],
    ),
  ),
  entry(
    "/admin/membership-setup",
    help(
      "Membership & Members setup",
      "Membership & Members groups the setup pages that define membership policy, profile fields, and subscription access behavior.",
      [
        "Open Membership Types for seasonal categories, booking-rate behavior, subscription behavior, age tiers, and Xero group rules.",
        "Open Member Fields before changing what members or applicants are asked to provide.",
        "Review Subscription Lockout before enabling or changing access restrictions for unpaid subscriptions.",
      ],
      [
        {
          name: "Membership Types",
          description:
            "Seasonal categories that drive booking policy, subscriptions, age-tier eligibility, and optional Xero contact-group rules.",
        },
        {
          name: "Member Fields",
          description:
            "Extra profile fields collected from members and applicants.",
        },
        {
          name: "Subscription Lockout",
          description:
            "Policy controls for when unpaid subscriptions restrict booking or access actions.",
        },
      ],
    ),
  ),
  entry(
    "/admin/bookings-setup",
    help(
      "Bookings Setup",
      "Bookings Setup groups lower-frequency pages that shape booking inventory and member-facing booking copy.",
      [
        "Open Rooms & Beds before changing bed-allocation inventory.",
        "Open Booking Messages when booking, payment, cancellation, or group-booking wording needs an operator-approved update.",
        "Check module and permission gates if a setup card is hidden for the current admin.",
      ],
      [
        {
          name: "Rooms & Beds",
          description:
            "Lodge room and bed inventory used by bed-allocation workflows.",
        },
        {
          name: "Booking Messages",
          description:
            "Editable wording shown during booking, payment, cancellation, and group-trip flows.",
        },
      ],
    ),
  ),
  entry(
    "/admin/integrations",
    help(
      "Integrations",
      "Integrations groups provider-backed setup pages for accounting and other connected services.",
      [
        "Open Xero Setup to connect or test accounting configuration.",
        "Keep provider tests on non-production credentials unless a live test window is approved.",
        "Check finance mappings after changing Xero setup that affects reports or invoices.",
      ],
      [
        {
          name: "Xero Setup",
          description:
            "OAuth connection, account mapping, provider checks, and sync configuration for Xero-backed workflows.",
        },
      ],
    ),
  ),
  entry(
    "/admin/notifications",
    help(
      "Notifications & Email",
      "Notifications & Email groups delivery rules, recipients, automated message wording, and member-facing notification copy.",
      [
        "Open Delivery Rules and Recipients before changing who receives admin or system alerts.",
        "Open Email Messages for audited email-template wording.",
        "Use Booking Messages and Membership Cancellation when changing member-facing copy tied to those workflows.",
      ],
      [
        {
          name: "Delivery Rules",
          description:
            "Controls which admin and system emails are sent when jobs or alerts run.",
        },
        {
          name: "Recipients",
          description:
            "The admin users selected for each system-alert category, limited to the areas each role can edit.",
        },
        {
          name: "Message wording",
          description:
            "Email, booking, and cancellation text that members or admins see in workflow messages.",
        },
        {
          name: "Delivery mode",
          description:
            "Per template, whether it always sends, sends only when there is something to report, or is switched off.",
        },
      ],
    ),
  ),
  entry(
    "/admin/modules",
    help(
      "Modules",
      "Modules turn optional club features on or off at the club level.",
      [
        "Review current module state before enabling a feature.",
        "Enable only the modules the club is ready to operate and support.",
        "Disable modules that should be hidden from users while preserving existing data.",
      ],
      [
        {
          name: "Enabled",
          description:
            "Makes the feature visible and usable where route gating allows it.",
        },
        {
          name: "Disabled",
          description:
            "Hides or blocks the feature without deleting its stored data.",
        },
        {
          name: "Module dependency",
          description:
            "Some features also require provider settings, roles, or setup data before they are useful.",
        },
      ],
    ),
  ),
  entry(
    "/admin/subscription-lockout",
    help(
      "Subscription Lockout",
      "Subscription Lockout controls whether unpaid or overdue subscriptions restrict member access or booking behavior.",
      [
        "Review the current policy before changing lockout behavior.",
        "Set grace periods and affected statuses according to committee policy.",
        "Check member-facing wording and subscription states before enabling enforcement.",
      ],
      [
        {
          name: "Grace period",
          description:
            "How long a member can remain overdue before lockout applies.",
        },
        {
          name: "Affected status",
          description:
            "Which subscription states trigger restrictions.",
        },
        {
          name: "Lockout message",
          description:
            "The member-facing explanation shown when access is restricted.",
        },
      ],
    ),
  ),
  entry(
    "/admin/membership-types",
    help(
      "Membership Types",
      "Membership Types define seasonal member categories, booking rate behavior, subscription behavior, and optional Xero contact-group rules.",
      [
        "Use the type list to scan status, policy behavior, allowed tiers, assignment counts, and order.",
        "Create or edit a type in the editor before assigning it to members or rolling seasons forward.",
        "Use the separate roll-forward section to preview changes and exceptions before applying them.",
        "When adding Xero rules, choose Managed only when sync should assert membership in the Xero group.",
        "Keep access roles separate from seasonal membership type policy.",
        "Delete removes an unused custom type outright; a custom type that still has seasonal assignments must be merged into another active type (reassign, then delete). Built-in types can never be deleted or merged.",
        "Before merging, check the Xero-rule warning: reassigned members keep their Xero contact-group membership until the next periodic Xero reconciliation.",
      ],
      [
        {
          name: "Booking behavior",
          description:
            "Controls member-rate, non-member-rate, or block-booking behavior for this type.",
        },
        {
          name: "Subscription behavior",
          description:
            "Controls whether this type requires a subscription invoice.",
        },
        {
          name: "Allowed age tiers",
          description:
            "Limits the age bands that can use the membership type.",
        },
        {
          name: "Xero rule mode",
          description:
            "Managed means sync adds matching members to the group; Accepted means the group is allowed if present but is not enforced by sync.",
        },
        {
          name: "Xero age scope",
          description:
            "Restricts a rule to one age tier or applies it to every allowed age tier for the membership type.",
        },
      ],
      [],
      [
        {
          title: "Xero rules",
          details: [
            "A membership-type Xero rule links this type to a Xero contact group, separately from age-tier Xero groups.",
            "Managed rules actively add matching members to the selected group during Xero membership sync.",
            "Accepted rules tolerate the selected group when it is already present, but sync will not add members to it.",
            "The age scope and Xero group together define where the rule applies; only one Managed rule is allowed for the same age scope.",
            "Changing type rules or merging types does not synchronously resync existing members. They reconcile through the existing periodic and mismatch tooling.",
          ],
        },
      ],
    ),
  ),
  entry(
    "/admin/rooms-beds",
    help(
      "Rooms & Beds",
      "Rooms & Beds configures lodge room and bed inventory used by capacity and bed allocation.",
      [
        "Create or edit rooms and beds to match the physical lodge layout.",
        "Import from config only when you intend to align database beds to configured defaults.",
        "Deactivate beds rather than deleting history where existing allocations may refer to them.",
      ],
      [
        {
          name: "Room",
          description:
            "A physical lodge room containing one or more beds.",
        },
        {
          name: "Bed",
          description:
            "An individual bed that can be allocated to a guest.",
        },
        {
          name: "Active",
          description:
            "Controls whether a room or bed participates in future allocation.",
        },
      ],
    ),
  ),
  entry(
    "/admin/member-fields",
    help(
      "Member Fields",
      "Member Fields controls optional member-profile fields and how they appear in profile or admin workflows.",
      [
        "Review which fields are required, optional, hidden, or admin-only.",
        "Change field visibility only when membership policy or data collection needs change.",
        "Test profile editing after changing required fields.",
      ],
      [
        {
          name: "Required",
          description:
            "Members must provide this value when the field is shown.",
        },
        {
          name: "Visible",
          description:
            "Controls whether the field appears to members, admins, or both.",
        },
        {
          name: "Field label",
          description:
            "The wording users see beside the field.",
        },
      ],
    ),
  ),
  entry(
    "/admin/booking-messages",
    help(
      "Booking Messages",
      "Booking Messages edits reusable wording shown or sent during booking workflows.",
      [
        "Open the message template that matches the booking state or action.",
        "Use previews to confirm token output and member-facing wording.",
        "Reset to defaults only when you intentionally want to discard custom wording.",
      ],
      [
        {
          name: "Template",
          description:
            "The message slot used by a booking workflow.",
        },
        {
          name: "Subject and body",
          description:
            "The email or UI wording members see.",
        },
        {
          name: "Tokens",
          description:
            "Supported placeholders replaced with booking, member, or club values.",
        },
      ],
    ),
  ),
  entry(
    "/admin/committee",
    help(
      "Committee",
      "Committee manages master roles, role email aliases, and public/member-visible committee assignments.",
      [
        "Create or archive master roles before assigning members to them.",
        "Set public display flags deliberately; new assignments should stay hidden until reviewed.",
        "Use role email aliases for public contact routing when privacy matters.",
        "When an assignment is Contactable, choose per assignment whether public contact messages route to the committee role email, the member's own email, or a custom address (role falls back to the member email when the role alias is blank).",
      ],
      [
        {
          name: "Master role",
          description:
            "The reusable committee position, such as president or bookings officer.",
        },
        {
          name: "Assignment",
          description:
            "Links a member to a role with display and contact flags.",
        },
        {
          name: "Role email alias",
          description:
            "A server-side contact address used before any member-email fallback.",
        },
      ],
    ),
  ),
  entry(
    "/admin/club-time",
    help(
      "Club Time Zone",
      "Club Time Zone records the single time zone this club runs on — the place whose clocks and daylight-saving rules the site keeps. It is the setting the whole product is moving onto; for now the times the site shows are still worked out from the TZ setting this deployment starts with, so keep the two the same.",
      [
        "Check the time zone here before launch, and again if the club ever moves.",
        "Choose the named place the club keeps time by, such as Pacific/Auckland, rather than an abbreviation or a fixed offset.",
        "Read the consequences and tick the acknowledgement before saving; only a Full Admin can change it, and every change is recorded in the audit log with the old and new zone.",
      ],
      [
        {
          name: "Club time zone",
          description:
            "The named place the club keeps time by, stored as an IANA identifier such as Pacific/Auckland. Daylight saving is handled for you, because the name carries the rules for that place.",
        },
        {
          name: "Not the server's time zone",
          description:
            "This is a property of the club, not of the machine the site runs on and not of whoever is looking. A member reading the site from another country sees club time, not their own.",
        },
        {
          name: "Last changed",
          description:
            "When the time zone was last saved, and who saved it. The name is blank when nobody chose it by hand — the zone recorded automatically on the first start after upgrading has no administrator behind it, and neither does one set by npm run setup at the command line.",
        },
      ],
      [
        "Changing the time zone does not move anything already recorded. Dates and times in the database stay exactly as they are. What changes is which zone times are written in from then on, and the club-local hour overnight jobs run at — following the note above about TZ while both settings exist.",
        "Lodge nights keep the calendar dates they already have. A booking for the 14th is still a booking for the 14th.",
        "Abbreviations such as NZT or EST and fixed offsets such as +12:00 are refused. They name no place, so they carry no daylight-saving rules and would silently drift an hour twice a year.",
      ],
    ),
  ),
  entry(
    "/admin/access-roles",
    help(
      "Access roles and admin areas",
      "Access roles grant per-area admin access at one of three levels — none, view, or edit. Assign one or more roles to a member; their effective access is the strongest level each role grants per area.",
      [
        "Open a role to set its per-area access, or create a custom role, then assign roles to members from the member editor.",
        "Give the least access that does the job: view where a role only needs to read, edit only where it must change records.",
        "Deleting or narrowing a role changes every current holder — check who holds it before you save.",
      ],
      [
        {
          name: "Admin Overview",
          description:
            "Dashboard and cross-area entry points, including the pending-counts badges.",
        },
        {
          name: "Bookings & Beds",
          description:
            "Bookings, booking requests, policies, waitlist, bed allocation, seasons, age tiers, and promo codes.",
        },
        {
          name: "Membership",
          description:
            "Members, applications, families, memberships, inductions, communications, committee, lockers, and member lodge-access.",
        },
        {
          name: "Finance",
          description:
            "Payments, subscriptions, refunds, reports, Xero sync, accounting setup, and member credits.",
        },
        {
          name: "Lodge Operations",
          description:
            "Hut leaders, rosters, chores, work parties, lodge settings, and lodges.",
        },
        {
          name: "Content",
          description:
            "Public page content, site chrome, banners, images, and site style.",
        },
        {
          name: "Support & System",
          description:
            "Setup, modules, health, deliverability, audit, issue reports, and booking messages.",
        },
      ],
      [
        "Each area grants none, view, or edit. Edit implies view; anything other than a read requires edit, and a read-only page needs only view.",
        "A member can hold several roles; their access is the maximum level each role grants per area — levels merge upward and never subtract.",
        "The six seeded roles (Read-only Admin, Booking Officer, Membership Officer, Content Manager, Treasurer, Finance Viewer) are starting points you can edit or delete; an edit applies to every holder on their next request.",
        "Full Admin is a protected role with edit everywhere. Its permissions are never editable, and you cannot demote or deactivate your own account. No admin action that deactivates, de-logins, or archives an account — member edit, bulk update, archive, deletion approval, membership cancellation, login-holder transfer, or dependent linking — can remove the last active Full Admin, and only a Full Admin can perform those actions on another account that holds privileged access, so a scoped admin (such as a Membership Officer) cannot lock admins out this way. Still keep a second Full Admin account for continuity.",
      ],
    ),
  ),
];
