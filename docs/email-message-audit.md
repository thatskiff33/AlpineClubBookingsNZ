# Email Message Audit

This is an audit of outbound email messages in the current repository state.
The main sender is `src/lib/email.ts`; most HTML bodies are in
`src/lib/email-templates.ts`. Direct one-off senders also exist in the contact
route, refund appeal admin route, admin bulk communications route, and email
retry cron.

This audit covers mail sent by this repository through its Nodemailer/SES path.
I did not find a repo path that instructs Xero to email invoices; any Xero-side
invoice email would be outside this repo's sender inventory.

The `/admin/setup` and `/admin/notifications` interfaces expose email message
settings so administrators can edit shared email variables and template wording
without changing TypeScript files. Admin/system notification delivery policies
are managed from `/admin/notifications`.

Sensitive tokens (`{{doorCode}}`, `{{token}}`, `{{pin}}`, `{{resetUrl}}`,
`{{verifyUrl}}`, `{{confirmationUrl}}`) are body-only: subjects are persisted
in `EmailLog` for every template and travel in clear mail headers, so template
override subjects containing these tokens are rejected at save time, and the
renderer never substitutes their values into a subject line. Required tokens
must appear in the template body; a token in the subject does not satisfy the
requirement.

## Runtime Placeholders

The public checkout has no `config/club.json`, so the checked-in fallback values
come from `config/club.example.json`.

- `{{CLUB_NAME}}`: `Example Mountain Club` in this checkout.
- `{{CLUB_BOOKINGS_NAME}}`: `Example Mountain Club - Bookings` in this checkout.
- `{{CLUB_LODGE_NAME}}`: `Example Mountain Club Lodge` in this checkout.
- `{{CLUB_EMAIL_FROM_NAME}}`: `Example Mountain Club - Online Booking System`
  in this checkout.
- `{{SUPPORT_EMAIL}}`: `support@example.org` in this checkout unless overridden
  by `SUPPORT_EMAIL`.
- `{{CONTACT_EMAIL}}`: `bookings@example.org` in this checkout unless overridden
  by `CONTACT_EMAIL`.
- `{{BASE_URL}}`: `NEXTAUTH_URL` origin at runtime, or `http://localhost:3000`.
- `{{CLUB_LODGE_TRAVEL_NOTE}}`: `The lodge is located near the mountain. Please allow adequate travel time.`

## Common Email Frame

All messages built with `layout()` have this visible frame around the body:

```text
{{CLUB_EMAIL_FROM_NAME}}

Online Booking System

...message body...

{{CLUB_NAME}} • Online Booking System
{{BASE_URL without protocol}}
```

The contact form and permanent email-failure alert do not use this branded
frame.

Admin alert emails are sent once per active admin whose admin notification
preference allows that alert type. They are sent as separate emails, not one
BCC. SES bounce/complaint suppression can skip a recipient before SMTP send.

Failed non-sensitive emails with retained HTML are retried every 30 minutes,
with a 15 minute backoff and at most 3 attempts. Token-bearing templates are not
auto-retried because their HTML is deliberately not retained.

## Exact Messages

### password-reset

Subject:

```text
Reset your {{CLUB_NAME}} password
```

Body:

```text
Password Reset

You requested a password reset for your {{CLUB_NAME}} booking account.

Click the button below to set a new password. This link expires in 1 hour.

Reset Password: {{BASE_URL}}/reset-password?token={{token}}

If you didn't request this, you can safely ignore this email. Your password will remain unchanged.
```

Triggers and frequency:

- `POST /api/auth/forgot-password`: when the submitted email belongs to an active login-enabled member. The route always responds success to avoid enumeration. Rate limit: 5 requests per hour.
- `src/lib/xero-member-import.ts` member import path when `sendInvites` is true. It creates a 7-day token, but this template still says "1 hour".
- One email per matching member/imported member per triggering request.

### admin-password-reset

Subject:

```text
Reset your {{CLUB_NAME}} password
```

Body:

```text
Password Reset

An administrator has requested a password reset for your {{CLUB_NAME}} booking account.

Click the button below to set a new password. This link expires in {{expiryLabel}}.

Reset Password: {{BASE_URL}}/reset-password?token={{token}}

If you believe this was sent in error, please contact the club administrator.
```

Triggers and frequency:

- `POST /api/admin/members/send-password-reset`: admin sends reset links to 1-100 active login-enabled members.
- Expiry label is one of `1 hour`, `1 day`, or `3 days`.
- Bulk sends to more than one member are throttled to once per 10 minutes per admin, sent in batches of 10 with 1 second between batches.

### member-setup-invite

Subject:

```text
Set up your {{CLUB_NAME}} account (7-day link)
```

Body:

```text
Set Up Your Account

Hi {{firstName}},

An administrator has created your {{CLUB_NAME}} booking account.

Use the button below to set your password and activate your login. This link expires in 7 days.

Set Up My Password: {{BASE_URL}}/reset-password?token={{token}}

If you were not expecting this invite, you can safely ignore it or contact the club.
```

Triggers and frequency:

- Admin creates a member with `sendInvite`.
- Admin imports members with `sendInvites`.
- Admin uses `POST /api/admin/members/send-setup-invite`.
- One email per selected/new/imported member per admin action.

### welcome

Subject:

```text
Welcome to {{CLUB_BOOKINGS_NAME}}
```

Body:

```text
Welcome, {{firstName}}!

Your {{CLUB_NAME}} booking account has been created successfully.

You can now log in to book stays at the lodge, manage your bookings, and view your upcoming trips.

Log In to Your Account: {{BASE_URL}}/login

If you did not create this account, please ignore this email.
```

Triggers and frequency:

- Defined as `sendWelcomeEmail`, but no current caller was found in `src/`.

### email-verification

Subject:

```text
Verify your email — {{CLUB_BOOKINGS_NAME}}
```

Body:

```text
Verify Your Email

Hi {{firstName}}, thanks for creating your {{CLUB_NAME}} booking account!

Please verify your email address by clicking the button below.

Verify Email: {{BASE_URL}}/verify-email?token={{token}}

This link expires on {{expiresAt}}. If you did not create this account, please ignore this email.
```

Triggers and frequency:

- `POST /api/auth/resend-verification`: when the email belongs to a login-enabled member whose email is not verified.
- Rate limit: 3 requests per hour.
- One email per successful resend request.

