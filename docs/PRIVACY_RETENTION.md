# Personal-data retention schedule

Audience: Operator, Developer, Adopter.

This is the club's complete Prisma-model schedule for personal data, including
indirect member links, officer attribution, free-text snapshots and cached
contacts. It records purpose, retention and the end action in one table.
“Keep” means retained for the stated membership, financial or operational
purpose; it does not introduce an automatic deletion period. Settings records
are personal because they retain the updating officer's identifier.

The starter Privacy Policy uses `{{email-log-retention}}` to describe the current
email-log setting on every render. Edited policy pages should use this token too;
see the [upgrade instructions](UPGRADING.md#correct-the-starter-privacy-policy-4914).

## Automatic retention and operator review

Four automatic jobs exist. Three cover old email logs, rejected membership
applications and former-member profile anonymisation. They ship **OFF**.
Their periods are club settings, with defaults of **2 years**, **1 year from
reviewedAt**, and **7 years from explicit leavingDate**, respectively. Review
counts and candidates in **Admin → Privacy retention** (`/admin/privacy-retention`)
before enabling them. Support view permission is required; member previews also
require membership view permission. Editing requires support edit permission; changes to member or application
periods and switches also require membership edit permission. The combined
email/application pruning switch therefore requires both permissions.

The preview checks at most 25 former-member candidates per page (plus one
lookahead), using a member-ID cursor and the same selector as the jobs. The
candidate total is a database count without blocker checks. Eligible and blocked
counts describe the current page; other group counts include all matching rows.

An inactive member without a leavingDate is **never automatically erased**.
Such members appear separately for officers to review and establish a departure
date from evidence. Inactivity, last login and cancellation timestamps are not
substitutes for an explicit leavingDate. Imported former members also retain
NULL until an officer explicitly records their leaving date. Anonymisation preserves stable IDs,
booking / payment links and financial references needed for reconciliation;
it does not promise to scrub every historical narrative or provider record.

The fourth job clears each stay's dietary/allergy note (`BookingGuest.dietaryRequirements`)
a club-set number of days after the stay ends, for member and non-member guests
alike and on a booking of any status (`INV-PRIV-023`). It **ships ON** with a
default of **30 days** (owner decision, 11 Nov 2026, on
[#4916](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/4916)), so
the first nightly run after a club upgrades clears every past stay's note whose
stay ended more than 30 days ago. A club that wants to keep them switches
**Enable after-stay dietary clearing** off before or as part of upgrading.
A stay that ends today or within the period keeps its note. The switch is
separate from the dietary field itself: turning the field off hides notes and
never clears them, and does not stop this job. Changing the period or switch
requires support edit and bookings edit permission. The page shows how many
notes the next run would clear, never the notes. A note an officer re-enters on
an older stay is cleared the next night. Cleared notes cannot be restored except
from a backup taken before the run.

Only those four jobs are added here. Existing token, audit, report,
communications and cron-run lifecycles continue under their own rules. A row
marked “keep” has no new automatic cleanup. Approved member erasure remains a
separate lifecycle. Backups and external providers have their own lifecycle;
see [backups](guides/backups.md), the
[audit retention runbook](AUDIT_RETENTION_ARCHIVE_RUNBOOK.md) and
[security notes](SECURITY.md).

## Answering an access request

Anyone may ask the club for a copy of the personal information it holds about
them. Two downloads produce the same file, from the same builder
(`INV-PRIV-025`):

- **A member** downloads their own copy from **Profile → Download My Data**,
  at most five times a day. Each download is recorded in their activity.
- **A Full Admin** produces the copy for anyone else from **Admin → Members →
  a member → Lifecycle & Deletion → Subject access report**. Only Full Admins
  see the card, the server checks the role again, and it asks you to confirm
  your sign-in first. Each officer may produce 20 reports a day. Every report is
  recorded in the audit log under `privacy`, naming you and the person.

The card finds the person three ways:

1. **This member**, including a dependant with no login: use
   **Download this member's report** on their own page.
2. **By email**, for a member, an applicant or someone who sent a booking
   request. If more than one member record uses the address (a parent and a
   dependant, say), the report is refused: open the right member's page instead.
3. **A non-member guest, by name.** Guest records hold no email address, so a
   guest cannot be found by email. Search their name, pick the stay they
   describe (name and dates), and download that row's report.
   Each stay is its own guest record, so a guest who stayed several times needs
   one report per stay.

Before you send a file, check who is asking:

- the request comes from the address on the record, or the person proves who
  they are another way (for a guest, by describing the stay);
- a parent or guardian asking for a dependant has the right to see the record;
- you send the file only to the person it is about, or to someone they
  authorised in writing.

What the file contains, and what it leaves out:

- Every personal record the club holds about the person, or a named exclusion
  with its reason in the file's `exclusions` list. Review the exclusions and add
  anything the person is owed by hand.
- Only the person's own rows. On a booking someone else made, the file shows the
  person's own guest row, never the other guests or the booker.
- Records filed by email address (email log, applications, booking requests)
  are withheld when the address belongs to another member record as well. The
  file says
  `emailKeyedRecords: withheld`; check those records by hand with the address's
  owner in mind.
- A member's whole-lodge booking request shows the status they see on "My
  requests" (pending, approved, declined or withdrawn), not the booking
  officer's working state, and no price. This follows the owner's decision of
  15 Nov 2026 on #4915. It assumes those officer-side fields are not personal
  information the member must be given; confirm that with the club's privacy
  adviser before relying on it.
- Money is in integer cents, labelled with the currency.

## Hidden details in uploaded images

Photos and drawings can carry hidden details: where a photo was taken, the
camera or phone, the owner's name, the author's file paths. The app removes them
before it stores any uploaded image, on every upload path: the image library,
the Image Manager, member photos, the club logo and a configuration restore
(#2242, #5244).

| Type | Removed | Kept |
| --- | --- | --- |
| JPEG, PNG, WebP | Everything not needed to draw the picture: EXIF (GPS, camera, owner, dates), XMP, IPTC, Content Credentials, comments, text chunks, embedded thumbnails, extra pictures appended after the main one | The picture, its colour profile, any animation, and the EXIF rotation alone so portraits stay upright |
| GIF | Comments, plain-text blocks, XMP and every other application block, anything after the end of the file | The frames, their timing and transparency, and the looping setting |
| AVIF (still) | EXIF and XMP items, every property and box not needed to draw the picture, the handler name, data-reference paths, unknown brand names | The picture and its colour information (`colr`, which can hold a colour profile); removed parts are blanked in place so the picture's bytes are unchanged |
| SVG | Metadata, comments, `title` and `desc`, editor attributes and file paths, scripts, event handlers, outside links, any text outside the drawing's text elements | The drawing: shapes, gradients, clips, masks, patterns, filters, styles, drawn text, and embedded photos cleaned the same way |

Two limits remain, because removing them would mean decoding or redrawing the
picture:

- **GIF picture data is copied as it is.** Each frame's compressed data is kept
  byte for byte, so bytes hidden after a frame's end-of-picture code, but
  inside its data blocks, survive. A normal image editor never writes any.
- **JPEG, PNG, WebP and AVIF keep their colour profile** (ICC profile). A profile is
  needed to show colours correctly, but its description and copyright text
  can name the device or the software that made it.

An upload is **refused**, with a plain message asking for a fresh copy from an
image editor, when the app cannot confirm it is clean: a damaged or truncated
file, an animated AVIF, a file that opens like an SVG but is not an SVG drawing
(for example, its root is not in the SVG namespace), or an
SVG that reaches outside itself (an `@import` or an outside `url()`). Nothing is stored in that case. A configuration restore
stops at its dry run and names the file.

**Images uploaded before this release are not altered** (owner decision,
20 Nov 2026, #5244). Anything already in the image library, the Image Manager's
folders, the club logo or a member photo may still carry hidden details until
it is uploaded again; [`image-manager.md`](guides/image-manager.md#cleaning-an-older-image)
says how.

**A photo stored sideways needs its original file.** JPEG, PNG and WebP
photos were already cleaned before #5244, and that earlier cleaning removed a
photo's rotation setting with the rest of its EXIF, so a phone portrait could
be stored sideways. The stored copy no longer has the setting, so uploading
that copy again leaves it sideways; uploading the original file keeps the
setting, and the photo shows upright.

**Uploading an image again does not reach older copies.** A library image
uploaded again is stored as a new image: the older one stays in the app, still
served at its old link, until it is deleted from the picker. An Image Manager
image, the club logo and a member photo are replaced. Older copies of these
kinds stay as they were either way:

- **Copies in browsers.** A browser that has already downloaded an image can go
  on showing its own copy. Library images and the club logo are served to be
  kept for up to a year under their link; uploading one again gives it a new
  link, so a page pointed at the new copy fetches the cleaned file. Image
  Manager images keep their link, and are served to be checked again after five
  minutes. Publicly shown member photos are served the same way; the committee
  page's link to a photo changes when the photo is replaced, so the page fetches
  the new one. A member photo that is not shown publicly is served with an
  instruction not to keep it.
- **Copies in backups.** A [database backup](guides/backups.md) holds library
  images, club logos and member photos as they were when it was taken, until it
  is pruned or deleted. Image Manager images are files on the server's disk,
  not in the database, so the database backup never holds them; any copy the
  host keeps of that folder is outside the app.
- **Copies in configuration exports.** A configuration export made earlier
  holds the library images and club logo it carried, as they were when it was
  made. A restore cleans them as it loads them.

## Model schedule

| Prisma model | Purpose / personal data | Retention period or retained purpose | End action |
| --- | --- | --- | --- |
| `Member` | Membership, identity, contact details, credentials and dietary information | While member; former members: default 7 years after explicit leavingDate, configurable, only when enabled | Anonymise eligible former profiles; keep stable IDs / financial references |
| `MemberAccessRole` | Member permissions and assigning officer | Kept while member / for membership administration; no new automatic deletion for this model | Keep |
| `PasswordResetToken` | Member authentication and recovery challenges | Until used / expired; existing token cleanup rules apply | Delete through existing token cleanup; otherwise keep until lifecycle cleanup |
| `MagicLinkToken` | Member authentication and recovery challenges | Until used / expired; existing token cleanup rules apply | Delete through existing token cleanup; otherwise keep until lifecycle cleanup |
| `EmailVerificationToken` | Member authentication and recovery challenges | Until used / expired; existing token cleanup rules apply | Delete through existing token cleanup; otherwise keep until lifecycle cleanup |
| `EmailChangeToken` | Member authentication and recovery challenges | Until used / expired; existing token cleanup rules apply | Delete through existing token cleanup; otherwise keep until lifecycle cleanup |
| `TwoFactorEmailCode` | Member authentication and recovery challenges | Until used / expired; existing token cleanup rules apply | Delete through existing token cleanup; otherwise keep until lifecycle cleanup |
| `TwoFactorRecoveryCode` | Member recovery credentials | While enrolled; used codes retained until recovery-code replacement / account cleanup | Delete on replacement / account cleanup |
| `TwoFactorSessionChallenge` | Member authentication and recovery challenges | Until used / expired; existing token cleanup rules apply | Delete through existing token cleanup; otherwise keep until lifecycle cleanup |
| `SessionReauthChallenge` | Proof a signed-in member just confirmed who they are | Until used or expired (two minutes); deleted with the member | Delete on use, expiry housekeeping, or member erasure |
| `WebAuthnCredential` | Passkey public key, name and use counter | While the member keeps the passkey; deleted with the member | Delete when the member removes it, or on member erasure |
| `WebAuthnChallenge` | Single-use passkey challenge | Two minutes; deleted with the member | Delete on use, expiry housekeeping, or member erasure |
| `MemberApplication` | Application, family and nominator information | Rejected: default 1 year after reviewedAt, configurable, only when enabled; other statuses kept for application / membership administration | Delete eligible rejected applications; keep other applications |
| `NominationToken` | Applicant nomination and nominator identity | Application administration; removed with deleted application | Delete with application |
| `PartnerInviteToken` | Invitation recipient, inviter and family link | Until expired / confirmed under existing invitation cleanup | Delete through existing invitation cleanup |
| `MemberSubscription` | Member billing, invoice snapshots and billing decisions | Kept with booking / financial records for reconciliation and evidence; no new automatic deletion | Keep |
| `MembershipSubscriptionCharge` | Member billing, invoice snapshots and billing decisions | Kept with booking / financial records for reconciliation and evidence; no new automatic deletion | Keep |
| `MembershipSubscriptionChargeComponent` | Member billing, invoice snapshots and billing decisions | Kept with booking / financial records for reconciliation and evidence; no new automatic deletion | Keep |
| `MembershipSubscriptionChargeCoverage` | Member billing, invoice snapshots and billing decisions | Kept with booking / financial records for reconciliation and evidence; no new automatic deletion | Keep |
| `FamilyGroupSeasonInvoiceMarker` | Member billing, invoice snapshots and billing decisions | Kept with booking / financial records for reconciliation and evidence; no new automatic deletion | Keep |
| `MembershipBillingException` | Member billing, invoice snapshots and billing decisions | Kept with booking / financial records for reconciliation and evidence; no new automatic deletion | Keep |
| `MembershipSubscriptionBillingSettings` | Club configuration and last updating officer | While configuration is in use; keep updater attribution for administration | Keep |
| `XeroGroupingSettings` | Club configuration and last updating officer | While configuration is in use; keep updater attribution for administration | Keep |
| `XeroMemberGroupingDryRun` | Provider contact identity, membership and grouping / containment evidence | While provider contact / grouping administration requires it | Keep |
| `SeasonalMembershipAssignment` | Membership type history and assigning officer | Kept while member / for membership administration; no new automatic deletion for this model | Keep |
| `MembershipCancellationRequest` | Membership lifecycle decisions, requesters, subjects and reviewers | Kept while member / for membership administration; no new automatic deletion for this model | Keep |
| `MembershipCancellationRequestParticipant` | Membership lifecycle decisions, requesters, subjects and reviewers | Kept while member / for membership administration; no new automatic deletion for this model | Keep |
| `MemberLifecycleActionRequest` | Membership lifecycle decisions, requesters, subjects and reviewers | Kept while member / for membership administration; no new automatic deletion for this model | Keep |
| `Booking` | Stay participants, guest details, stay history and financial evidence | Kept with booking / financial records for reconciliation and evidence; no new automatic deletion | Keep |
| `BookingEvent` | Stay participants, guest details, stay history and financial evidence | Kept with booking / financial records for reconciliation and evidence; no new automatic deletion | Keep |
| `BookingGuest` | Stay participants, guest details, stay history and financial evidence (the dietary note is scheduled on its own line below) | Kept with booking / financial records for reconciliation and evidence; no new automatic deletion | Keep |
| `BookingGuest.dietaryRequirements` | Per-stay dietary/allergy note for the kitchen and hut leader during the stay | Default 30 days after the stay's departure date (`stayEnd`), configurable 1–365, while the switch is on (ships on) | Clear the value; the guest row is kept |
| `BookingGuestNight` | Stay participants, guest details, stay history and financial evidence | Kept with booking / financial records for reconciliation and evidence; no new automatic deletion | Keep |
| `BookingGuestNightAdjustment` | Stay participants, guest details, stay history and financial evidence | Kept with booking / financial records for reconciliation and evidence; no new automatic deletion | Keep |
| `BookingImportBatch` | Which officer confirmed or reversed an import of paid bookings, as a plain member id; no names or emails | Kept with booking / financial records for reconciliation and evidence; no new automatic deletion | Keep |
| `BookingImportRow` | Each imported or refused Booking Ref, its line number, refusal reason and booking; no names or emails (`INV-PRIV-011`) | Kept with booking / financial records for reconciliation and evidence; no new automatic deletion | Keep |
| `GroupBooking` | Group organiser, joining contacts, guest snapshots and settlement | Kept with booking / financial records for reconciliation and evidence; no new automatic deletion | Keep |
| `GroupBookingJoin` | Group organiser, joining contacts, guest snapshots and settlement | Kept with booking / financial records for reconciliation and evidence; no new automatic deletion | Keep |
| `GroupBookingSettlement` | Group organiser, joining contacts, guest snapshots and settlement | Kept with booking / financial records for reconciliation and evidence; no new automatic deletion | Keep |
| `BookingRequest` | Booking enquiries, contact / guest snapshots, quotes and payment access | Kept with booking / financial records for reconciliation and evidence; no new automatic deletion | Keep |
| `BookingRequestPendingAdultReservationNight` | Booking enquiries, contact / guest snapshots, quotes and payment access | Kept with booking / financial records for reconciliation and evidence; no new automatic deletion | Keep |
| `BookingRequestQuote` | Booking enquiries, contact / guest snapshots, quotes and payment access | Kept with booking / financial records for reconciliation and evidence; no new automatic deletion | Keep |
| `PaymentLink` | Booking enquiries, contact / guest snapshots, quotes and payment access | Kept with booking / financial records for reconciliation and evidence; no new automatic deletion | Keep |
| `BookingRequestSettings` | Club configuration and last updating officer | While configuration is in use; keep updater attribution for administration | Keep |
| `MemberGuestSettings` | Club configuration and last updating officer | While configuration is in use; keep updater attribution for administration | Keep |
| `Locker` | Member locker allocation | While allocated / lodge administration | Keep |
| `BedAllocation` | Guest bed allocation and approving officer | Kept with booking / financial records for reconciliation and evidence; no new automatic deletion | Keep |
| `BedAllocationSettings` | Club configuration and last updating officer | While configuration is in use; keep updater attribution for administration | Keep |
| `MemberFieldsSettings` | Club configuration and last updating officer | While configuration is in use; keep updater attribution for administration | Keep |
| `Payment` | Payment, refund, recovery and officer decision evidence | Kept with booking / financial records for reconciliation and evidence; no new automatic deletion | Keep |
| `ManualRefundTask` | Payment, refund, recovery and officer decision evidence | Kept with booking / financial records for reconciliation and evidence; no new automatic deletion | Keep |
| `PaymentTransaction` | Payment, refund, recovery and officer decision evidence | Kept with booking / financial records for reconciliation and evidence; no new automatic deletion | Keep |
| `PaymentRefund` | Payment, refund, recovery and officer decision evidence | Kept with booking / financial records for reconciliation and evidence; no new automatic deletion | Keep |
| `UnrecognisedStripePayment` | Stripe payments no app path settled: provider references, amount, the description the payer saw or typed, and for the app's own payment its booking id | Kept with booking / financial records for reconciliation and evidence; no new automatic deletion | Keep |
| `StripeDispute` | A cardholder's dispute (chargeback) of a card payment: Stripe references, amounts, Stripe's reason code and outcome, and the matched payment and booking ids | Kept with booking / financial records for reconciliation and evidence; no new automatic deletion | Keep |
| `RateLimitCounter` | Pseudonymous requester keys for abuse prevention | Until counter reset / existing rate-limit cleanup | Delete through existing cleanup |
| `LoginThrottle` | Pseudonymous per-account keys (an HMAC of the sign-in email, never the address) and a count of recent password attempts, for abuse prevention (#4609) | Until a valid password or a completed password reset; once idle for an hour, until the next daily `data-pruning` run at the latest | Delete on that sign-in or reset, by the daily `data-pruning` job, and sooner by a ten-minute sweep in a process handling password sign-ins |
| `AlertCooldown` | Alert deduplication keys that may reference an entity; on a `once-ever-owed:` row (#5255), a stored admin alert: booking, payment or Xero operation ids, an amount and the alert's message, never a member's name | Kept for the operational purpose while needed; an owed alert row until its alert is sent or for 7 days | Keep; the payments cron's `once-ever-alert-sweep` deletes an owed alert row once sent or after 7 days |
| `OwedNotice` | A notice a committed change still owes: its kind, the subject's id (a booking today), the event time, and ids and whole numbers only (#5433) | Until the notice is sent, its subject has moved on, or it passes its cut-off (seven days at most for the bump notices), and never past twice its kind's maximum age. A marker of a kind the running release does not deliver is left in place, since a newer release may own it, and reported in an error log once it is over a week old | Delete by its own sweep; a marker of an unknown kind is deleted by the release that knows it, or by an operator (`docs/UPGRADING.md`); no new retention job |
| `PaymentRecoveryOperation` | Payment, refund, recovery and officer decision evidence | Kept with booking / financial records for reconciliation and evidence; no new automatic deletion | Keep |
| `PromoRedemption` | Member promotion entitlement, guest targets and applied discounts | Kept with booking / financial records for reconciliation and evidence; no new automatic deletion | Keep |
| `PromoRedemptionAllocation` | Member promotion entitlement, guest targets and applied discounts | Kept with booking / financial records for reconciliation and evidence; no new automatic deletion | Keep |
| `PromoRedemptionGuestTarget` | Member promotion entitlement, guest targets and applied discounts | Kept with booking / financial records for reconciliation and evidence; no new automatic deletion | Keep |
| `PromoCodeAssignment` | Member promotion entitlement, guest targets and applied discounts | Kept with booking / financial records for reconciliation and evidence; no new automatic deletion | Keep |
| `ChoreAssignment` | Guest chore assignments, completion and guest access | Stay operations; tokens expire at expiresAt | Keep assignment history; tokens invalid after expiry |
| `BookingWaitlistAlternateLodge` | Booking-linked alternative-lodge preference | Kept with booking / financial records for reconciliation and evidence; no new automatic deletion | Keep |
| `HostingCoverageIncident` | Host, guest / officer evidence and safety reevaluation | Kept with booking / financial records for reconciliation and evidence; no new automatic deletion | Keep |
| `HostingCoverageReevaluation` | Host, guest / officer evidence and safety reevaluation | Kept with booking / financial records for reconciliation and evidence; no new automatic deletion | Keep |
| `IntegrationCredential` | Encrypted integration secrets and updating user | While integration / credential is configured | Keep current credential; replace / remove through integration administration |
| `IntegrationWizardProgress` | Setup progress and completing / updating officer | Kept for the operational purpose while needed; no new automatic deletion | Keep |
| `FinanceSyncRun` | Financial provider payloads, object links and reconciliation evidence | Kept with booking / financial records for reconciliation and evidence; no new automatic deletion | Keep |
| `FinanceSnapshot` | Financial provider payloads, object links and reconciliation evidence | Kept with booking / financial records for reconciliation and evidence; no new automatic deletion | Keep |
| `XeroSyncOperation` | Financial provider payloads, object links and reconciliation evidence | Kept with booking / financial records for reconciliation and evidence; no new automatic deletion | Keep |
| `XeroObjectLink` | Financial provider payloads, object links and reconciliation evidence | Kept with booking / financial records for reconciliation and evidence; no new automatic deletion | Keep |
| `XeroInboundEvent` | Financial provider payloads, object links and reconciliation evidence | Kept with booking / financial records for reconciliation and evidence; no new automatic deletion | Keep |
| `XeroApiUsageEvent` | Provider call and error summaries that may identify a contact | Kept for integration diagnostics; no new automatic deletion | Keep |
| `XeroAdminCache` | Provider / report cache payloads that may contain contacts | While needed for cached reporting; refreshed / invalidated by existing cache lifecycle | Keep |
| `WhakapapaReportCache` | Provider / report cache payloads that may contain contacts | While needed for cached reporting; refreshed / invalidated by existing cache lifecycle | Keep |
| `XeroContactCache` | Provider contact identity, membership and grouping / containment evidence | While provider contact / grouping administration requires it | Keep |
| `XeroContactGroupMembershipCache` | Provider contact identity, membership and grouping / containment evidence | While provider contact / grouping administration requires it | Keep |
| `ProcessedWebhookEvent` | Provider event references and webhook processing evidence | Kept for the operational purpose while needed; no new automatic deletion | Keep |
| `WebhookLog` | Provider event references and webhook processing evidence | 30 days under existing webhook-log cleanup | Delete through existing cleanup |
| `AuditLog` | Actor / subject, security and operational evidence | Diagnostic: 90-day expiry; sensitive access: 24-month expiry; standard / critical: 7-year expiry; request identifiers: 90 days unless incident-preserved; archive copies: 7 years; incident preservation: at least 10 years; no expiresAt: keep. See audit runbook for archive / prune conditions | Anonymise request identifiers; archive / delete by existing audit rules |
| `SetupProgress` | Setup progress and completing / updating officer | Kept for the operational purpose while needed; no new automatic deletion | Keep |
| `AiAssistantUsageEvent` | Requesting member / administrator and diagnostic usage evidence | Kept for the operational purpose while needed; no new automatic deletion | Keep |
| `AiAssistantSettings` | Club configuration and last updating officer | While configuration is in use; keep updater attribution for administration | Keep |
| `AiSpendCurrencySettings` | Club configuration and last updating officer | While configuration is in use; keep updater attribution for administration | Keep |
| `DiagnosticsSettings` | Club configuration and last updating officer | While configuration is in use; keep updater attribution for administration | Keep |
| `DiagnosticsUsageEvent` | Requesting member / administrator and diagnostic usage evidence | Kept for the operational purpose while needed; no new automatic deletion | Keep |
| `ClubModuleSettings` | Club configuration and last updating officer | While configuration is in use; keep updater attribution for administration | Keep |
| `OtherLodge` | Partner lodge booking officer contact | While partner lodge registry / historical booking reference is needed | Keep |
| `ServerNzSettings` | Club configuration and last updating officer | While configuration is in use; keep updater attribution for administration | Keep |
| `MirotalkSettings` | Club configuration and last updating officer | While configuration is in use; keep updater attribution for administration | Keep |
| `LodgeSettings` | Club configuration and last updating officer | While configuration is in use; keep updater attribution for administration | Keep |
| `EmailMessageSetting` | Club configuration and last updating officer | While configuration is in use; keep updater attribution for administration | Keep |
| `PrivacyHostingSettings` | Hosting disclosure and last updating officer | While configuration is in use; keep updater attribution for administration | Keep |
| `ClubIdentitySettings` | Club configuration and last updating officer | While configuration is in use; keep updater attribution for administration | Keep |
| `ClubTimeSettings` | Club configuration and last updating officer | While configuration is in use; keep updater attribution for administration | Keep |
| `ClubFormatSettings` | Club configuration and last updating officer | While configuration is in use; keep updater attribution for administration | Keep |
| `ClubTaxSettings` | Club tax schedule and the officer who scheduled each period | While the period can render a Xero document; keep attribution for the tax record | Keep |
| `XeroTaxCategoryMapping` | Club tax categories mapped to Xero tax rates, and the officer who last mapped each | While Xero is connected; keep attribution for the tax record | Keep |
| `LoginSecuritySetting` | Club configuration and last updating officer | While configuration is in use; keep updater attribution for administration | Keep |
| `AnalyticsSettings` | Club configuration and last updating officer | While configuration is in use; keep updater attribution for administration | Keep |
| `EmailTemplateOverride` | Published / configured content and editor attribution | While published / configured and for content administration | Keep |
| `BookingMessageOverride` | Published / configured content and editor attribution | While published / configured and for content administration | Keep |
| `InternetBankingPaymentSettings` | Club configuration and last updating officer | While configuration is in use; keep updater attribution for administration | Keep |
| `PageContent` | Published / configured content and editor attribution | While published / configured and for content administration | Keep |
| `MediaImage` | Uploaded photos / images, metadata and uploader | While used by content / member photo and media administration | Keep until existing media / profile cleanup removes it |
| `SiteBanner` | Published / configured content and editor attribution | While published / configured and for content administration | Keep |
| `Notice` | Notice content, author, targeted members and read status | While notice / communications administration needs it | Keep |
| `NoticeAudience` | Notice content, author, targeted members and read status | While notice / communications administration needs it | Keep |
| `NoticeReadReceipt` | Notice content, author, targeted members and read status | While notice / communications administration needs it | Keep |
| `ClubPost` | Post authors, uploaded images, reporters and shared content | Existing ClubPostSettings.retentionDays (0: no automatic expiry); reports / images follow post lifecycle | Delete via existing communications retention / moderation lifecycle |
| `ClubPostImage` | Post authors, uploaded images, reporters and shared content | Existing ClubPostSettings.retentionDays (0: no automatic expiry); reports / images follow post lifecycle | Delete via existing communications retention / moderation lifecycle |
| `ClubPostReport` | Post authors, uploaded images, reporters and shared content | Existing ClubPostSettings.retentionDays (0: no automatic expiry); reports / images follow post lifecycle | Delete via existing communications retention / moderation lifecycle |
| `ClubPostSettings` | Club configuration and last updating officer | While configuration is in use; keep updater attribution for administration | Keep |
| `NotificationDeliveryPolicy` | Club configuration and last updating officer | While configuration is in use; keep updater attribution for administration | Keep |
| `MembershipCancellationSetting` | Club configuration and last updating officer | While configuration is in use; keep updater attribution for administration | Keep |
| `BookingModification` | Booking change snapshots, request / review evidence and reservation links | Kept with booking / financial records for reconciliation and evidence; no new automatic deletion | Keep |
| `EditReviewChargeRaiseClaim` | Booking change snapshots, request / review evidence and reservation links | Kept with booking / financial records for reconciliation and evidence; no new automatic deletion | Keep |
| `BookingChangeRequest` | Booking change snapshots, request / review evidence and reservation links | Kept with booking / financial records for reconciliation and evidence; no new automatic deletion | Keep |
| `PolicyExceptionReservationNight` | Booking change snapshots, request / review evidence and reservation links | Kept with booking / financial records for reconciliation and evidence; no new automatic deletion | Keep |
| `NewBookingPolicyExceptionRequest` | Booking change snapshots, request / review evidence and reservation links | Kept with booking / financial records for reconciliation and evidence; no new automatic deletion | Keep |
| `EmailLog` | Recipients, message bodies, delivery and retry history | Default 2 years after createdAt, configurable, only when enabled | Delete eligible old logs |
| `EmailSuppression` | Recipient suppression and complaint / bounce handling | While needed to prevent unwanted or failed delivery; clearing records an officer decision | Keep |
| `IssueReport` | Reporter, support content, screenshot and browser information | Screenshot / browser information: 30 days; report retained for support history | Anonymise expired sensitive fields; keep report |
| `CronJobRun` | Cron result / error summaries that may reference personal records | 90 days under existing cron-run cleanup | Delete through existing cleanup |
| `BackupRun` | Backup operator and result / error summaries | 90 days under existing backup-run cleanup | Delete through existing cleanup |
| `HutLeaderAssignment` | Member lodge access, leadership / custodianship and assigning officer | Kept while member / for membership administration; no new automatic deletion for this model | Keep |
| `MemberLodgeAccess` | Member lodge access, leadership / custodianship and assigning officer | Kept while member / for membership administration; no new automatic deletion for this model | Keep |
| `LodgeInstruction` | Published / configured content and editor attribution | While published / configured and for content administration | Keep |
| `SiteContent` | Published / configured content and editor attribution | While published / configured and for content administration | Keep |
| `GuestChoreToken` | Guest chore assignments and guest access | Until expiresAt under existing token cleanup | Delete expired tokens |
| `FamilyGroup` | Family identity, relationships, join requests and decision evidence | Kept while member / for membership administration; no new automatic deletion for this model | Keep |
| `FamilyGroupMember` | Family identity, relationships, join requests and decision evidence | Kept while member / for membership administration; no new automatic deletion for this model | Keep |
| `HiddenFamilySuggestion` | Family identity, relationships, join requests and decision evidence | Kept while member / for membership administration; no new automatic deletion for this model | Keep |
| `FamilyGroupJoinRequest` | Family identity, relationships, join requests and decision evidence | Kept while member / for membership administration; no new automatic deletion for this model | Keep |
| `MemberPartnerLink` | Family identity, relationships, join requests and decision evidence | Kept while member / for membership administration; no new automatic deletion for this model | Keep |
| `MemberParentPartnerExclusion` | Family identity, relationships, join requests and decision evidence | Kept while member / for membership administration; no new automatic deletion for this model | Keep |
| `NotificationPreference` | Member delivery choices | Kept while member / for membership administration; no new automatic deletion for this model | Keep |
| `DeletionRequest` | Membership lifecycle decisions, requesters, subjects and reviewers | Kept while member / for membership administration; no new automatic deletion for this model | Keep |
| `MemberCredit` | Member credit ledger, allocations and reviewer decisions | Kept with booking / financial records for reconciliation and evidence; no new automatic deletion | Keep |
| `MemberCreditNoteAllocation` | Member credit ledger, allocations and reviewer decisions | Kept with booking / financial records for reconciliation and evidence; no new automatic deletion | Keep |
| `AdminCreditAdjustmentRequest` | Member credit ledger, allocations and reviewer decisions | Kept with booking / financial records for reconciliation and evidence; no new automatic deletion | Keep |
| `OpeningCreditBatch` | Opening-credit batch: the posting and reversing officer, totals and the reversal reason (#4988) | Kept with the credit rows it tags, for reconciliation and evidence; no new automatic deletion | Keep |
| `XeroCashCredit` | Snapshot of a Xero contact's unallocated overpayment or prepayment, for the finance queue and backed credit | Kept with financial records while credit may name it; refreshed from Xero, never deleted automatically | Keep |
| `MemberCreditCashAllocation` | Member credit ledger, allocations and reviewer decisions | Kept with booking / financial records for reconciliation and evidence; no new automatic deletion | Keep |
| `MemberCreditCashReturn` | Member credit ledger, allocations and reviewer decisions | Kept with booking / financial records for reconciliation and evidence; no new automatic deletion | Keep |
| `PublicContentSettings` | Club configuration and last updating officer | While configuration is in use; keep updater attribution for administration | Keep |
| `RefundRequest` | Payment, refund, recovery and officer decision evidence | Kept with booking / financial records for reconciliation and evidence; no new automatic deletion | Keep |
| `CommitteeRole` | Committee contact details, member roles and public biographies | While committee / contact administration and role history requires it | Keep |
| `CommitteeAssignment` | Committee contact details, member roles and public biographies | While committee / contact administration and role history requires it | Keep |
| `MemberInduction` | Member competency, signers, declarations and induction comments | Kept while member / for membership administration; no new automatic deletion for this model | Keep |
| `MemberInductionSignOff` | Member competency, signers, declarations and induction comments | Kept while member / for membership administration; no new automatic deletion for this model | Keep |
| `MemberInductionAssignedSigner` | Member competency, signers, declarations and induction comments | Kept while member / for membership administration; no new automatic deletion for this model | Keep |
| `MembershipNominationSettings` | Club configuration and last updating officer | While configuration is in use; keep updater attribution for administration | Keep |
| `MembershipLockoutSettings` | Club configuration and last updating officer | While configuration is in use; keep updater attribution for administration | Keep |
| `CalendarEvent` | Event content, meeting information and creating member | While calendar / event administration and history requires it | Keep |
| `CalendarEventSeries` | Event content, meeting information and creating member | While calendar / event administration and history requires it | Keep |
| `MaintenanceReportSettings` | Club configuration and last updating officer | While configuration is in use; keep updater attribution for administration | Keep |
| `MaintenanceReport` | Reporter / contact, fault description, answers and supporting evidence | Photo / IP hash: stamped expiry from maintenance settings; report / answers retained for maintenance history | Anonymise expired photo / IP fields; keep report and answers |
| `MaintenanceReportAnswer` | Reporter / contact, fault description, answers and supporting evidence | Photo / IP hash: stamped expiry from maintenance settings; report / answers retained for maintenance history | Anonymise expired photo / IP fields; keep report and answers |
| `FoodOrderSettings` | Club configuration (food officer email) and last updating officer | While configuration is in use; keep updater attribution for administration | Keep |
| `FoodOrder` | Ordering member, needed-by date, note, receiving and pricing officers, recorded price (fork triyder/AlpineClubBookingsNZ#121) | Retained as the club's food-cost history; a deleted member's orders keep their cost with the member link cleared | Keep; member link set null when the member is deleted |
| `FoodOrderItem` | The ordering member's item descriptions and quantities, and who received each item and when | Retained with its order | Keep with the order |
| `LodgeMaintenanceReportToken` | Report access token and creating / rotating officer | While token / report intake administration requires it; rotation revokes old access | Keep |
| `EnvironmentSafetySettings` | Club configuration and last updating officer | While configuration is in use; keep updater attribution for administration | Keep |
| `XeroSandboxContactContainment` | Provider contact identity, membership and grouping / containment evidence | While provider contact / grouping administration requires it | Keep |
| `Organisation` | Booking organisation contacts, linked people and classification evidence | Kept with booking / financial records for reconciliation and evidence; no new automatic deletion | Keep |
| `OrganisationContact` | Booking organisation contacts, linked people and classification evidence | Kept with booking / financial records for reconciliation and evidence; no new automatic deletion | Keep |
| `SchoolMemberClassification` | Booking organisation contacts, linked people and classification evidence | Kept with booking / financial records for reconciliation and evidence; no new automatic deletion | Keep |
| `BookingLedgerLine` | Stay participants, guest details, stay history and financial evidence | Kept with booking / financial records for reconciliation and evidence; no new automatic deletion | Keep |
| `PrivacyRetentionSettings` | Club retention periods, opt-in switches and last updating officer | While configuration is in use; keep updater attribution for administration | Keep |
| `MemberMoneyEvent` | Immutable financial event, officer attribution and source evidence | Kept for financial records | Keep |
| `MemberMoneyJournal` | Financial journal batch and linked member transactions | Kept for financial records | Keep |
| `MemberMoneySourceLink` | Financial source identities and booking-ledger links | Kept for financial records | Keep |
| `MemberMoneyLine` | Member or organisation debtor, booking and financial evidence | Kept for financial records | Keep |
| `MemberMoneyObligation` | Member or organisation charge and refund obligations | Kept for financial records | Keep |
| `MemberMoneyApplication` | Receipt, refund and credit attribution to financial obligations | Kept for financial records | Keep |
| `MemberMoneyRefundReservation` | Reserved refund amounts linked to financial obligations and captures | Kept for financial records | Keep |
| `MemberMoneyRefundReservationRelease` | Release evidence for reserved refund amounts | Kept for financial records | Keep |
| `MemberMoneySourcePosting` | Exact financial source and journal-line coverage | Kept for financial records | Keep |
| `MemberMoneyExportManifest` | Booking, sent Xero invoice id and what its lines cover | Kept for financial records | Keep |
| `XeroTaxOverrideMismatch` | Booking, Xero invoice, the tax sent and returned per line, and the finance officer who cleared it with their note | Kept for financial records; keep clearer attribution for the tax record | Keep |
| `MemberMoneyExportCoverage` | Journal components a sent invoice bills | Kept for financial records | Keep |
| `MemberMoneyExportCoverageRelease` | When and why a sent invoice stopped covering its components (voided or gone from Xero) | Kept for financial records | Keep |
| `McpGrant` | A member's connection to an AI app: which app, what it may do, when it was approved and last used | While the connection is in use, and after it ends as the member's connection history; deleted with the member. A connection whose app stopped renewing leaves the connected lists once its last refresh token lapses (30 days), and its row is kept as history. No scheduled sweep | Delete on member erasure or merge |
| `McpAuthCode` | Single-use sign-in code for an AI app connection, stored as a hash, with its PKCE challenge and return address | Usable for five minutes; kept for the life of the connection, marked used once the app collects it, because it records the approved return address that every use is checked against and the connection lists show; deleted when the connection ends or with the member. No scheduled sweep | Delete with the connection |
| `McpToken` | Access and refresh tokens for an AI app connection, stored as hashes | An access token lasts one hour and a refresh token a fixed 30 days; a refresh token is marked used when it is renewed. Expired tokens are deleted at the connection's next token issue, and every token when the connection ends or with the member. No scheduled sweep | Delete with the connection |
| `McpSettings` | Club configuration and last updating officer | While configuration is in use; keep updater attribution for administration | Keep |
| `StripeBalanceTransactionEvidence` | Stripe balance-transaction figures and the payment intent, refund and payout they belong to | Kept for financial records | Keep |

## Maintaining coverage

[`privacy-retention-classification.ts`](../src/lib/privacy-retention-classification.ts)
explicitly classifies every Prisma model, including non-personal models. The
schema-derived census in
[`privacy-retention-census.test.ts`](../src/lib/__tests__/privacy-retention-census.test.ts)
fails when a model is unclassified, a classification is stale, or a personal
model has no complete row in this table. A new field on an existing model still
requires privacy review; the census checks model coverage, not field semantics.

Related: [documentation hub](README.md) · [upgrading](UPGRADING.md).
