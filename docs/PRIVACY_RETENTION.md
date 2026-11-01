# Personal-data retention schedule

Audience: Operator, Developer, Adopter.

This is the club's complete Prisma-model schedule for personal data, including
indirect member links, officer attribution, free-text snapshots and cached
contacts. It records purpose, retention and the end action in one table.
“Keep” means retained for the stated membership, financial or operational
purpose; it does not introduce an automatic deletion period. Settings records
are personal because they retain the updating officer's identifier.

## Automatic retention and operator review

The three new automatic jobs cover old email logs, rejected membership
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

Only those three jobs are added here. Existing token, audit, report,
communications and cron-run lifecycles continue under their own rules. A row
marked “keep” has no new automatic cleanup. Approved member erasure remains a
separate lifecycle. Backups and external providers have their own lifecycle;
see [backups](guides/backups.md), the
[audit retention runbook](AUDIT_RETENTION_ARCHIVE_RUNBOOK.md) and
[security notes](SECURITY.md).

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
| `BookingGuest` | Stay participants, guest details, stay history and financial evidence | Kept with booking / financial records for reconciliation and evidence; no new automatic deletion | Keep |
| `BookingGuestNight` | Stay participants, guest details, stay history and financial evidence | Kept with booking / financial records for reconciliation and evidence; no new automatic deletion | Keep |
| `BookingGuestNightAdjustment` | Stay participants, guest details, stay history and financial evidence | Kept with booking / financial records for reconciliation and evidence; no new automatic deletion | Keep |
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
| `UnrecognisedStripePayment` | Stripe payments taken outside the app: provider references, amount and the description the payer saw or typed | Kept with booking / financial records for reconciliation and evidence; no new automatic deletion | Keep |
| `RateLimitCounter` | Pseudonymous requester keys for abuse prevention | Until counter reset / existing rate-limit cleanup | Delete through existing cleanup |
| `LoginThrottle` | Pseudonymous per-account keys (an HMAC of the sign-in email, never the address) and a count of recent password attempts, for abuse prevention (#4609) | Until a valid password or a completed password reset, or an hour after the last counted attempt | Delete on that sign-in or reset, and through the best-effort idle sweep |
| `AlertCooldown` | Alert deduplication keys that may reference an entity | Kept for the operational purpose while needed; no new automatic deletion | Keep |
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
| `ClubIdentitySettings` | Club configuration and last updating officer | While configuration is in use; keep updater attribution for administration | Keep |
| `ClubTimeSettings` | Club configuration and last updating officer | While configuration is in use; keep updater attribution for administration | Keep |
| `ClubFormatSettings` | Club configuration and last updating officer | While configuration is in use; keep updater attribution for administration | Keep |
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
| `MemberMoneySourcePosting` | Exact financial source and journal-line coverage | Kept for financial records | Keep |

## Maintaining coverage

[`privacy-retention-classification.ts`](../src/lib/privacy-retention-classification.ts)
explicitly classifies every Prisma model, including non-personal models. The
schema-derived census in
[`privacy-retention-census.test.ts`](../src/lib/__tests__/privacy-retention-census.test.ts)
fails when a model is unclassified, a classification is stale, or a personal
model has no complete row in this table. A new field on an existing model still
requires privacy review; the census checks model coverage, not field semantics.

Related: [documentation hub](README.md) · [upgrading](UPGRADING.md).