### email-change-verification

Subject:

```text
Confirm your new email — {{CLUB_BOOKINGS_NAME}}
```

Body:

```text
Confirm Your New Email

You requested to change the email address on your {{CLUB_NAME}} account to {{newEmail}}.

Click the button below to confirm this change.

Confirm Email Change: {{BASE_URL}}/confirm-email-change?token={{token}}

This link expires on {{expiresAt}}. If you did not request this change, please ignore this email.
```

Triggers and frequency:

- `POST /api/auth/request-email-change`: authenticated member requests an email change.
- Rate limit: 3 requests per hour.
- Sent to the new email address once per successful request.

### email-change-notification

Subject:

```text
Email change requested — {{CLUB_BOOKINGS_NAME}}
```

Body:

```text
Email Change Requested

Someone requested to change the email address on your {{CLUB_NAME}} account to {{newEmail}}.

If this wasn't you, please contact the club immediately.

If you made this request, you can safely ignore this email. The change will only take effect after verification.
```

Triggers and frequency:

- Same `POST /api/auth/request-email-change` request as above.
- Sent to the old email address once per successful request.

### booking-confirmed

Subject:

```text
Booking Confirmed - {{CLUB_LODGE_NAME}}
```

Body:

```text
Booking Confirmed

Hi {{firstName}}, your lodge booking has been confirmed!

Check-in: {{checkIn}}
Check-out: {{checkOut}}
Guests: {{guestCount}}
Subtotal: {{subtotal}}                  [only when discountCents > 0]
Discount ({{promoCode}}): -{{discount}} [only when promoCode exists]
Discount: -{{discount}}                 [only when discount exists without promoCode]
Total Paid: {{totalPaid}}

Payment has been processed successfully.

How to get to the lodge

{{CLUB_LODGE_TRAVEL_NOTE}}

Door code: {{doorCode}} [only when a door code is set]

You can view your booking details and manage your stay from your account.

View Booking: {{BASE_URL}}/bookings
```

Triggers and frequency:

- Booking creation for zero-dollar bookings that become confirmed/paid immediately.
- Draft booking confirmation for zero-dollar confirmed drafts.
- Stripe `payment_intent.succeeded` webhook after primary booking payment succeeds.
- Pending-booking cron when a held pending booking reaches its deadline, capacity is still available, and payment succeeds or price is zero.
- Waitlist offer confirmation when it becomes paid without payment collection.
- Admin force-confirm of a waitlisted booking when final status is `PAID`.
- One email per successful confirmation event. No template-level dedupe was found.

### booking-pending

Subject:

```text
Booking Pending - {{CLUB_LODGE_NAME}}
```

Body:

```text
Booking Pending

Hi {{firstName}}, your lodge booking has been received and is currently pending.

Check-in: {{checkIn}}
Check-out: {{checkOut}}
Guests: {{guestCount}}
Hold Until: {{holdUntil}}

Your booking includes non-member guests and will be held as pending until {{holdUntil}}.

During this time, club members have priority. If the lodge fills up with member bookings, your booking may be bumped. Your card will only be charged when the booking is confirmed.

View Booking: {{BASE_URL}}/bookings
```

Triggers and frequency:

- Booking creation when status is `PENDING` and `nonMemberHoldUntil` exists.
- Waitlist offer confirmation when it transitions back to `PENDING`.
- One email per transition into that pending state. No template-level dedupe was found.

### booking-bumped

Subject:

```text
Booking Update - {{CLUB_LODGE_NAME}}
```

Body:

```text
Booking Update

Hi {{firstName}}, unfortunately your pending lodge booking has been bumped due to member demand.

Check-in: {{checkIn}}
Check-out: {{checkOut}}
Guests: {{guestCount}}

Your card has not been charged.

As a non-member booking, priority is given to club members when the lodge reaches capacity. You're welcome to rebook for different dates where availability exists.

Book Again: {{BASE_URL}}/book

We apologise for the inconvenience.
```

Triggers and frequency:

- `sendBumpedNotifications()` after a member booking bumps one or more pending bookings to restore capacity.
- Pending-booking cron every 3 hours when a pending booking reaches its hold deadline and capacity is no longer available.
- One email per bumped booking.

### booking-cancelled

Subject:

```text
Booking Cancelled - {{CLUB_LODGE_NAME}}
```

Body:

```text
Booking Cancelled

Hi {{firstName}}, your lodge booking has been cancelled.

Check-in: {{checkIn}}
Check-out: {{checkOut}}

{{refundMessage}}

You can make a new booking at any time from your account.

Make a New Booking: {{BASE_URL}}/book
```

Refund message variants:

```text
A credit of {{refundAmount}} has been added to your account for future bookings.
```

```text
A refund of {{refundAmount}} has been processed to your original payment method.
```

```text
No refund was applicable based on the cancellation policy.
```

Triggers and frequency:

- User/admin cancellation flow for waitlisted, waitlist-offered, pending, confirmed, paid, and no-refund bookings.
- One email per cancellation action after status is changed to `CANCELLED`.

### booking-modified

Subject:

```text
Booking Modified - {{CLUB_LODGE_NAME}}
```

Body:

```text
Booking Modified

Hi {{firstName}}, your booking has been updated.

{{modificationTypeLabel}}

Previous Dates: {{oldCheckIn}} – {{oldCheckOut}} [only when dates changed]
New Dates: {{newCheckIn}} – {{newCheckOut}}       [only when dates changed]
Dates: {{newCheckIn}} – {{newCheckOut}}           [when dates did not change]
Previous Guests: {{oldGuestCount}}                [only when guest count changed]
New Guests: {{newGuestCount}}                     [only when guest count changed]
Guests: {{newGuestCount}}                         [when guest count did not change]
Previous Total: {{oldTotal}}                      [only when total changed]
New Total: {{newTotal}}                           [only when total changed]
Total: {{newTotal}}                               [when total did not change]
Change Fee: {{changeFee}}                         [only when changeFeeCents > 0]

{{paymentNote}}

You can view your updated booking details from your account.

View Booking: {{BASE_URL}}/bookings
```

Modification label variants:

```text
Dates Changed
Guests Added
Guest Removed
{{raw modificationType}} [for values such as BATCH_MODIFY]
```

Payment note variants:

```text
A refund of {{refundAmount}} has been processed to your original payment method.
```

