# UX Flow Map

Audience: Developer, Agent, Operator.

Find a screen by area, then follow its journey. Routes identify screens; linked
operator and member guides own detailed tasks, permissions and screenshots.
This map does not redefine booking, payment or membership rules.

## Find an area

- [Public and member screens](#public-and-member-screens)
- [Admin overview](#admin-overview)
- [Bookings](#admin-bookings)
- [Membership](#admin-membership)
- [Lodge operations](#admin-lodge)
- [Finance and integrations](#admin-finance)
- [Content and appearance](#admin-content)
- [Support and setup](#admin-support)
- [Shared screen patterns](#shared-screen-patterns)

Every admin area in the [coverage matrix](COVERAGE_MATRIX.md) has a screen
section below, including redirects and the developer-only testing area.
Within an area, find a route with your editor’s search. The sidebar can group
these screens differently; the route and linked guide identify the destination.

The admin [command palette](guides/dashboard.md#find-any-page-fast-command-palette)
(Ctrl or Cmd + K) offers every screen below that is a page in its own right,
grouped by hub, to the admins who may open it. Detail, print, redirect,
testing and template-preview screens are reached from their list instead. A
lodge-scoped screen opened from it starts on the club’s first lodge.
Admin areas require their configured view permission; editing requires the
corresponding edit permission, and some actions require Full Admin. Hidden
modules and lodge scope can further limit what appears.

History links point to an archived snapshot of the previous map, preserving
issue rationale without making old screen states current guidance. New work
updates the relevant screen and guide, rather than appending an issue diary.
The map has a word ceiling enforced by `docs:indexcheck`; detailed
rules belong in the linked references. See the [budget register](invariants/WORD_BUDGETS.md#screen-map).

## Public and member screens

### Home and sign-in

Screen: `/`, `/login`.

Journey: Browse club information, sign in, or follow account recovery. After sign-in, complete any required security or profile steps before opening the dashboard.

[Guide](user-guide/your-account.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Membership application

Screen: `/join/apply`.

Journey: Fill in personal details and nominators, submit the application, and follow the emailed nomination and account-setup steps.

[Guide](user-guide/joining-the-club.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Member dashboard

Screen: `/dashboard`.

Journey: Read upcoming stays and account notices, then open a booking or choose Book a Stay. The Lodge Kiosk card offers Open Kiosk and, while the roster module is on, Who's at the lodge.

[Guide](user-guide/README.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Book a Stay

Screen: `/book`.

Journey: Choose lodge and nights, add guests, review the price and rules, then confirm and follow the offered payment step. If a rule blocks the stay, use the available exception-request journey.

[Guide](user-guide/booking-a-stay.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### My Bookings and booking detail

Screen: `/bookings`, `/bookings/[id]`.

Journey: Find a stay and open its detail. Review status, guests and amounts before paying, requesting a change or cancelling. Pending consent appears on the booking for an eligible invited member.

[Guide](user-guide/changing-or-cancelling-a-booking.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Payment and booking outcome

Screen: Booking detail and its payment action.

Journey: Open the booking, inspect what is owed and choose an available payment method. Read the resulting status before leaving; bank payments can remain pending while settlement is checked.

[Guide](user-guide/paying-for-your-stay.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Guest consent

Screen: Booking detail, including `#consent`, or the emailed response link.

Journey: Read the organiser, lodge, dates, your nights and response deadline. Accept or decline using the available controls; a refusal explains who can act if you cannot.

[Guide](user-guide/being-added-to-a-booking.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Waitlist and offers

Screen: My Bookings and the offered booking.

Journey: Join the waitlist for full nights, open an offer, and accept before its deadline. Check the booking status and any payment action afterward.

[Guide](user-guide/waitlist-and-offers.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Profile and account security

Screen: `/profile`.

Journey: Use the section rail to open personal details, sign-in security, notification preferences or privacy controls. Stage and save the relevant section.

[Guide](user-guide/your-account.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Family and household

Screen: Family Group and Partner sections of `/profile`.

Journey: Request to join or create a family group, manage eligible dependants, or declare a partner. Review the relationship and billing implications before submitting.

[Guide](user-guide/managing-your-family.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Who’s at the lodge

Screen: `/lodge-roster`.

Journey: When enabled, open it from the dashboard's Lodge Kiosk card, choose the lodge card and read names and nights for the next 30 nights. Name visibility follows that lodge’s setting; contact and payment details are absent.

[Guide](user-guide/whos-at-the-lodge.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Message board

Screen: `/message-board`.

Journey: When enabled, read recent posts, page to older posts, or compose a message. Review whether sharing with other clubs is available and selected before posting.

[Guide](user-guide/the-message-board.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

## Admin overview

### AI Diagnostics deployment and operator guide — ai-diagnostics

Screen: `/admin/ai-diagnostics`.

Shows: Diagnostic access, provisioning and deployment information.

Journey: Inspect diagnostic access and follow the deployment guide to provision it.

[Guide](ai-diagnostics/deployment.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Admin Dashboard — dashboard

Screen: `/admin/dashboard`.

Shows: Attention queues, headline statistics, recent bookings and quick-action links.

Journey: Scan attention cards, follow a queue, or use a quick action to open its screen.

[Guide](guides/dashboard.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Testing — testing

Screen: `/admin/testing`.

Shows: A development-only error-boundary probe.

Journey: Developer-only route-error probe; production returns Not Found. It is not an officer journey.

[History](UX_FLOW_HISTORY.md#journey-inventory)

## Admin bookings

### Age Groups — age-tier-settings

Screen: `/admin/age-tier-settings`.

Shows: Age-tier labels, boundaries and guest eligibility settings.

Journey: Review age boundaries and labels before changing how guests are classified.

[Guide](guides/age-tier-settings.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Bed Allocation — bed-allocation

Screen: `/admin/bed-allocation`.

Shows: A lodge-and-night board of guests, rooms, beds and allocation state.

Journey: Choose lodge and nights, inspect guests and beds, preview moves or removals, then apply.

[Guide](guides/bed-allocation.md) · [History](UX_FLOW_HISTORY.md#reviewed-bed-allocation-moves-2595)

### Book on Behalf — book

Screen: `/admin/book`.

Shows: The booking wizard with an officer-selected booking owner.

Journey: Choose a member, lodge, dates and guests; review the booking before submitting.

[Guide](guides/book.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Booking Requests — booking-approvals

Screen: `/admin/booking-approvals`.

Shows: A redirect into the shared request queue’s Approvals tab.

Journey: Follow the redirect into the Approvals tab of Booking Requests.

[Guide](guides/booking-requests.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Booking Requests — booking-change-requests

Screen: `/admin/booking-change-requests`.

Shows: A redirect into the shared request queue’s Changes tab.

Journey: Follow the redirect into the Changes tab of Booking Requests.

[Guide](guides/booking-requests.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Booking Policies — booking-policies

Screen: `/admin/booking-policies`.

Shows: Booking rules and cancellation-policy settings.

Journey: Review booking rules and cancellation policies before staging a change.

[Guide](guides/booking-policies.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Booking Requests — booking-requests

Screen: `/admin/booking-requests`.

Shows: Tabbed request queues and request details with their current status and actions.

Journey: Choose a queue tab, open a request, inspect the proposed stay, and use its available actions.

[Guide](guides/booking-requests.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Bookings — bookings

Screen: `/admin/bookings`.

Shows: A filterable booking list; booking detail holds the stay, party, status and next actions.

Journey: Filter the list, open a booking, and inspect its dates, guests and status before acting.

[Guide](guides/bookings.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Bookings Setup — bookings-setup

Screen: `/admin/bookings-setup`.

Merged in (#4796): `/admin/setup/booking-rules` redirects here.

Shows: Cards linking to the booking configuration screens, each shown only to an admin who can open it, and the Member guests settings card.

Journey: Open the relevant setup card for policies, seasons, age groups, promo codes, rooms and beds, or booking copy.

[Guide](guides/bookings-setup.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Fees — fees

Screen: `/admin/fees`.

Shows: Consolidated fee sections with their own permission requirements.

Journey: Review the relevant fee section; stage changes using its permission controls.

[Guide](guides/fees.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Promo Codes — promo-codes

Screen: `/admin/promo-codes`.

Shows: Promotion codes, validity windows and redemption limits.

Journey: Inspect a promotion’s dates and limits before creating or editing a code.

[Guide](guides/promo-codes.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Seasons — seasons

Screen: `/admin/seasons`.

Shows: Season date ranges and lodge rates.

Journey: Choose a lodge and season, inspect dates and rates, and stage changes.

[Guide](guides/seasons.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Waitlist — waitlist

Screen: `/admin/waitlist`.

Shows: Queued bookings, offers and their status.

Journey: Inspect queued stays and offers, open the booking, and use the available queue actions.

[Guide](guides/waitlist.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

## Admin membership

### Committee — committee

Screen: `/admin/committee`.

Shows: Committee roles and assignments, with role and assignment editors.

Journey: Inspect assignments; open Add or Edit Role and save the validated form.

[Guide](guides/committee.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Communications — communications

Screen: `/admin/communications`.

Shows: Member communication composition and audience selection.

Journey: Choose recipients and compose a message; review the audience before sending.

[Guide](guides/communications.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Message Board — message-board

Screen: `/admin/message-board`.

Shows: Club messages and moderation controls.

Journey: Read club posts and use the moderation actions allowed by the current role.

[Guide](guides/message-board.md) · [History](UX_FLOW_HISTORY.md#club-message-board-2994-epic-2992)

### Member notices — notices

Screen: `/admin/notices`.

Shows: Member notices, audiences and visibility controls.

Journey: Choose an audience, compose a notice, and review its visibility before publishing.

[Guide](guides/member-notices.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Deletion Requests — deletion-requests

Screen: `/admin/deletion-requests`.

Shows: Pending account-deletion requests and their review details.

Journey: Inspect a request and its member record before resolving it.

[Guide](guides/deletion-requests.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Family Groups — family-groups

Screen: `/admin/family-groups`.

Merged in (#4796): a Groups tab and a Suggestions tab (`?tab=suggestions`); `/admin/family-suggestions` redirects to the Suggestions tab.

Shows: Family memberships and billing relationships; on the Suggestions tab, suggested member relationships awaiting review.

Journey: Find a family, open its members, and review billing and relationship changes; or open Suggestions, inspect suggested relationships and decide whether to link them.

[Guide](guides/family-groups.md) · [Suggestions guide](guides/family-suggestions.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Induction — induction

Screen: `/admin/induction`.

Shows: Member induction records and checklist progress.

Journey: Inspect member induction progress and open the relevant checklist.

[Guide](guides/induction.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Lockers — lockers

Screen: `/admin/lockers`.

Shows: Lodge-scoped lockers, assignments and availability.

Journey: Choose a lodge, inspect lockers and assignments, and manage the selected locker.

[Guide](guides/lockers.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Member Applications — member-applications

Screen: `/admin/member-applications`.

Shows: Applications, nomination progress and officer decisions.

Journey: Open an application, review its details and nominations, and use the available decision actions.

[Guide](guides/member-applications.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Member Fields — member-fields

Screen: `/admin/member-fields`.

Shows: The club’s configurable member-field definitions.

Journey: Review the member fields collected by the club before changing their configuration.

[Guide](guides/member-fields.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Members — members

Screen: `/admin/members`.

Shows: A searchable member list and individual membership records.

Journey: Search or filter members, open a profile, and use its permitted membership actions.

[Guide](guides/members.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Cancellation Requests — membership-cancellations

Screen: `/admin/membership-cancellations`.

Merged in (#4796): a Requests tab and a Settings tab (`?tab=settings`); `/admin/membership-cancellation` and `/admin/setup/cancellation` redirect to the Settings tab.

Shows: The membership cancellation review queue; on the Settings tab, the cancellation copy and Xero handling.

Journey: Open a cancellation request and review its consequences before deciding it; or open Settings, from here or from Notifications & Email, to change the cancellation wording.

[Guide](guides/membership-cancellations.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Membership & Members setup — membership-setup

Screen: `/admin/membership-setup`.

Shows: Cards linking to membership configuration.

Journey: Open the appropriate membership configuration card.

[Guide](guides/membership-setup.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Membership Types — membership-types

Screen: `/admin/membership-types`.

Shows: Membership types and their eligibility and billing configuration.

Journey: Inspect a type, its eligibility and subscription settings before saving changes.

[Guide](guides/membership-types.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Subscription Lockout — subscription-lockout

Screen: `/admin/subscription-lockout`.

Shows: Lapsed-subscription rules and related notification settings.

Journey: Review the lapsed-subscription rules and member-facing wording.

[Guide](guides/subscription-lockout.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

## Admin lodge

### Events Calendar — calendar

Screen: `/admin/calendar`.

Shows: Club events and the controls for managing them.

Journey: Choose a date range, inspect events, and open an event to manage it.

[Guide](guides/calendar.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Chore Templates — chores

Screen: `/admin/chores`.

Shows: The selected lodge’s chore inventory.

Journey: Choose a lodge, inspect its chore list, and stage chore changes.

[Guide](guides/chores.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Lobby Display — display

Screen: `/admin/display`.

Shows: The lobby-display hub, device management, templates, layouts and previews.

Journey: Open Devices, Visual builder, Layouts, Templates or Reference from the display hub.

[Guide](guides/display.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Hut Leaders — hut-leaders

Screen: `/admin/hut-leaders`.

Shows: Lodge-night leadership assignments and coverage.

Journey: Choose lodge and nights, inspect cover, and manage eligible assignments.

[Guide](guides/hut-leaders.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Lodge Kiosk — lodge

Screen: `/admin/lodge`.

Shows: Lodge operational settings and kiosk entry points.

Journey: Inspect lodge operations and open the kiosk or related operational screen.

[Guide](guides/lodge.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Lodge Instructions — lodge-instructions

Screen: `/admin/lodge-instructions`.

Shows: Lodge instructions and supported content tokens.

Journey: Choose lodge content, preview the instructions, and save staged wording.

[Guide](guides/lodge-instructions.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Lodges — lodges

Screen: `/admin/lodges`.

Shows: The lodge list and each lodge’s settings and feature controls.

Journey: Choose a lodge, open its settings, and manage only that lodge’s configuration.

[Guide](guides/lodges.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Lodge Maintenance — maintenance-reports

Screen: `/admin/maintenance-reports`.

Shows: Lodge faults, their descriptions and resolution state.

Journey: Filter faults by lodge and status, inspect a report, then record the next action.

[Guide](guides/maintenance-reports.md) · [History](UX_FLOW_HISTORY.md#lodge-maintenance-reports-2780)

### Rooms & Beds — rooms-beds

Screen: `/admin/rooms-beds`.

Shows: Lodge-specific rooms and beds, plus allocation preferences.

Journey: Choose a lodge, manage its room and bed inventory, and stage allocation preferences.

[Guide](guides/rooms-beds.md) · [History](UX_FLOW_HISTORY.md#bed-allocation-preferences-2593-relocated-2937)

### Chore Roster — roster

Screen: `/admin/roster`.

Shows: A day roster including arrivals, departures and staged chore assignments.

Journey: Choose a lodge and day, inspect arrivals and departures, stage roster edits, then save or cancel.

[Guide](guides/roster.md) · [History](UX_FLOW_HISTORY.md#whole-roster-staged-editing-2586)

### Work Parties — work-parties

Screen: `/admin/work-parties`.

Shows: Work-party dates, participation and attendance.

Journey: Inspect a work party, its participants and attendance before recording changes.

[Guide](guides/work-parties.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

## Admin finance

### Integrations — alpine-server

Screen: `/admin/alpine-server`.

Shows: Central-server registration and synchronisation status.

Journey: Review the central-server connection and its synchronisation state.

[Guide](guides/integrations.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Fees — fee-configuration

Screen: `/admin/fee-configuration`.

Shows: A redirect to the shared fee editor.

Journey: Follow the redirect to the consolidated Fees screen.

[Guide](guides/fees.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Integrations — google

Screen: `/admin/google`.

Shows: The Google sign-in setup wizard and connection verification.

Journey: Open the setup wizard, verify the sign-in credentials, and review connection status.

[Guide](guides/integrations.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Integrations — integrations

Screen: `/admin/integrations`.

Shows: Provider connection cards and setup links.

Journey: Inspect provider cards and open the appropriate setup or status screen.

[Guide](guides/integrations.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Internet Banking — internet-banking

Screen: `/admin/internet-banking`.

Shows: Bank-payment instructions and configuration.

Journey: Review bank-payment configuration and the instructions members will see.

[Guide](guides/internet-banking.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Payments — payments

Screen: `/admin/payments`.

Shows: Payment records, statuses and links to related bookings.

Journey: Filter payments, open a record, and inspect its booking and provider status.

[Guide](guides/payments.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Refunds & Credits — refund-requests

Screen: `/admin/refund-requests`.

Shows: Refund requests with booking context and decision controls.

Journey: Open a request, inspect the booking and amounts, then use the permitted decision action.

[Guide](guides/refund-requests.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Reports — reports

Screen: `/admin/reports`.

Shows: Financial summaries, period filters and exports.

Journey: Choose a report, set the period and filters, then inspect or export the result.

[Guide](guides/reports.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Integrations — stripe

Screen: `/admin/stripe`.

Shows: The Stripe setup wizard and its verification results.

Journey: Open the setup wizard, review each connection step, and verify status.

[Guide](guides/integrations.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Subscriptions — subscriptions

Screen: `/admin/subscriptions`.

Shows: Subscription billing records and statuses.

Journey: Filter subscription records and open the member or billing record for details.

[Guide](guides/subscriptions.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Events Calendar — video-meetings

Screen: `/admin/video-meetings`.

Shows: Calendar-linked video meeting controls.

Journey: Open the linked calendar event and join or manage its video meeting.

[Guide](guides/calendar.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Xero Sync — xero

Screen: `/admin/xero`.

Shows: Connection setup, the health snapshot (including credit used in Xero outside the app), accounting operations and failure details.

Journey: Inspect connection and operations status; open a failed item to follow its documented recovery.

[Guide](guides/xero.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

## Admin content

### Site Appearance & Content — appearance

Screen: `/admin/appearance`.

Shows: Theme presets and links to club identity controls.

Journey: Choose a preset or open the identity editor; preview before saving.

[Guide](guides/appearance.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Image Manager — image-manager

Screen: `/admin/image-manager`.

Shows: Reusable content images and upload controls.

Journey: Browse images, upload an asset, and select it for the intended content.

[Guide](guides/image-manager.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Mountain Conditions — mountain-conditions

Screen: `/admin/mountain-conditions`.

Shows: The conditions content displayed on the public site.

Journey: Inspect the public conditions content, stage an update, and publish it.

[Guide](guides/mountain-conditions.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Page Content — page-content

Screen: `/admin/page-content`.

Shows: Editable public pages and supported authoritative tokens.

Journey: Choose a public page, edit supported content and tokens, then preview and save.

[Guide](guides/page-content.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Site Banners — site-banners

Screen: `/admin/site-banners`.

Shows: Public banner text and visibility settings.

Journey: Choose banner content and visibility, preview it, then save.

[Guide](guides/site-banners.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Site Content — site-content

Screen: `/admin/site-content`.

Shows: Links to public content editors.

Journey: Open the relevant public-content editor from the hub.

[Guide](guides/site-content.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Site Style — site-style

Screen: `/admin/site-style`.

Shows: Theme settings and their preview.

Journey: Preview the theme settings and save the staged appearance.

[Guide](guides/site-style.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

## Admin support

### Access Roles — access-roles

Screen: `/admin/access-roles`.

Shows: Role definitions and their permission assignments.

Journey: Inspect a role, review its permissions, then stage and save changes.

[Guide](guides/access-roles.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### AI Help Assistant — ai-assistant

Screen: `/admin/ai-assistant`.

Shows: Assistant configuration, usage and spending controls.

Journey: Read usage and the spend cap before changing the assistant settings.

[Guide](guides/ai-help.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Audit Log — audit-log

Screen: `/admin/audit-log`.

Shows: Searchable events with actor, category and affected record.

Journey: Filter events, open an entry, and follow the affected record.

[Guide](guides/audit-log.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Background Jobs — background-jobs

Screen: `/admin/background-jobs`.

Shows: Scheduled jobs and their latest execution results.

Journey: Inspect schedules and recent runs before running an eligible job.

[Guide](guides/background-jobs.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Database Backups — backups

Screen: `/admin/backups`.

Shows: Backup configuration, available backups and recovery controls.

Journey: Inspect backup status and follow the documented download or restore procedure.

[Guide](guides/backups.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Booking Messages — booking-messages

Screen: `/admin/booking-messages`.

Shows: Configurable booking-related messages.

Journey: Read the booking message settings, stage the wording, and save.

[Guide](guides/booking-messages.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Club Currency & Locale — club-format

Screen: `/admin/club-format`.

Shows: The club’s country, currency and related format settings.

Journey: Read the club format; Full Admin can review and change the format.

[Guide](guides/club-format.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Club Time Zone — club-time

Screen: `/admin/club-time`.

Shows: The club timezone and the consequences of changing it.

Journey: Full Admin reviews the club timezone before saving a change.

[Guide](guides/club-time.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Environment Safety — environment

Screen: `/admin/environment`.

Shows: The installation’s declared environment and safety override.

Journey: Full Admin reviews environment identity and the controls for this deployment.

[Guide](guides/environment-role.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Export & Import (config transfer) — config-transfer

Screen: `/admin/config-transfer`.

Shows: Configuration export and import controls.

Journey: Export configuration or inspect an import before applying it.

[Guide](guides/config-transfer.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Email Deliverability — email-deliverability

Screen: `/admin/email-deliverability`.

Shows: Email delivery results and eligible retry controls.

Journey: Filter delivery outcomes and inspect a failure before retrying eligible mail.

[Guide](guides/email-deliverability.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Email Messages — email-messages

Screen: `/admin/email-messages`.

Shows: Email templates, editable wording and supported tokens.

Journey: Choose a message template, inspect its tokens, and stage wording changes.

[Guide](guides/email-messages.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### System Health — health

Screen: `/admin/health`.

Merged in (#4796): `/admin/setup/integrations` redirects to its Integration readiness section.

Shows: The provider setup pages (Xero, modules, email deliverability) as readiness cards, then component health and diagnostic results.

Journey: Inspect health checks and follow the documented recovery for a failing component.

[Guide](guides/health.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Issue Reports — issue-reports

Screen: `/admin/issue-reports`.

Shows: Reported problems, evidence and triage status.

Journey: Filter reports, open the evidence, and update the report status.

[Guide](guides/issue-reports.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Modules — modules

Screen: `/admin/modules`.

Shows: Feature switches and their setup prerequisites.

Journey: Review each module’s purpose and prerequisites before enabling or disabling it.

[Guide](guides/modules.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Recipients — notification-recipients

Screen: `/admin/notification-recipients`.

Shows: Recipient assignments for club notifications.

Journey: Review the officers or addresses receiving each notification.

[Guide](guides/notification-recipients.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Delivery Rules — notification-rules

Screen: `/admin/notification-rules`.

Shows: Notification delivery policies and switches.

Journey: Choose a notification, review its delivery rules, and save staged changes.

[Guide](guides/notification-rules.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Notifications & Email — notifications

Screen: `/admin/notifications`.

Shows: Links to notification, recipient and email configuration.

Journey: Open the relevant notification settings or delivery screen from the hub.

[Guide](guides/notifications.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Personal-data retention schedule — privacy-retention

Screen: `/admin/privacy-retention`.

Shows: Retention settings, eligible-record previews and cleanup actions.

Journey: Preview eligible records before running the documented retention action.

[Guide](PRIVACY_RETENTION.md) · [History](UX_FLOW_HISTORY.md#privacy-and-retention-4457)

### Login & Security — security

Screen: `/admin/security`.

Shows: Sign-in and account-security configuration.

Journey: Inspect authentication controls and use the permitted security settings.

[Guide](guides/security.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Setup — setup

Screen: `/admin/setup`.

Shows: The installation setup hub and configuration cards.

Journey: Open the setup card for the configuration task you need.

[Guide](guides/setup.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

### Stuck States — stuck-states

Screen: `/admin/stuck-states`.

Shows: Operational incidents and guided repair actions.

Journey: Inspect flagged records and use the documented recovery for the selected state.
A card refund Stripe gave up on is settled on its row, never with a new Stripe
dashboard refund (#4368): **Paid another way**, or **Try the card again** after a
confirm dialog; a row a later Stripe refund covers reads "nothing left owed" and
offers only **Nothing left owed**, whose dialog names that refund. Each is
view-only without Finance edit.

[Guide](guides/stuck-states.md) · [History](UX_FLOW_HISTORY.md#journey-inventory)

## Shared screen patterns

### Admin navigation panels

Screen: every `/admin` page and the `/finance` workspace.

Shows: a sidebar panel for each role held — Admin (the full menu), Bookings,
Membership, Content, Finance or Treasurer — chosen from each role's permission
matrix, never its name. Staff pages drop Book and My Bookings from the top
bar, an Admin account that is not also a club member never sees My Bookings
there, and the sidebar leaves
both dashboards to the top bar. Who's at the lodge is a Lodge Kiosk card button
on `/dashboard`, not a top-bar link.

Journey: open a staff page on the first panel, or use the switcher's buttons
when more than one role gives a panel; the choice is remembered per browser. A
panel only narrows the per-item permission filter, so it never shows a link the
full menu would hide; other pages stay reachable through Ctrl K.

[Guide](guides/access-roles.md)

## Feedback Conventions

One rule for "did that work?" feedback, so the affordance is predictable on
every screen:

- **Toasts (sonner, mounted globally in `app-providers.tsx`)** for simple
  action confirmations and failures — a button was clicked, the action
  succeeded or failed, there is nothing further to read or fix in place
  (e.g. "Invitation sent", "Profile updated", "Banner deleted").
- **Inline `Alert` (`src/components/ui/alert.tsx`)** for persistent page state
  the user must act on in place: validation errors pointing at form fields,
  multi-step flow outcomes that carry next-step content (cancellation
  summaries, nomination confirmations), and long admin forms — pair those with
  the `use-scroll-to-feedback` hook so the banner is brought into view. Use its
  four variants (`info`/`success`/`warning`/`error`), each of which pairs a
  lucide icon with its text so status is never signalled by colour alone, and
  reads the semantic tokens so it adapts to dark mode. Prefer `Alert` over
  hand-rolled coloured banner `<div>`s.
- **Destructive confirmations** use `useConfirm()` from
  `src/components/confirm-dialog.tsx`, never `window.confirm`. Lint enforces
  it (`design-system/no-native-confirm`), with today's calls on a ratchet.

New code follows this rule; existing inline success panels are converted
opportunistically when a file is already being touched.

## Forms (#4467)

A form is built on the shared form layer: shadcn's Form primitives over
react-hook-form, validated by a zod schema (owner decision, 27 Oct 2026). The
layer decides three things once, so no form has to:

- **Each field's error is tied to its control.** `aria-invalid` is set while
  the field fails, and `aria-describedby` names the error first, then any id
  the caller passes, then the field's example, the order `FieldHint` fixed
  in #2257.
- **A failed submit is listed at the top of the form, and the list takes
  focus.** `FormErrorSummary` is a `role="alert"` that shows each error as a
  link that moves focus to its field. Focus moves only when a submit
  completes, never while the person types. Between submits its text never
  changes: an entry keeps the message it had at the submit and only
  disappears once its field is fixed. The inline message shows the field's
  current state.
- **The browser and the API route check the same rules.** The schema lives in
  `src/lib/forms/<name>-schema.ts`, imports nothing but `zod`, and is imported
  by the route and the form. `shared-form-schema-census.test.ts` fails a
  schema that either side stops using. `src/lib/club-theme-update-schema.ts`
  shares a schema between a route and a page the same way but predates this
  convention, so it sits outside `src/lib/forms/` and the census.

The committee page's **Add / Edit Role** form is the worked example: its
schema module is `src/lib/forms/committee-role-schema.ts`, and its form is
`src/app/(admin)/admin/committee/_components/committee-role-form.tsx`.

### Building a form

1. **Write the schema** in `src/lib/forms/`. Keep each field's rule as a
   constant, and build from them the route's wire schema (or one per route:
   `POST` with its defaults, `PATCH` with every field optional and no
   defaults) and the form's schema. The form's schema takes what the controls
   hold and outputs the payload the route accepts; for example, an empty text
   box becomes `null`. Write each message as the fix ("Enter a role name"),
   because the summary shows it without the field's label.
2. **Parse with it in the route**, and answer a refusal the existing way:
   `{ error: "Invalid input", details: parsed.error.flatten() }` with a 400.
   New routes use this shape; the member routes' bare `fieldErrors` shape
   (`details: parsed.error.flatten().fieldErrors`, with a 422) is also read.
3. **Build the form** with `useZodForm(schema, { defaultValues })` from
   `src/hooks/use-zod-form.ts`. It also turns off react-hook-form's own
   focus-the-first-error, which would take focus back from the summary.
   Render `<Form {...form}>`, then a `<form noValidate>` with
   `<FormErrorSummary />` before the fields. Each field is a `FormField`
   whose `render` returns a `FormItem` holding `FormLabel`, `FormControl`
   around exactly one primitive (`Input`, `Textarea`, `Checkbox`…), then
   `FormMessage` and, for an example, `FormDescription`. Pass any further
   description id, such as a view-only reason, as `aria-describedby` on
   `FormControl`, not on the control: the control's own would replace the
   error's.
4. **Map the route's answer back.** In the `handleSubmit` callback, call
   `applyServerValidationErrors(form, response.status, body)` on a refusal.
   It acts only on a 400 or 422 whose `details` is zod's `flatten()` shape,
   read by `readValidationDetails`, the one reader of that shape. Field
   messages go on their fields; form-level ones, and any for a key the form
   does not render, show unlinked in the summary. It returns `false` for
   anything else (a 403, a 500, a 400 with no zod `details`): show the
   route's `error` as before, through the page's `role="alert"` banner and
   `useActionAttention`. Call it before the
   callback returns, because the summary takes focus when the submit
   completes.

A staged settings section keeps `useSectionEditState` and every rule in
[`ARCHITECTURE.md`](ARCHITECTURE.md#adminmember-layer) when it adopts the
layer.

## Error and loading screens per area (#4467)

When a page fails, the person stays in the area they were using. Every route
group has its own `error.tsx`, rendered **inside** that group's layout, so an
officer keeps the admin sidebar and a member keeps the member navigation; only
the failed page is replaced. All of them are the one shared screen,
`src/components/route-error.tsx`:

- **Something went wrong**, with focus moved to that heading so a keyboard or
  screen-reader user hears it.
- **Try again** re-fetches the page from the server and re-renders it (Next's
  `retry`), so a passing fault recovers without a reload and the URL is kept.
- A link back to the area's own landing page, not the browser's previous page,
  which may be the page that failed, another site, or nothing on a kiosk.
- The error is reported to Sentry with its digest and the area, like the root
  screen. The message and stack are never shown; a server error shows only
  **Error ID** (the digest), which matches the server log line.

| Area | Boundary | "Back" goes to | Loading state while a page streams in |
| --- | --- | --- | --- |
| Admin (`/admin/*`) | `(admin)/error.tsx` | `/admin` | Per page only: bookings, dashboard, members |
| Member area (dashboard, bookings, profile, …) | `(authenticated)/error.tsx` | `/dashboard` | Per page only: dashboard, bookings, book, booking detail, consent |
| Finance (`/finance`) | `(finance)/finance/error.tsx` | `/finance` | `(finance)/finance/loading.tsx` |
| Lodge kiosk (`/lodge/*`) | `(lodge)/error.tsx` | `/lodge/kiosk` | None: the kiosk and roster fetch their own data on the client (hardening review F36: "do not add there") |
| Sign-in, registration, recovery and token pages | `(public)/error.tsx` | `/` | None |
| Public website | `(website)/error.tsx`, `(website-dynamic)/error.tsx` | `/` | None |

Every loading state is the shared `src/components/route-loading.tsx`: a polite
`status` region with a visually hidden label ("Loading bookings…") and skeleton
blocks hidden from assistive technology, in the theme's tokens for light and
dark.

Only finance has a loading state for its whole area (`(finance)/finance`, its
one page). The other six route groups have none at their root, on purpose,
because a group-level `loading.tsx` changes what the server does, not only what
the person sees while waiting:

- **It starts the response before any page has decided anything**, so a page's
  own "not found" or redirect arrives as a 200 instead of a 404 or 307 (Next's
  `loading.md`, "Status codes").
- **It makes every dynamic page in the group prefetchable** (Next's
  `prefetching.md`): a page is prefetched as its link scrolls into view only
  when it has a loading boundary.

Each group's reason, recorded in `src/lib/route-group-boundaries.ts`:

- **Admin**: every sidebar link would prefetch its page, each one running the
  admin layout's guard and database loads on every admin page view; the
  page-level not-found and redirect answers would become 200s; and every admin
  end-to-end spec would meet the streaming double-render flake. Bookings,
  dashboard and members keep their own placeholders.
- **Member area**: pages decide 404s themselves (an out-of-audience notice must
  be a real 404). The slow member pages keep their own placeholders.
- **Lodge kiosk**: the kiosk and roster fetch their data on the client, so a
  placeholder would never show on a fresh load, and the roster's redirect to the
  kiosk would become a client-side one (hardening review F36: "do not add
  there").
- **Sign-in, registration and recovery**: `/login`, `/login/verify`,
  `/login/enroll`, `/register` and `/membership-cancellation/[token]` redirect
  from the page.
- **Public website, both groups**: forbidden by
  `scripts/ci/check-website-render-modes.mjs` (#2352, #2434), because a missing
  page would become a soft 404 that the page store then keeps.

`src/lib/__tests__/route-group-boundaries.test.ts` holds the tree to those
answers: it fails if a new route group arrives without an error screen and a
loading decision, or if a group with a reason gains a `loading.tsx` (anywhere
in the group, except the admin and member areas, whose per-page ones stay).

## Back-link convention (admin drill-down leaves) (#2046)

Admin hubs (`/admin/setup`, `/admin/display`, `/admin/appearance`, …) open a
landing page of cards; each card drills into a **leaf** page. Every admin
drill-down leaf must render the shared `BackLink`
(`src/components/admin/back-link.tsx`) to its parent so a user — especially on a
kiosk/touch screen where there may be no browser history — always has a
predictable way back:

- **Static-hub leaves** (the common case) link to their fixed parent hub, e.g.
  the Lobby Display leaves (`devices`, `layouts`, `templates`, `reference`,
  `setup`) return to `/admin/display` and `preview` returns to
  `/admin/display/templates`.
- **Dynamic-parent leaves** (the documented exception) sit under a parent that is
  itself a record or a caller-provided origin rather than a fixed hub — the
  per-lodge `/admin/lodges/[id]/*` sub-pages, the member detail/merge pages, and
  the Xero record drill-down. `BackLink` already takes an arbitrary `href`/`label`,
  so these pass the resolved dynamic route (e.g. `/admin/lodges/${id}` or a
  sanitised `returnTo`) — no separate component is needed. Ad-hoc `ArrowLeft`
  buttons/links are normalised onto `BackLink` so the affordance looks and behaves
  the same everywhere.

The rule is frozen by two enforcement suites. Statically renderable leaves (the
static-hub ones plus the async Xero record page) are asserted in
`src/lib/__tests__/admin-leaf-back-links.test.tsx`; the client-gated dynamic
leaves (lodge config/setup and member detail/merge, which fetch on mount) are
asserted in the companion RTL suite
`src/lib/__tests__/admin-drilldown-back-links-client.test.tsx`. When you add a
new admin leaf, add its `BackLink` **and** extend whichever suite fits its render
model, so a leaf that loses its back link fails the build.


## Related links

- [Coverage matrix](COVERAGE_MATRIX.md)
- [Member guide](user-guide/README.md)
- [Developer index](contributors/README.md)
- [Archived issue history](UX_FLOW_HISTORY.md)