```text
An additional payment of {{additionalAmount}} is required.
```

Triggers and frequency:

- Date modification route.
- Batch modification route.
- Guest add route.
- Guest remove route.
- One email per successful modification request.

### checkin-reminder

Subject:

```text
Check-in Reminder - {{CLUB_LODGE_NAME}}
```

Body:

```text
Check-in Reminder

Hi {{firstName}}, your lodge stay begins tomorrow!

Check-in: {{checkIn}}
Check-out: {{checkOut}}
Guests: {{guestCount}}

Guest list:

{{guestFirstName}} {{guestLastName}}
...

Your arrival day chores:        [only when chores exist]

{{choreName}}: {{choreDescription}}
...

Please ensure you arrive prepared for alpine conditions. Check the weather forecast before departing.

{{CLUB_LODGE_TRAVEL_NOTE}}

View Booking: {{BASE_URL}}/bookings
```

Triggers and frequency:

- Cron job `checkin-reminders`, scheduled daily at 9:00 AM NZST.
- Sends for paid/operational bookings checking in tomorrow.
- Skips if a sent `checkin-reminder` email to the same recipient with the same subject exists within the last 48 hours.

### pre-arrival-reminder

Subject:

```text
Pre-arrival Information - {{CLUB_LODGE_NAME}}
```

Body:

```text
Upcoming Lodge Stay

Hi {{firstName}}, your lodge stay is coming up.

Check-in: {{checkIn}}
Check-out: {{checkOut}}
Guests: {{guestCount}}
Expected arrival: {{expectedArrivalTime}} [only when provided]

How to get to the lodge

{{CLUB_LODGE_TRAVEL_NOTE}}

Door code: {{doorCode}} [only when a door code is set]

View Booking: {{BASE_URL}}/bookings
```

Triggers and frequency:

- Cron job `pre-arrival-reminders`, run by `POST /api/cron` every 3 hours.
- Sends once for confirmed or paid bookings checking in within the 3-day NZ date-only reminder window.
- Claims each booking through `Booking.preArrivalReminderSentAt` before sending to prevent duplicate reminders.

### chore-roster

Subject:

```text
Your chore roster for {{formattedDate}} - {{CLUB_LODGE_NAME}}
```

Body:

```text
Chore Roster

Hi {{guestName}},

Here are your assigned chores for {{formattedDate}} at the lodge:

{{choreName}}: {{choreDescription}}
...

Mark Chores Complete: {{choreLink}} [only when choreLink exists]

Use this link to mark your chores as done from your phone. Link expires in 48 hours. [only when choreLink exists]

Last person to bed: Check heaters and fire are safe and doors are secure.

Thanks for helping keep the lodge running smoothly!
```

Triggers and frequency:

- Admin roster route email action for a lodge date.
- Sends one email per guest with an email address and assigned chores.
- The route deletes old guest chore tokens for that guest/date before creating a new 48-hour token.

### hut-leader-assignment

Subject:

```text
Your {{CLUB_NAME}} hut leader assignment
```

Body:

```text
Hut Leader Assignment

Hi {{firstName}}, thanks for taking on hut leader duties for the lodge.

Start date: {{startDate}}
End date: {{endDate}}
Kiosk PIN: {{pin}}

When you arrive, open the lodge kiosk and use this PIN to unlock hut leader controls for arrivals, departures, and roster management.

Please keep this PIN private and share it only with the assigned hut leader team for these dates.

Responsibilities include checking the lodge list, helping guests settle in, marking arrivals and departures, and making sure the daily chore roster is set up and completed.

Open Lodge View: {{BASE_URL}}/lodge

If you have any issues accessing the kiosk, please contact a club administrator.
```

Triggers and frequency:

- Admin creates a hut leader assignment.
- Admin regenerates or updates the hut leader PIN for an assignment.
- One email per assignment/PIN action.

### setup-intent-failed

Subject:

```text
Card Setup Failed - {{CLUB_LODGE_NAME}}
```

Body:

```text
Card Setup Failed

Hi {{firstName}},

We were unable to save your card details for your upcoming booking ({{checkIn}} – {{checkOut}}). Your booking is still held, but we won't be able to charge you automatically when it's confirmed.

Please log in and update your payment method to avoid your booking being cancelled.

Update Payment Method: {{BASE_URL}}/bookings

If you need help, contact the club at {{SUPPORT_EMAIL}}.
```

Triggers and frequency:

- Stripe webhook `setup_intent.setup_failed` for a booking.
- One email per failed setup intent webhook event with a booking id.

### waitlist-confirmation

Subject:

```text
Waitlist Confirmation - {{CLUB_LODGE_NAME}}
```

Body:

```text
You're on the Waitlist

Hi {{firstName}}, the lodge is currently fully booked for your requested dates, but you've been added to the waitlist.

Check-in: {{checkIn}}
Check-out: {{checkOut}}
Guests: {{guestCount}}
Waitlist Position: #{{position}}

We'll email you as soon as a spot opens up. You'll have 48 hours to confirm your booking.

View Booking: {{BASE_URL}}/bookings

You can cancel your waitlist entry at any time from your booking page.
```

Triggers and frequency:

- Booking creation route when capacity is exceeded and the user chooses to join the waitlist.
- One email per new waitlisted booking.

### waitlist-offer

Subject:

```text
Spot Available! - {{CLUB_LODGE_NAME}}
```

Body:

```text
A Spot Has Opened Up!

Hi {{firstName}}, great news — a spot has become available for your waitlisted booking.

Check-in: {{checkIn}}
Check-out: {{checkOut}}
Guests: {{guestCount}}

This offer expires on {{expiresAt}}. If you don't confirm in time, the spot will be offered to the next person in line.

Confirm Booking: {{BASE_URL}}/bookings/{{bookingId}}

If you no longer need this booking, you can decline from your booking page.
```

Triggers and frequency:

- `processWaitlistForDates()` when capacity is freed and the first FIFO waitlisted booking with full-range capacity is moved to `WAITLIST_OFFERED`.
- Called after cancellations, bumps, some date modifications, and by the waitlist processor after expired offers.
- Waitlist processor is scheduled every 30 minutes when the waitlist feature is enabled.
- Offer expiry defaults to 48 hours unless `WAITLIST_OFFER_HOURS` overrides it.
- One email per offered booking.

### waitlist-offer-expired

Subject:

```text
Waitlist Offer Expired - {{CLUB_LODGE_NAME}}
```

Body:

```text
Waitlist Offer Expired

Hi {{firstName}}, your waitlist offer for the dates below has expired.

Check-in: {{checkIn}}
Check-out: {{checkOut}}
New Position: #{{position}}

You've been returned to the waitlist. We'll notify you again if another spot opens up.

View Booking: {{BASE_URL}}/bookings
```

Triggers and frequency:

- Waitlist processor expires stale `WAITLIST_OFFERED` bookings whose `waitlistOfferExpiresAt` is in the past.
- Waitlist processor is scheduled every 30 minutes when enabled.
- One email per expired offer.

### admin-waitlist-offer

Subject:

```text
Waitlist Offer: {{memberName}}
```

Body:

```text
Waitlist Offer Made

A waitlist offer has been sent to {{memberName}}.

Member: {{memberName}}
Check-in: {{checkIn}}
Check-out: {{checkOut}}
Guests: {{guestCount}}
Queue Position: #{{position}}

The member has 48 hours to confirm their booking.

View Waitlist: {{BASE_URL}}/admin/waitlist
```

Triggers and frequency:

- Sent to opted-in admins whenever `waitlist-offer` is sent.
- One alert event per offered booking, multiplied by opted-in admin recipients.

### nomination-request

Subject:

```text
Nomination request for {{applicantName}} — {{CLUB_NAME}}
```

Body:

```text
Membership Nomination Request

Hi {{nominatorName}},

{{applicantName}} has listed you as one of their {{CLUB_NAME}} nominators.

This application also includes {{familyMemberCount}} dependent family member(s). [only when familyMemberCount > 0]

Please review the application and confirm whether you agree to nominate this person for membership.

You will need to sign in before you can confirm the nomination.

Review Application: {{BASE_URL}}/nominations/{{token}}

This link expires on {{expiresAt}}.
```

Triggers and frequency:

- Membership application creation after the applicant lists two valid nominators.
- Sends to both nominators, so normally two emails per application.

### admin-membership-application-pending

Subject:

```text
Membership application ready: {{applicantName}}
```

Body:

```text
Membership Application Ready for Review

Both nominators have now confirmed a new membership application.

Applicant: {{applicantName}}
Email: {{applicantEmail}}

This application includes {{familyMemberCount}} dependent family member(s). [only when familyMemberCount > 0]

Review Application: {{BASE_URL}}/admin/member-applications

{{CLUB_NAME}} — {{SUPPORT_EMAIL}}
```

Triggers and frequency:

- Sent to opted-in admins when the second nominator confirmation moves an application to admin review.
- One alert event per application, multiplied by opted-in admin recipients.

### membership-application-approved

Subject:

```text
Your {{CLUB_NAME}} membership has been approved
```

Body:

```text
Membership Approved

Hi {{firstName}}, your {{CLUB_NAME}} membership application has been approved.

Your account is ready. Use the button below to set your password and access the bookings system.

Set Up My Account: {{BASE_URL}}/reset-password?token={{token}}

Committee note: {{adminNotes}} [only when adminNotes exists]

Your entrance fee and any membership charges will be managed separately through the club's normal process.

This setup link expires in 7 days.
```

Triggers and frequency:

- Admin approves a membership application.
- One email per approved applicant.

### membership-application-rejected

Subject:

```text
Update on your {{CLUB_NAME}} membership application
```

Body:

```text
Membership Application Update

Hi {{firstName}}, your {{CLUB_NAME}} membership application has been reviewed.

The committee has decided not to approve the application at this time.

Committee note: {{adminNotes}} [only when adminNotes exists]

If you would like more information, please contact the club directly.

{{CLUB_NAME}} — {{SUPPORT_EMAIL}}
```

Triggers and frequency:

- Admin rejects a membership application.
- One email per rejected application.

### family-group-invitation

Subject:

```text
{{inviterName}} invited you to join {{groupName}} — {{CLUB_BOOKINGS_NAME}}
```

Body:

```text
Family Group Invitation

{{inviterName}} has invited you to join the family group {{groupName}}.

You can accept or decline this invitation from your profile page.

View Invitation: {{BASE_URL}}/profile

If you weren't expecting this invitation, you can safely ignore it.
```

Triggers and frequency:

- Member invites another registered member to a family group.
- One email per invitation.

### family-group-invite-accepted

Subject:

```text
{{inviteeName}} has joined {{groupName}} — {{CLUB_BOOKINGS_NAME}}
```

Body:

```text
Invitation Accepted

{{inviteeName}} has accepted your invitation and joined {{groupName}}.

Your family group has been updated.

{{CLUB_NAME}} — {{SUPPORT_EMAIL}}
```

Triggers and frequency:

- Invited member accepts a family group invitation.
- Sent to the original inviter once per accepted invitation.

### child-request-submitted

Subject:

```text
Infant/Child/Youth request submitted — {{CLUB_BOOKINGS_NAME}}
```

Body:

```text
Infant/Child/Youth Request Submitted

Hi {{parentName}},

Your request to add {{childName}} to the family group {{groupName}} has been submitted.

An administrator will review your request and link the member to your family group. You'll be notified once it's been processed.

{{CLUB_NAME}} — {{SUPPORT_EMAIL}}
```

Triggers and frequency:

- Member submits an infant/child/youth family-group request.
- Sent to the requester once per request.

### child-request-approved

Subject:

```text
{{childName}} has been added to {{groupName}} — {{CLUB_BOOKINGS_NAME}}
```

Body:

```text
Infant/Child/Youth Added to Family Group

Hi {{parentName}},

{{childName}} has been added to your family group {{groupName}}.

You can now include them when making bookings.

{{CLUB_NAME}} — {{SUPPORT_EMAIL}}
```

Triggers and frequency:

- Admin approves a `CHILD_REQUEST` family-group request.
- Sent to the requester once per approval.

### child-request-rejected

Subject:

```text
Infant/Child/Youth request update — {{CLUB_BOOKINGS_NAME}}
```

Body:

```text
Infant/Child/Youth Request Update

Hi {{parentName}},

Your request to add {{childName}} to your family group was not approved.

Admin note: {{reason}} [only when reason exists]

If you have questions, please contact the club.

{{CLUB_NAME}} — {{SUPPORT_EMAIL}}
```

Triggers and frequency:

- Admin rejects a `CHILD_REQUEST` family-group request.
- Sent to the requester once per rejection.

### admin-family-group-request

Subject:

```text
Family Group Request: {{requesterName}} ({{requestType}})
```

Body:

```text
Family Group Request

A new {{requestType}} request has been submitted.

Requester: {{requesterName}}

Group: {{groupName}}

{{details}}

Review Requests: {{BASE_URL}}/admin/family-groups

{{CLUB_NAME}} — {{SUPPORT_EMAIL}}
```

Triggers and frequency:

- Member submits an infant/child/youth request.
- Member submits a same-email adult request.
- Member submits a removal request.
- Member submits a join request.
- Sent to opted-in admins once per request event.

### join-request-confirmation

Subject:

```text
Join request submitted — {{CLUB_BOOKINGS_NAME}}
```

Body:

```text
Join Request Submitted

Hi {{requesterName}},

Your request to join the family group {{groupName}} has been submitted.

An administrator will review your request. You'll be notified once it's been processed.

{{CLUB_NAME}} — {{SUPPORT_EMAIL}}
```

Triggers and frequency:

- Member submits a family-group join request.
- Sent to the requester once per request.

### membership-cancellation-submitted

Subject:

```text
Membership cancellation request submitted — {{CLUB_BOOKINGS_NAME}}
```

Body:

```text
Membership Cancellation Request Submitted

Hi {{firstName}},

Your membership cancellation request has been submitted for admin review.

Included memberships: {{participantSummary}}

Reason: {{reason}} [only when reason exists]

Memberships remain active until an administrator approves the request. Any included login-capable adult must confirm before an administrator can process their cancellation.

View Request: {{reviewUrl}}

{{CLUB_NAME}} — {{SUPPORT_EMAIL}}
```

Triggers and frequency:

- Member submits a membership cancellation request.
- Sent once to the requester after the request is recorded.
- Email failure is returned as a non-blocking warning; the submitted request remains valid.

### membership-cancellation-confirmation

Subject:

```text
Confirm membership cancellation request — {{CLUB_BOOKINGS_NAME}}
```

Body:

```text
Confirm Membership Cancellation

Hi {{firstName}},

{{requesterName}} has included {{participantName}} in a membership cancellation request.

Your membership will remain active unless you sign in and confirm that you want to be included. This confirmation does not approve or process the cancellation; an administrator still needs to review the request.

Review Cancellation Request: {{BASE_URL}}/membership-cancellation/{{token}}

This link expires on {{expiresAt}}.

If you do not want to be included, use the link and choose Decline. If you were not expecting this request, you can ignore this email or contact the club.
```

Triggers and frequency:

- Member includes another login-capable adult in a membership cancellation request.
- Sent once per pending participant confirmation.

### membership-cancellation-approved

Subject:

```text
Membership cancellation approved — {{CLUB_BOOKINGS_NAME}}
```

Body:

```text
Membership Cancellation Approved

Hi {{firstName}},

The membership cancellation for {{participantName}} has been approved and processed.

Request reason: {{reason}} [only when reason exists]

This membership is now inactive and the booking login has been disabled. Booking, payment, and audit history has been retained.

Admin note: {{adminNote}} [only when adminNote exists]

{{rejoinProcessText}} [only when rejoinProcessText exists]

{{CLUB_NAME}} — {{SUPPORT_EMAIL}}
```

Triggers and frequency:

- Admin approves and locally processes a membership cancellation participant.
- Sent once per approved participant. Email failure is logged but does not block local cancellation processing.
- No Xero credit note, contact group, or archive action is performed by this email path.

### membership-cancellation-rejected

Subject:

```text
Membership cancellation update — {{CLUB_BOOKINGS_NAME}}
```

Body:

```text
Membership Cancellation Request Update

Hi {{firstName}},

The membership cancellation request for {{participantName}} was not approved at this time.

Request reason: {{reason}} [only when reason exists]

Admin note: {{adminNote}} [only when adminNote exists]

This membership remains active.

{{CLUB_NAME}} — {{SUPPORT_EMAIL}}
```

Triggers and frequency:

- Admin rejects a membership cancellation participant.
- Sent once per rejected participant.

### admin-membership-cancellation-request

Subject:

```text
Membership cancellation ready: {{requesterName}}
```

Body:

```text
Membership Cancellation Ready for Review

{{requesterName}} submitted a membership cancellation request with at least one participant ready for admin review.

Requester: {{requesterName}}
Included memberships: {{participantSummary}}

Reason: {{reason}} [only when reason exists]

Review Cancellation Requests: {{reviewUrl}}

{{CLUB_NAME}} — {{SUPPORT_EMAIL}}
```

Triggers and frequency:

- A membership cancellation request is submitted with at least one immediately reviewable participant, or an adult participant confirms inclusion.
- Sent to admins opted in to member request alerts.
- Respects the admin/system delivery policy for this template.

### age-up-invitation

Subject:

```text
You're now {{targetAgeTierLabel}} — set up your {{CLUB_NAME}} account
```

Body:

```text
Welcome to Your Own Account, {{firstName}}!

Congratulations — you've reached the {{targetAgeTierLabel}} age tier. You can now log in and book stays at the lodge yourself.

Click the button below to set up your password and activate your account. This link expires in 7 days.

Set Up My Password: {{BASE_URL}}/reset-password?token={{token}}

Once you set your password, you can log in at any time to book stays, view your bookings, and manage your profile.

If you have any questions, contact the club at {{SUPPORT_EMAIL}}.
```

Triggers and frequency:

- Age-up cron, scheduled daily at 6:30 AM NZST.
- Candidate criteria: active member, cannot login yet, age tier is not ADULT, date of birth places them in the configured ADULT age tier at the season start date.
- Requires the member to have a unique login email and no email-inheritance source.
- Skips if a sent/queued `age-up-invitation` already exists for the member email.
- Rolls back the login upgrade/token if email delivery fails so a later cron can retry.

### age-up-parent-email-handoff

Subject:

```text
Email address needed for {{memberName}}'s {{CLUB_NAME}} login
```

Body:

```text
Email Address Needed for {{memberName}}

Hi {{recipientName}},

{{memberName}} has reached the {{targetAgeTierLabel}} age tier. Before we can activate their own booking login, they need a unique email address on their member record.

They are currently using or inheriting another member's login email, so we have not enabled their login yet.

Please contact the club at {{SUPPORT_EMAIL}} with {{memberName}}'s preferred email address. Once it is updated, their booking login can be activated.
```

Triggers and frequency:

- Age-up cron, scheduled daily at 6:30 AM NZST.
- Sent to the parent, email-inheritance source, or existing shared-login holder when an ageing-up member still shares or inherits a login email.
- Does not include a token or login setup link.
- Leaves the ageing-up member unchanged: no login enablement, no setup token, and no age-tier update.
- Records an audit event keyed to the ageing-up member so the handoff is not resent every day; separate youths sharing the same recipient email are deduped independently.

### account-deletion-approved

Subject:

```text
Your Account Deletion Request Has Been Processed
```

Body:

```text
Account Deletion Confirmed

Hi {{firstName}},

We have processed your account deletion request. Your personal data has been anonymised in accordance with our Privacy Policy.

Your account is now deactivated and you will no longer be able to log in. Booking history has been retained for financial and audit purposes with your personal details removed.

If you have any questions, please contact the club.

{{CLUB_NAME}} — {{SUPPORT_EMAIL}}
```

Triggers and frequency:

- Admin approves an account deletion request.
- Sent before anonymisation, once per approval attempt. Email failure is logged but does not block deletion.

### account-deletion-rejected

Subject:

```text
Update on Your Account Deletion Request
```

Body:

```text
Account Deletion Request Update

Hi {{firstName}},

Your account deletion request has been reviewed and was not approved at this time.

Admin note: {{adminNote}} [only when adminNote exists]

If you have questions about this decision, please contact the club directly.

{{CLUB_NAME}} — {{SUPPORT_EMAIL}}
```

Triggers and frequency:

- Admin rejects an account deletion request.
- Sent once per rejection.

### admin-member-archive-requested

Subject:

```text
Member archive requested: {{memberName}}
```

Body:

```text
Member Archive Requested

{{requesterName}} requested archive review for {{memberName}}.

Member: {{memberName}}
Requested by: {{requesterName}}

Reason:
{{reason}}

Review Archive Requests: {{reviewUrl}}

{{CLUB_NAME}} — {{SUPPORT_EMAIL}}
```

Triggers and frequency:

- Admin submits an archive request for a cancelled member.
- Sent to admins opted in to member request alerts.
- Respects the admin/system delivery policy for this template.

### member-archive-approved

Subject:

```text
Membership archive completed — {{CLUB_BOOKINGS_NAME}}
```

Body:

```text
Membership Archive Completed

Hi {{firstName}},

Your cancelled membership record has been archived.

Reason:
{{reason}}

Review note: {{reviewNote}} [only when reviewNote exists]

Archive preserves booking, payment, Xero, and audit history while removing the record from default operational lists.

{{CLUB_NAME}} — {{SUPPORT_EMAIL}}
```

Triggers and frequency:

- Second admin approves an archive lifecycle request.
- Sent once to the archived member. Email failure is logged but does not block archival.

### member-archive-rejected

Subject:

```text
Membership archive request update — {{CLUB_BOOKINGS_NAME}}
```

Body:

```text
Membership Archive Request Update

Hi {{firstName}},

The archive request for your cancelled membership was not approved at this time.

Reason:
{{reason}}

Review note: {{reviewNote}} [only when reviewNote exists]

{{CLUB_NAME}} — {{SUPPORT_EMAIL}}
```

Triggers and frequency:

- Second admin rejects an archive lifecycle request.
- Sent once to the member whose archive was rejected. Email failure is logged but does not block rejection.

### admin-member-delete-requested

Subject:

```text
Member delete requested: {{memberName}}
```

Body:

```text
Member Delete Requested

{{requesterName}} requested hard-delete review for {{memberName}}.

Hard delete is only for records added in error with no meaningful booking, financial, lodge, Xero, or audit history.

Member: {{memberName}}
Requested by: {{requesterName}}

Reason:
{{reason}}

Review Member: {{reviewUrl}}

{{CLUB_NAME}} — {{SUPPORT_EMAIL}}
```

Triggers and frequency:

- Admin submits a hard-delete lifecycle request.
- Sent to admins opted in to member request alerts.
- Respects the admin/system delivery policy for this template.

### admin-member-delete-approved

Subject:

```text
Member delete approved: {{memberName}}
```

Body:

```text
Member Delete Approved

Hi {{requesterName}},

The hard-delete request for {{memberName}} was approved and processed.

Reason:
{{reason}}

Review note: {{reviewNote}} [only when reviewNote exists]

A request snapshot was retained before the member record was deleted.

{{CLUB_NAME}} — {{SUPPORT_EMAIL}}
```

Triggers and frequency:

- Second admin approves a hard-delete lifecycle request.
- Sent to the requesting admin after the member record is deleted. The target member is not emailed because hard delete is reserved for erroneous records.

### admin-member-delete-rejected

Subject:

```text
Member delete rejected: {{memberName}}
```

Body:

```text
Member Delete Request Rejected

Hi {{requesterName}},

The hard-delete request for {{memberName}} was not approved.

Reason:
{{reason}}

Review note: {{reviewNote}} [only when reviewNote exists]

Open Member: {{reviewUrl}}

{{CLUB_NAME}} — {{SUPPORT_EMAIL}}
```

Triggers and frequency:

- Second admin rejects a hard-delete lifecycle request.
- Sent once to the requesting admin. The target member is not emailed because hard delete is reserved for erroneous records.

### admin-new-booking

Subject variants:

```text
Booking Review Required: {{memberName}}
New Booking: {{memberName}} ({{status}})
```

Body:

```text
New Booking Created

A new booking has been created.

{{reviewReason}} [only when reviewReason exists]

Member: {{memberName}}
Check-in: {{checkIn}}
Check-out: {{checkOut}}
Guests: {{guestCount}}
Total: {{total}}
Status: {{status}}

View Bookings: {{BASE_URL}}/admin/bookings
```

Triggers and frequency:

- Booking creation route for new bookings.
- Waitlist booking creation.
- Draft booking confirm route, only if `requiresAdminReview`.
- Payment intent creation for draft -> payment pending, only if `requiresAdminReview`.
- Sent to opted-in admins once per relevant event.

### admin-payment-failure

Subject:

```text
Payment Failed — {{CLUB_BOOKINGS_NAME}}
```

Body:

```text
Payment Failed

A payment has failed and may require manual attention.

Member: {{memberName}}
Check-in: {{checkIn}}
Check-out: {{checkOut}}
Amount: {{amount}}
Error: {{errorMessage}}
Stripe PI: {{paymentIntentId}}

View Payments: {{BASE_URL}}/admin/payments
```

Triggers and frequency:

- Stripe payment failure webhook.
- Off-session saved-card charge requires additional authentication.
- Stripe amount mismatch manual-review paths.
- Stripe captures payment after booking cancellation and auto-refund path.
- Pending-booking cron every 3 hours when a Stripe charge attempt fails.
- Payment reconciliation capacity/refund failure path.
- Sent to opted-in admins once per failure event.

### admin-pending-deadline

Subject:

```text
{{count}} Pending Booking{{s}} Approaching Deadline
```

Body:

```text
Pending Bookings Approaching Deadline

{{count}} pending booking(s) will reach their hold deadline within 48 hours.

Member | Dates | Guests | Deadline | Remaining
{{memberName}} | {{checkIn}} – {{checkOut}} | {{guestCount}} | {{deadline}} | {{hoursRemaining}}h
...

View Bookings: {{BASE_URL}}/admin/bookings
```

Triggers and frequency:

- Pending deadline cron, scheduled daily at 8:00 AM NZST.
- Sends only when one or more `PENDING` bookings have `nonMemberHoldUntil` greater than now and within the next 48 hours.
- One digest alert event per daily run with matches, multiplied by opted-in admin recipients.

### admin-booking-bumped

Subject:

```text
Booking Bumped: {{bumpedMemberName}}
```

Body:

```text
Booking Bumped

A pending booking has been bumped due to a member booking.

Bumped Member: {{bumpedMemberName}}
Check-in: {{checkIn}}
Check-out: {{checkOut}}
Guests: {{guestCount}}
Triggered By: {{triggeringMemberName}}

View Bookings: {{BASE_URL}}/admin/bookings
```

Triggers and frequency:

- Sent to opted-in admins from `sendBumpedNotifications()` after a pending booking is bumped by a member booking.
- One alert event per bumped booking.

### admin-capacity-warning

Subject:

```text
Capacity Warning: {{count}} high-occupancy day{{s}} ahead
```

Body:

```text
Capacity Warning

{{count}} day(s) in the next 14 days have high occupancy.

Date | Occupied | Available | Occupancy
{{date}} | {{occupiedBeds}}/{{LODGE_CAPACITY}} | {{availableBeds}} | {{percent}}%
...

View Bookings: {{BASE_URL}}/admin/bookings
```

Triggers and frequency:

- Capacity warning cron, scheduled daily at 7:00 AM NZST.
- Looks at the next 14 nights and sends when any night has 5 or fewer beds available.
- One alert event per daily run with high-occupancy days, multiplied by opted-in admin recipients.

### admin-daily-digest

Subject:

```text
Admin Daily Digest - {{totalAlerts}} alert{{s}} in past 24h
```

Body when alerts exist:

```text
Admin Daily Digest

Summary of admin alerts from the past 24 hours.

Alert Type | Count | Action
New Bookings | {{count}} | View
Payment Failures | {{count}} | View
Capacity Warnings | {{count}} | View
Bookings Bumped | {{count}} | View
Pending Deadlines | {{count}} | View
Xero Errors | {{count}} | View

Total alerts: {{totalAlerts}}

Open Admin Dashboard: {{BASE_URL}}/admin/dashboard
```

Body when no alerts exist:

```text
Admin Daily Digest

Summary of admin alerts from the past 24 hours.

No alerts were triggered in the past 24 hours. All systems running normally.

Total alerts: 0

Open Admin Dashboard: {{BASE_URL}}/admin/dashboard
```

Triggers and frequency:

- Admin digest cron, scheduled daily at 7:30 AM NZST.
- Counts distinct sent/queued admin alert events from the last 24 hours by `templateName + subject`.
- Default delivery policy is content-only, so the cron run is logged but no
  email is sent when the count is zero. Admins can change the policy to always
  send or disabled from `/admin/notifications`.

### admin-xero-sync-error

Subject:

```text
Xero Sync Error — {{CLUB_BOOKINGS_NAME}}
```

Body:

```text
Xero Sync Error

A Xero integration error occurred and may require attention.

Error Type: {{errorType}}
Operation: {{operation}}
Error Message: {{errorMessage}}
Timestamp: {{timestamp}}

View Xero Status: {{BASE_URL}}/admin/xero
```

Triggers and frequency:

- Deduplicated `notifyXeroSyncError()` wrapper.
- Called when booking invoice queueing fails after Stripe payment success.
- Called from Xero contact/group sync error handling.
- Suppressed if any sent/queued `admin-xero-sync-error` exists in the last hour.
- At most one of this template per hour across the app.

### admin-xero-repeated-failure

Subject:

```text
Repeated Xero Failure: {{correlationKey}}
```

Body:

```text
Repeated Xero Failures

The same Xero sync correlation key has failed repeatedly and now needs operator attention.

Correlation Key: {{correlationKey}}
Failures in Window: {{failureCount}} in the last {{windowHours}} hour(s)
Entity: {{entityType}}
Operation: {{operationType}}
Local Record: {{localModel}} {{localId}} OR Unavailable
Latest Error: {{latestErrorMessage}} OR Unavailable
Timestamp: {{timestamp}}

Open local record [only when localUrl exists]
Open Xero object [only when xeroObjectUrl exists]

Open Xero Admin: {{BASE_URL}}/admin/xero
```

Triggers and frequency:

- When a Xero sync operation becomes `FAILED` or `PARTIAL`.
- Default threshold: at least 3 failed/partial operations with the same correlation key in a 24-hour window.
- Suppressed if a sent/queued alert for the same subject exists in that same window.

### admin-xero-reconciliation-report

Subject variants:

```text
Xero Reconciliation Report - clean
Xero Reconciliation Report - action needed: {{issueCategoryCount}} categor{{y|ies}}, {{issueTotalCount}} item{{s}}
```

Body:

```text
Xero Reconciliation Report

No open reconciliation gaps were detected in this report window.
```

or:

```text
Xero Reconciliation Report

Reconciliation gaps were detected. Start with the action sections below, then use the diagnostic totals for context.

Generated: {{generatedAt}}
Lookback Window: {{lookbackHours}} hour(s)
Stale Pending Threshold: {{stalePendingMinutes}} minute(s)
Issue Categories: {{issueCategoryCount}}
Total Issue Count: {{issueTotalCount}}

{{severityLabel}} • {{section.count}}
{{section.title}}
What went wrong: {{section.whatWentWrong}}
How to fix: {{section.howToFix}}

{{item.label}}
{{item metadata}}
{{item.detail}}
Latest error: {{item.latestErrorMessage}}
Open booking record
Open Xero

Diagnostic totals
Missing member contact links: {{count}}
Missing payment invoice links: {{count}}
Missing refund credit note links: {{count}}
Missing subscription invoice links: {{count}}
Mismatched canonical links: {{count}}
Stale canonical links: {{count}}
Duplicate active canonical links: {{count}}
Stale pending/running operations: {{count}}
Recent failed operations: {{count}}
Recent partial operations: {{count}}
Unsupported partial operations: {{count}}
Repeated-failure correlations: {{count}}

Open Xero Admin: {{BASE_URL}}/admin/xero
```

Triggers and frequency:

- Nightly Xero reconciliation cron, scheduled daily at 2:35 AM NZST when the Xero module is enabled.
- `POST /api/cron/xero` with task `report` or `all`.
- Default delivery policy is content-only, so a clean report is logged but not
  emailed. Admins can change the policy to always send or disabled from
  `/admin/notifications`.

### admin-refund-request

Subject:

```text
Refund Appeal: {{memberName}}
```

Body:

```text
Refund Appeal Submitted

{{memberName}} has submitted a refund appeal.

Member: {{memberName}}
Check-in: {{checkIn}}
Check-out: {{checkOut}}
Paid: ${{paidAmount}}
Already Refunded: ${{refundedAmount}}
Remaining: ${{remainingAmount}}
Requested: ${{requestedAmount}} [only when requestedAmountCents is truthy]

{{reason}}

Review Appeal: {{BASE_URL}}/admin/refund-requests
```

Triggers and frequency:

- Member submits a refund appeal for an eligible cancelled booking.
- Sent to opted-in admins once per submitted refund request.

### admin-booking-change-request

Subject:

```text
Booking Change Request: {{memberName}}
```

Body:

```text
Booking Change Request Submitted

{{memberName}} has requested an admin-reviewed booking change for a locked same-day or past-night period.

Member: {{memberName}}
Email: {{memberEmail}}
Booking: {{bookingId}}
Current check-in: {{checkIn}}
Current check-out: {{checkOut}}
Requested change: {{requestedSummary}}

Reason: {{reason}} [only when reason exists]

Review Request: {{reviewUrl}}
```

Triggers and frequency:

- Member or admin submits a booking change request for locked same-day or
  past-night booking changes.
- Sent to opted-in admins once per submitted booking change request.

### refund-request-resolved

Approved subject:

```text
Refund Appeal Approved — {{CLUB_BOOKINGS_NAME}}
```

Rejected subject:

```text
Refund Appeal Update — {{CLUB_BOOKINGS_NAME}}
```

Approved body:

```text
Refund Appeal Approved

Hi {{firstName}},

Your refund appeal for your booking ({{checkIn}} - {{checkOut}}) has been approved. A refund of {{amount}} will be processed to your original payment method.

Notes:
{{adminNotes}} [only when adminNotes exists]

If you have questions, contact the club at {{SUPPORT_EMAIL}}.
```

Rejected body:

```text
Refund Appeal Update

Hi {{firstName}},

Your refund appeal for your booking ({{checkIn}} - {{checkOut}}) was not approved at this time.

Notes:
{{adminNotes}} [only when adminNotes exists]

If you have questions, contact the club at {{SUPPORT_EMAIL}}.
```

Triggers and frequency:

- Admin approves or rejects a pending refund appeal.
- One email to the member per appeal review.

### admin-issue-report

Subject:

```text
Issue Report: {{memberName}}
```

Body:

```text
Issue Report Submitted

{{memberName}} has reported an issue from the bookings site.

Member: {{memberName}}
Email: {{memberEmail}}
Page: {{pageTitle OR pageUrl}}
Screenshot: Available in admin OR Not included

{{description}}

Review Issue Report: {{issueReportUrl}}

Open Reported Page: {{pageUrl}}
```

Triggers and frequency:

- Authenticated member submits an issue report.
- Sent to opted-in admins once per issue report.

### bulk-communication

Subject:

```text
{{adminEnteredSubject}}
```

Body:

```text
{{adminEnteredSubject}}

{{adminEnteredBody}}

This email was sent to you by the {{CLUB_NAME}} administration. You can update your email preferences in your account settings.

Manage Preferences: {{BASE_URL}}/profile
```

Triggers and frequency:

- `POST /api/admin/communications/send`.
- Admin chooses recipients: all active, members-only, admins-only, or custom.
- Recipients are filtered to those with `marketingEmails === true`; no preference record means excluded.
- Global rate limit: 1 bulk send per hour.
- Sends in background batches of 10 with 1 second between batches.

### website-contact

Subject:

```text
Website Contact{{recipientLabel}}: {{name}}
```

Body:

```text
New Contact Form Submission

Name: {{name}}
Email: {{email}}
Message: {{message}}
```

Triggers and frequency:

- `POST /api/contact`.
- Sends to `CONTACT_EMAIL` or an active committee member matching `recipient`.
- Actual rate limiter is 10 requests per hour. The route comment says 5 per hour, but the configured limiter is 10 per hour.
- This message does not use the common branded layout.

### admin-email-failure

Subject:

```text
Email delivery permanently failed
```

Body:

```text
Email to {{originalRecipient}} (template: {{originalTemplateName}}) has failed after {{attemptCount}} attempts and will not be retried.
```

Triggers and frequency:

- Email retry cron runs every 30 minutes.
- When a non-sensitive failed email reaches 3 attempts, active admins are alerted.
- This alert is not itself retried recursively.
- This message does not use the common branded layout.

### credit-applied-to-booking

No sender was found for this template.

Subject: no subject is defined in `email.ts`.

Body:

```text
Account Credit Applied

Hi {{firstName}}, account credit was applied to your booking.

Check-in: {{checkIn}}
Check-out: {{checkOut}}
Credit applied: {{creditUsed}}
Remaining credit: {{remainingCredit}}
```
