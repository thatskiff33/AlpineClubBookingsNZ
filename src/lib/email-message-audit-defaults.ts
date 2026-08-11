// Authoritative editor-safe defaults for the admin editor and server-side
// render path. Keep template keys and wording aligned when the registry changes.
import { BOOKING_URL_TEMPLATE_NAMES } from "@/lib/booking-email-template-contract";

const EMAIL_AUDIT_DEFAULTS_BASE = {
  "password-reset": {
    "defaultSubject": "Reset your {{CLUB_NAME}} password",
    "defaultBody": "Password Reset\n\nYou requested a password reset for your {{CLUB_NAME}} booking account.\n\nClick the button below to set a new password. This link expires in 1 hour.\n\nReset Password: {{BASE_URL}}/reset-password?token={{token}}\n\nIf you didn't request this, you can safely ignore this email. Your password will remain unchanged."
  },
  "admin-password-reset": {
    "defaultSubject": "Reset your {{CLUB_NAME}} password",
    "defaultBody": "Password Reset\n\nAn administrator has requested a password reset for your {{CLUB_NAME}} booking account.\n\nClick the button below to set a new password. This link expires in {{expiryLabel}}.\n\nReset Password: {{BASE_URL}}/reset-password?token={{token}}\n\nIf you believe this was sent in error, please contact the club administrator."
  },
  "member-setup-invite": {
    "defaultSubject": "Set up your {{CLUB_NAME}} account (7-day link)",
    "defaultBody": "Set Up Your Account\n\nHi {{firstName}},\n\nAn administrator has created your {{CLUB_NAME}} booking account.\n\nUse the button below to set your password and activate your login. This link expires in 7 days.\n\nSet Up My Password: {{BASE_URL}}/reset-password?token={{token}}\n\nIf you were not expecting this invite, you can safely ignore it or contact the club."
  },
  "email-verification": {
    "defaultSubject": "Verify your email — {{CLUB_BOOKINGS_NAME}}",
    "defaultBody": "Verify Your Email\n\nHi {{firstName}}, thanks for creating your {{CLUB_NAME}} booking account!\n\nPlease verify your email address by clicking the button below.\n\nVerify Email: {{BASE_URL}}/verify-email?token={{token}}\n\nThis link expires on {{expiresAt}}. If you did not create this account, please ignore this email."
  },
  "email-change-verification": {
    "defaultSubject": "Confirm your new email — {{CLUB_BOOKINGS_NAME}}",
    "defaultBody": "Confirm Your New Email\n\nYou requested to change the email address on your {{CLUB_NAME}} account to {{newEmail}}.\n\nClick the button below to confirm this change.\n\nConfirm Email Change: {{BASE_URL}}/confirm-email-change?token={{token}}\n\nThis link expires on {{expiresAt}}. If you did not request this change, please ignore this email."
  },
  "email-change-notification": {
    "defaultSubject": "Email change requested — {{CLUB_BOOKINGS_NAME}}",
    "defaultBody": "Email Change Requested\n\nSomeone requested to change the email address on your {{CLUB_NAME}} account to {{newEmail}}.\n\nIf this wasn't you, please contact the club immediately.\n\nIf you made this request, you can safely ignore this email. The change will only take effect after verification."
  },
  "magic-link-login": {
    "defaultSubject": "Your {{CLUB_NAME}} sign-in link",
    "defaultBody": "Sign In to {{CLUB_NAME}}\n\nYou asked to sign in to your {{CLUB_NAME}} booking account with an email link.\n\nClick the button below to sign in. This link can be used once and expires shortly.\n\nSign In: {{BASE_URL}}/login/magic?token={{token}}\n\nIf you didn't request this, you can safely ignore this email — your account stays secure and you can still sign in with your password."
  },
  "booking-confirmed": {
    "defaultSubject": "Booking Confirmed - {{CLUB_LODGE_NAME}}",
    "defaultBody": "Booking Confirmed\n\nHi {{firstName}}, your lodge booking has been confirmed!\n\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\nGuests: {{guestCount}}\n{{promoSummary}}{{paymentOutcome}}\n\n{{provisionalGuestsNote}}\n\nHow to get to the lodge\n\n{{CLUB_LODGE_TRAVEL_NOTE}}\n\n{{doorCodeNote}}\n\nYou can view your booking details and manage your stay from your account.\n\nView Booking: {{BASE_URL}}/bookings"
  },
  "booking-pending": {
    "defaultSubject": "Booking Pending - {{CLUB_LODGE_NAME}}",
    "defaultBody": "Booking Pending\n\nHi {{firstName}}, your lodge booking has been received and is currently pending.\n\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\nGuests: {{guestCount}}\nHold Until: {{holdUntil}}\n\nYour booking includes non-member guests and will be held as pending until {{holdUntil}}.\n\nDuring this time, club members have priority. If the lodge fills up with member bookings, your booking may be bumped. Your card will only be charged when the booking is confirmed.\n\nView Booking: {{BASE_URL}}/bookings"
  },
  "booking-bumped": {
    "defaultSubject": "Booking Update - {{CLUB_LODGE_NAME}}",
    "defaultBody": "Booking Update\n\nHi {{firstName}}, unfortunately your pending lodge booking has been bumped due to member demand.\n\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\nGuests: {{guestCount}}\n\nYour card has not been charged.\n\nAs a non-member booking, priority is given to club members when the lodge reaches capacity. You're welcome to rebook for different dates where availability exists.\n\n{{rebookLabel}}: {{BASE_URL}}{{rebookPath}}\n\nIf you have any questions, contact the club at {{SUPPORT_EMAIL}}.\n\nWe apologise for the inconvenience."
  },
  "booking-guests-cancelled": {
    "defaultSubject": "Booking Cancelled - {{CLUB_LODGE_NAME}}",
    "defaultBody": "Booking Cancelled\n\nHi {{firstName}}, you asked us to cancel your whole booking if your non-member guests couldn't come. The lodge filled up with member bookings, so we've cancelled it.\n\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\n\nYour card has not been charged.\n\nYou're welcome to rebook for different dates where availability exists.\n\nBook Again: {{BASE_URL}}/book"
  },
  "booking-cancelled": {
    "defaultSubject": "Booking Cancelled - {{CLUB_LODGE_NAME}}",
    "defaultBody": "Booking Cancelled\n\nHi {{firstName}}, your lodge booking has been cancelled.\n\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\n\n{{refundMessage}}\n\n{{creditRestoredMessage}}\n\nYou can make a new booking at any time from your account.\n\nMake a New Booking: {{BASE_URL}}/book"
  },
  "booking-policy-exception-approved": {
    "defaultSubject": "Your Request Was Approved - {{CLUB_LODGE_NAME}}",
    "defaultBody": "Your Request Was Approved\n\nHi {{firstName}}, an administrator has approved your request and your booking is now in place.\n\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\nGuests: {{guestCount}}\n\n{{paymentNote}}\n\n{{adminNotesLine}}\n\nView Booking: {{BASE_URL}}/bookings"
  },
  "booking-modified": {
    "defaultSubject": "Booking Modified - {{CLUB_LODGE_NAME}}",
    "defaultBody": "Booking Modified\n\nHi {{firstName}}, your booking has been updated.\n\n{{modificationTypeLabel}}\n\n{{changeSummary}}\n{{paymentNote}}\n\nYou can view your updated booking details from your account.\n\nView Booking: {{BASE_URL}}/bookings"
  },
  "checkin-reminder": {
    "defaultSubject": "Check-in Reminder - {{CLUB_LODGE_NAME}}",
    "defaultBody": "Check-in Reminder\n\nHi {{firstName}}, your lodge stay begins tomorrow!\n\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\nGuests: {{guestCount}}\n\nGuest list:\n\n{{guestName}}\n\n{{choreListNote}}Please ensure you arrive prepared for alpine conditions. Check the weather forecast before departing.\n\n{{CLUB_LODGE_TRAVEL_NOTE}}\n\nView Booking: {{BASE_URL}}/bookings"
  },
  "pre-arrival-reminder": {
    "defaultSubject": "Pre-arrival Information - {{CLUB_LODGE_NAME}}",
    "defaultBody": "Upcoming Lodge Stay\n\nHi {{firstName}}, your lodge stay is coming up.\n\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\nGuests: {{guestCount}}\n{{expectedArrivalNote}}\n{{checkoutChoreNote}}{{outstandingAdditionalNote}}\n\nHow to get to the lodge\n\n{{CLUB_LODGE_TRAVEL_NOTE}}\n\n{{doorCodeNote}}\n\nView Booking: {{BASE_URL}}/bookings"
  },
  "additional-payment-reminder": {
    "defaultSubject": "Payment Still Needed - {{CLUB_LODGE_NAME}}",
    "defaultBody": "Payment Still Needed\n\nHi {{firstName}}, a change to your lodge booking increased the total, and the extra amount has not been paid yet.\n\nAmount still to pay: {{additionalAmount}}\nRequested on: {{requestedOn}}\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\n\nOpen your booking and complete the outstanding payment. If you have already paid, or you think this is wrong, please contact the club.\n\nPay Now: {{BASE_URL}}/bookings"
  },
  "chore-roster": {
    "defaultSubject": "Your chore roster for {{formattedDate}} - {{CLUB_LODGE_NAME}}",
    "defaultBody": "Chore Roster\n\nHi {{guestName}},\n\nHere are your assigned chores for {{formattedDate}} at the lodge:\n\n{{choreListNote}}{{choreLinkNote}}Last person to bed: Check heaters and fire are safe and doors are secure.\n\nThanks for helping keep the lodge running smoothly!"
  },
  "hut-leader-assignment": {
    "defaultSubject": "Your {{CLUB_NAME}} hut leader assignment",
    "defaultBody": "Hut Leader Assignment\n\nHi {{firstName}}, thanks for taking on hut leader duties for the lodge.\n\nStart date: {{startDate}}\nEnd date: {{endDate}}\nKiosk PIN: {{pin}}\n\nWhen you arrive, open the lodge kiosk and use this PIN to unlock hut leader controls for arrivals, departures, and roster management.\n\nPlease keep this PIN private and share it only with the assigned hut leader team for these dates.\n\nResponsibilities include checking the lodge list, helping guests settle in, marking arrivals and departures, and making sure the daily chore roster is set up and completed.\n\nOpen Lodge View: {{BASE_URL}}/lodge\n\nIf you have any issues accessing the kiosk, please contact a club administrator."
  },
  "setup-intent-failed": {
    "defaultSubject": "Card Setup Failed - {{CLUB_LODGE_NAME}}",
    "defaultBody": "Card Setup Failed\n\nHi {{firstName}},\n\nWe were unable to save your card details for your upcoming booking ({{checkIn}} – {{checkOut}}). Your booking is still held, but we won't be able to charge you automatically when it's confirmed.\n\nPlease log in and update your payment method to avoid your booking being cancelled.\n\nUpdate Payment Method: {{BASE_URL}}/bookings\n\nIf you need help, contact the club at {{SUPPORT_EMAIL}}."
  },
  "waitlist-confirmation": {
    "defaultSubject": "Waitlist Confirmation - {{CLUB_LODGE_NAME}}",
    "defaultBody": "You're on the Waitlist\n\nHi {{firstName}}, the lodge is currently fully booked for your requested dates, but you've been added to the waitlist.\n\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\nGuests: {{guestCount}}\nWaitlist Position: #{{position}}\n\nWe'll email you as soon as a spot opens up. You'll have 48 hours to confirm your booking.\n\nView Booking: {{BASE_URL}}/bookings\n\nYou can cancel your waitlist entry at any time from your booking page."
  },
  "waitlist-offer": {
    "defaultSubject": "Spot Available! - {{CLUB_LODGE_NAME}}",
    "defaultBody": "A Spot Has Opened Up!\n\nHi {{firstName}}, great news — a spot has become available for your waitlisted booking.\n\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\nGuests: {{guestCount}}\nPrice: {{price}}\n\nThis offer expires on {{expiresAt}}. If you don't confirm in time, the spot will be offered to the next person in line.\n\nConfirm Booking: {{BASE_URL}}/bookings/{{bookingId}}\n\nIf you no longer need this booking, you can decline from your booking page."
  },
  "waitlist-offer-expired": {
    "defaultSubject": "Waitlist Offer Expired - {{CLUB_LODGE_NAME}}",
    "defaultBody": "Waitlist Offer Expired\n\nHi {{firstName}}, your waitlist offer for the dates below has expired.\n\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\nNew Position: #{{position}}\n\nYou've been returned to the waitlist. We'll notify you again if another spot opens up.\n\nView Booking: {{BASE_URL}}/bookings"
  },
  "waitlist-place-restored": {
    "defaultSubject": "Your Waitlist Place Is Back - {{CLUB_LODGE_NAME}}",
    "defaultBody": "Your Waitlist Place Is Back\n\nHi {{firstName}}, your booking for the dates below could not be finished, so we have put you back on the waitlist. This was not something you did wrong, and your offer did not run out — you confirmed in time and our system could not complete it.\n\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\nNew Position: #{{position}}\n\nYou do not need to do anything. We will email you again as soon as a spot opens up for these nights.\n\nView Booking: {{BASE_URL}}/bookings"
  },
  "admin-waitlist-offer": {
    "defaultSubject": "Waitlist Offer: {{memberName}}",
    "defaultBody": "Waitlist Offer Made\n\nA waitlist offer has been sent to {{memberName}}.\n\nMember: {{memberName}}\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\nGuests: {{guestCount}}\nQueue Position: #{{position}}\n\nThe member has 48 hours to confirm their booking.\n\nView Waitlist: {{BASE_URL}}/admin/waitlist"
  },
  "nomination-request": {
    "defaultSubject": "Nomination request for {{applicantName}} — {{CLUB_NAME}}",
    "defaultBody": "Membership Nomination Request\n\nHi {{nominatorName}},\n\n{{applicantName}} has listed you as one of their {{CLUB_NAME}} nominators.\n\nDependent family members included in this application: {{familyMemberCount}}\n\nPlease review the application and confirm whether you agree to nominate this person for membership.\n\nYou will need to sign in before you can confirm the nomination.\n\nReview Application: {{BASE_URL}}/nominations/{{token}}\n\nThis link expires on {{expiresAt}}."
  },
  "admin-membership-application-pending": {
    "defaultSubject": "Membership application ready: {{applicantName}}",
    "defaultBody": "Membership Application Ready for Review\n\nBoth nominators have now confirmed a new membership application.\n\nApplicant: {{applicantName}}\nEmail: {{applicantEmail}}\n\nDependent family members included in this application: {{familyMemberCount}}\n\nReview Application: {{BASE_URL}}/admin/member-applications\n\n{{CLUB_NAME}} — {{SUPPORT_EMAIL}}"
  },
  "membership-application-approved": {
    "defaultSubject": "Your {{CLUB_NAME}} membership has been approved",
    "defaultBody": "Membership Approved\n\nHi {{firstName}}, your {{CLUB_NAME}} membership application has been approved.\n\nYour account is ready. Use the button below to set your password and access the bookings system.\n\nSet Up My Account: {{BASE_URL}}/reset-password?token={{token}}\n\n{{committeeNote}}Your joining fee and any membership charges will be managed separately through the club's normal process.\n\nThis setup link expires in 7 days."
  },
  "membership-application-rejected": {
    "defaultSubject": "Update on your {{CLUB_NAME}} membership application",
    "defaultBody": "Membership Application Update\n\nHi {{firstName}}, your {{CLUB_NAME}} membership application has been reviewed.\n\nThe committee has decided not to approve the application at this time.\n\n{{committeeNote}}If you would like more information, please contact the club directly.\n\n{{CLUB_NAME}} — {{SUPPORT_EMAIL}}"
  },
  "family-group-invitation": {
    "defaultSubject": "{{inviterName}} invited you to join {{groupName}} — {{CLUB_BOOKINGS_NAME}}",
    "defaultBody": "Family Group Invitation\n\n{{inviterName}} has invited you to join the family group {{groupName}}.\n\nYou can accept or decline this invitation from your profile page.\n\nView Invitation: {{BASE_URL}}/profile\n\nIf you weren't expecting this invitation, you can safely ignore it."
  },
  "family-group-invite-accepted": {
    "defaultSubject": "{{inviteeName}} has joined {{groupName}} — {{CLUB_BOOKINGS_NAME}}",
    "defaultBody": "Invitation Accepted\n\n{{inviteeName}} has accepted your invitation and joined {{groupName}}.\n\nYour family group has been updated.\n\n{{CLUB_NAME}} — {{SUPPORT_EMAIL}}"
  },
  "child-request-submitted": {
    "defaultSubject": "Infant/Child/Youth request submitted — {{CLUB_BOOKINGS_NAME}}",
    "defaultBody": "Infant/Child/Youth Request Submitted\n\nHi {{parentName}},\n\nYour request to add {{childName}} to the family group {{groupName}} has been submitted.\n\nAn administrator will review your request and link the member to your family group. You'll be notified once it's been processed.\n\n{{CLUB_NAME}} — {{SUPPORT_EMAIL}}"
  },
  "child-request-approved": {
    "defaultSubject": "{{childName}} has been added to {{groupName}} — {{CLUB_BOOKINGS_NAME}}",
    "defaultBody": "Infant/Child/Youth Added to Family Group\n\nHi {{parentName}},\n\n{{childName}} has been added to your family group {{groupName}}.\n\nYou can now include them when making bookings.\n\n{{CLUB_NAME}} — {{SUPPORT_EMAIL}}"
  },
  "child-request-rejected": {
    "defaultSubject": "Infant/Child/Youth request update — {{CLUB_BOOKINGS_NAME}}",
    "defaultBody": "Infant/Child/Youth Request Update\n\nHi {{parentName}},\n\nYour request to add {{childName}} to your family group was not approved.\n\n{{adminNoteLine}}If you have questions, please contact the club.\n\n{{CLUB_NAME}} — {{SUPPORT_EMAIL}}"
  },
  "admin-family-group-request": {
    "defaultSubject": "Family Group Request: {{requesterName}} ({{requestType}})",
    "defaultBody": "Family Group Request\n\nA new {{requestType}} request has been submitted.\n\nRequester: {{requesterName}}\n\nGroup: {{groupName}}\n\n{{details}}\n\nReview Requests: {{BASE_URL}}/admin/family-groups\n\n{{CLUB_NAME}} — {{SUPPORT_EMAIL}}"
  },
  "join-request-confirmation": {
    "defaultSubject": "Join request submitted — {{CLUB_BOOKINGS_NAME}}",
    "defaultBody": "Join Request Submitted\n\nHi {{requesterName}},\n\nYour request to join the family group {{groupName}} has been submitted.\n\nAn administrator will review your request. You'll be notified once it's been processed.\n\n{{CLUB_NAME}} — {{SUPPORT_EMAIL}}"
  },
  "family-group-create-request-confirmation": {
    "defaultSubject": "Family group request submitted — {{CLUB_BOOKINGS_NAME}}",
    "defaultBody": "Family Group Request Submitted\n\nHi {{requesterName}},\n\nYour request to create the family group {{groupName}} has been submitted.\n\nAn administrator will review your request. You'll be notified once it's been processed.\n\n{{CLUB_NAME}} — {{SUPPORT_EMAIL}}"
  },
  "family-group-create-approved": {
    "defaultSubject": "Your family group {{groupName}} has been created — {{CLUB_BOOKINGS_NAME}}",
    "defaultBody": "Family Group Created\n\nHi {{requesterName}},\n\nYour family group {{groupName}} has been approved and created. You are the group admin.\n\nAny partner invitation has been sent for them to accept from their profile, and any infant/child/youth requests you included are reviewed separately by an administrator.\n\n{{CLUB_NAME}} — {{SUPPORT_EMAIL}}"
  },
  "family-group-create-rejected": {
    "defaultSubject": "Family group request update — {{CLUB_BOOKINGS_NAME}}",
    "defaultBody": "Family Group Request Update\n\nHi {{requesterName}},\n\nYour request to create the family group {{groupName}} was not approved.\n\n{{adminNoteLine}}If you have questions, please contact the club.\n\n{{CLUB_NAME}} — {{SUPPORT_EMAIL}}"
  },
  "partner-invite": {
    "defaultSubject": "{{inviterName}} invited you to join {{groupName}} — {{CLUB_BOOKINGS_NAME}}",
    "defaultBody": "Family Group Invitation\n\n{{inviterName}} has invited you to join the family group {{groupName}}.\n\nUse the button below to get started. If you don't have a member account yet, you'll be guided through joining first, then you can accept this invitation once your login is active.\n\nAccept Invitation: {{BASE_URL}}/family-invite/{{token}}\n\nThis link expires on {{expiresAt}}.\n\nIf you weren't expecting this invitation, you can safely ignore it."
  },
  "partner-invite-claimed": {
    "defaultSubject": "You've joined {{groupName}} — {{CLUB_BOOKINGS_NAME}}",
    "defaultBody": "Family Group Joined\n\nHi {{firstName}},\n\nYou've joined the family group {{groupName}}.\n\nYou can now be included when your family makes bookings. Manage your family group from your profile page.\n\n{{CLUB_NAME}} — {{SUPPORT_EMAIL}}"
  },
  "partner-link-request": {
    "defaultSubject": "{{requesterName}} asked to record you as their partner — {{CLUB_BOOKINGS_NAME}}",
    "defaultBody": "Partner Confirmation Request\n\n{{requesterName}} has asked to record you as their partner (husband, wife, or partner).\n\nConfirming records the relationship with the club. You can confirm or decline from your profile page.\n\nRespond to Request: {{BASE_URL}}/profile\n\nIf you weren't expecting this request, you can decline it or safely ignore this email."
  },
  "partner-link-confirmed": {
    "defaultSubject": "Your partner relationship with {{partnerName}} has been recorded — {{CLUB_BOOKINGS_NAME}}",
    "defaultBody": "Partner Relationship Recorded\n\nYour partner relationship with {{partnerName}} has been recorded with the club.\n\nYou can view or remove this relationship from your profile page.\n\n{{CLUB_NAME}} — {{SUPPORT_EMAIL}}"
  },
  "partner-link-removed": {
    "defaultSubject": "Your partner relationship with {{partnerName}} has been removed — {{CLUB_BOOKINGS_NAME}}",
    "defaultBody": "Partner Relationship Removed\n\nYour recorded partner relationship with {{partnerName}} has been removed.\n\nIf you weren't expecting this change, please contact the club.\n\n{{CLUB_NAME}} — {{SUPPORT_EMAIL}}"
  },
  "membership-cancellation-submitted": {
    "defaultSubject": "Membership cancellation request submitted — {{CLUB_BOOKINGS_NAME}}",
    "defaultBody": "Membership Cancellation Request Submitted\n\nHi {{firstName}},\n\nYour membership cancellation request has been submitted for admin review.\n\nIncluded memberships: {{participantSummary}}\n\n{{reasonNote}}Memberships remain active until an administrator approves the request. Any included login-capable adult must confirm before an administrator can process their cancellation.\n\nView Request: {{reviewUrl}}\n\n{{CLUB_NAME}} — {{SUPPORT_EMAIL}}"
  },
  "membership-cancellation-confirmation": {
    "defaultSubject": "Confirm membership cancellation request — {{CLUB_BOOKINGS_NAME}}",
    "defaultBody": "Confirm Membership Cancellation\n\nHi {{firstName}},\n\n{{requesterName}} has included {{participantName}} in a membership cancellation request.\n\nYour membership will remain active unless you sign in and confirm that you want to be included. This confirmation does not approve or process the cancellation; an administrator still needs to review the request.\n\nPaid subscriptions are non-refundable if an administrator approves the cancellation. Any unpaid or overdue subscription invoice will be cancelled with a Xero credit note.\n\nReview Cancellation Request: {{BASE_URL}}/membership-cancellation/{{token}}\n\nThis link expires on {{expiresAt}}.\n\nIf you do not want to be included, use the link and choose Decline. If you were not expecting this request, you can ignore this email or contact the club."
  },
  "membership-cancellation-approved": {
    "defaultSubject": "Membership cancellation approved — {{CLUB_BOOKINGS_NAME}}",
    "defaultBody": "Membership Cancellation Approved\n\nHi {{firstName}},\n\nThe membership cancellation for {{participantName}} has been approved and processed.\n\n{{reasonNote}}This membership is now inactive and the booking login has been disabled. Booking, payment, and audit history has been retained.\n\nIf this membership had an unpaid or overdue subscription invoice, that invoice has been cancelled with a Xero credit note. Paid subscriptions will not be refunded; thank you for being a member of {{CLUB_NAME}}.\n\n{{adminNoteLine}}{{rejoinProcessNote}}{{CLUB_NAME}} — {{SUPPORT_EMAIL}}"
  },
  "membership-cancellation-rejected": {
    "defaultSubject": "Membership cancellation update — {{CLUB_BOOKINGS_NAME}}",
    "defaultBody": "Membership Cancellation Request Update\n\nHi {{firstName}},\n\nThe membership cancellation request for {{participantName}} was not approved at this time.\n\n{{reasonNote}}{{adminNoteLine}}This membership remains active.\n\n{{CLUB_NAME}} — {{SUPPORT_EMAIL}}"
  },
  "admin-membership-cancellation-request": {
    "defaultSubject": "Membership cancellation ready: {{requesterName}}",
    "defaultBody": "Membership Cancellation Ready for Review\n\n{{requesterName}} submitted a membership cancellation request with at least one participant ready for admin review.\n\nRequester: {{requesterName}}\nIncluded memberships: {{participantSummary}}\n\n{{reasonNote}}Review Cancellation Requests: {{reviewUrl}}\n\n{{CLUB_NAME}} — {{SUPPORT_EMAIL}}"
  },
  "age-up-invitation": {
    "defaultSubject": "You're now {{targetAgeTierLabel}} — set up your {{CLUB_NAME}} account",
    "defaultBody": "Welcome to Your Own Account, {{firstName}}!\n\nCongratulations — you've reached the {{targetAgeTierLabel}} age tier. You can now log in and book stays at the lodge yourself.\n\nClick the button below to set up your password and activate your account. This link expires in 7 days.\n\nSet Up My Password: {{BASE_URL}}/reset-password?token={{token}}\n\nOnce you set your password, you can log in at any time to book stays, view your bookings, and manage your profile.\n\nIf you have any questions, contact the club at {{SUPPORT_EMAIL}}."
  },
  "age-up-parent-email-handoff": {
    "defaultSubject": "Email address needed for {{memberName}}'s {{CLUB_NAME}} login",
    "defaultBody": "Email Address Needed for {{memberName}}\n\nHi {{recipientName}},\n\n{{memberName}} has reached the {{targetAgeTierLabel}} age tier. Before we can activate their own booking login, they need a unique email address on their member record.\n\nThey are currently using or inheriting another member's login email, so we have not enabled their login yet.\n\nPlease contact the club at {{SUPPORT_EMAIL}} with {{memberName}}'s preferred email address. Once it is updated, their booking login can be activated."
  },
  "account-deletion-approved": {
    "defaultSubject": "Your Account Deletion Request Has Been Processed",
    "defaultBody": "Account Deletion Confirmed\n\nHi {{firstName}},\n\nWe have processed your account deletion request. Your personal data has been anonymised in accordance with our Privacy Policy.\n\nYour account is now deactivated and you will no longer be able to log in. Booking history has been retained for financial and audit purposes with your personal details removed.\n\nIf you have any questions, please contact the club.\n\n{{CLUB_NAME}} — {{SUPPORT_EMAIL}}"
  },
  "account-deletion-rejected": {
    "defaultSubject": "Update on Your Account Deletion Request",
    "defaultBody": "Account Deletion Request Update\n\nHi {{firstName}},\n\nYour account deletion request has been reviewed and was not approved at this time.\n\n{{adminNoteLine}}If you have questions about this decision, please contact the club directly.\n\n{{CLUB_NAME}} — {{SUPPORT_EMAIL}}"
  },
  "admin-account-deletion-requested": {
    "defaultSubject": "Account deletion requested: {{memberName}}",
    "defaultBody": "Account Deletion Request Submitted\n\n{{memberName}} submitted an account deletion request.\n\nMember: {{memberName}}\nEmail: {{memberEmail}}\n\n{{reasonNote}}Review Deletion Requests: {{reviewUrl}}\n\n{{CLUB_NAME}} — {{SUPPORT_EMAIL}}"
  },
  "admin-member-archive-requested": {
    "defaultSubject": "Member archive requested: {{memberName}}",
    "defaultBody": "Member Archive Requested\n\n{{requesterName}} requested archive review for {{memberName}}.\n\nMember: {{memberName}}\nRequested by: {{requesterName}}\n\nReason:\n{{reason}}\n\nReview Archive Requests: {{reviewUrl}}\n\n{{CLUB_NAME}} — {{SUPPORT_EMAIL}}"
  },
  "member-archive-approved": {
    "defaultSubject": "Membership archive completed — {{CLUB_BOOKINGS_NAME}}",
    "defaultBody": "Membership Archive Completed\n\nHi {{firstName}},\n\nYour cancelled membership record has been archived.\n\nReason:\n{{reason}}\n\n{{reviewNoteLine}}Archive preserves booking, payment, Xero, and audit history while removing the record from default operational lists.\n\n{{CLUB_NAME}} — {{SUPPORT_EMAIL}}"
  },
  "member-archive-rejected": {
    "defaultSubject": "Membership archive request update — {{CLUB_BOOKINGS_NAME}}",
    "defaultBody": "Membership Archive Request Update\n\nHi {{firstName}},\n\nThe archive request for your cancelled membership was not approved at this time.\n\nReason:\n{{reason}}\n\n{{reviewNoteLine}}{{CLUB_NAME}} — {{SUPPORT_EMAIL}}"
  },
  "admin-member-delete-requested": {
    "defaultSubject": "Member delete requested: {{memberName}}",
    "defaultBody": "Member Delete Requested\n\n{{requesterName}} requested hard-delete review for {{memberName}}.\n\nHard delete is only for records added in error with no meaningful booking, financial, lodge, Xero, or audit history.\n\nMember: {{memberName}}\nRequested by: {{requesterName}}\n\nReason:\n{{reason}}\n\nReview Member: {{reviewUrl}}\n\n{{CLUB_NAME}} — {{SUPPORT_EMAIL}}"
  },
  "admin-member-delete-approved": {
    "defaultSubject": "Member delete approved: {{memberName}}",
    "defaultBody": "Member Delete Approved\n\nHi {{requesterName}},\n\nThe hard-delete request for {{memberName}} was approved and processed.\n\nReason:\n{{reason}}\n\n{{reviewNoteLine}}A request snapshot was retained before the member record was deleted.\n\n{{CLUB_NAME}} — {{SUPPORT_EMAIL}}"
  },
  "admin-member-delete-rejected": {
    "defaultSubject": "Member delete rejected: {{memberName}}",
    "defaultBody": "Member Delete Request Rejected\n\nHi {{requesterName}},\n\nThe hard-delete request for {{memberName}} was not approved.\n\nReason:\n{{reason}}\n\n{{reviewNoteLine}}Open Member: {{reviewUrl}}\n\n{{CLUB_NAME}} — {{SUPPORT_EMAIL}}"
  },
  "admin-minors-review": {
    "defaultSubject": "Review required: booking has only under-18 guests ({{memberName}})",
    "defaultBody": "Booking Review Required\n\nA paid booking was edited and now has only under-18 guests. It is blocked from lodge check-in until an admin reviews it.\n\n{{reviewReason}}\n\nMember: {{memberName}}\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\nGuests: {{guestCount}}\n\nReview Bookings: {{BASE_URL}}/admin/bookings"
  },
  "admin-owner-substitution": {
    "defaultSubject": "Owner substitution — reconcile Xero contact for booking request {{requestId}}",
    "defaultBody": "Owner Substitution — Xero Reconciliation Required\n\nAn owner substitution occurred while converting booking request {{requestId}} into booking {{bookingId}}. The booking (and its Xero invoice) will bill a newly-created contact instead of the intended owner.\n\nAction required: reconcile the invoice's contact in Xero — repoint it from the newly-created contact to the intended organisation.\n\nIntended owner (should be billed): {{intendedMemberName}} ({{intendedMemberId}})\nSubstituted contact (currently billed): {{substituteMemberName}} ({{substituteMemberId}})\nReason: {{reason}}\nRequester: {{requesterName}} ({{memberEmail}})\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\n\nReview Bookings: {{BASE_URL}}/admin/bookings"
  },
  "admin-partner-share-swept": {
    "defaultSubject": "Review required: shared double-bed placements removed ({{memberName}})",
    "defaultBody": "Shared Double-Bed Placements Removed\n\nA partner pair no longer qualifies for double-bed sharing, so their future shared placements were removed. The affected guest nights are back in the awaiting-allocation queue and may need re-planning on the allocation board.\n\nMember: {{memberName}}\nPartner: {{partnerName}}\nReason: {{reason}}\nRemoved night{{s}}: {{date}}\n\nReview Bed Allocation: {{BASE_URL}}/admin/bed-allocation"
  },
  "admin-new-booking": {
    "defaultSubject": "New Booking: {{memberName}} ({{status}})",
    "defaultBody": "New Booking Created\n\nA new booking has been created.\n\n{{reviewReasonNote}}Member: {{memberName}}\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\nGuests: {{guestCount}}\nTotal: {{total}}\nStatus: {{status}}\n\nView Bookings: {{BASE_URL}}/admin/bookings"
  },
  "admin-payment-failure": {
    "defaultSubject": "Payment Failed — {{CLUB_BOOKINGS_NAME}}",
    "defaultBody": "Payment Failed\n\nA payment has failed and may require manual attention.\n\nMember: {{memberName}}\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\nAmount: {{amount}}\nError: {{errorMessage}}\nReference: {{paymentIntentId}}\n\nView Payments: {{BASE_URL}}/admin/payments"
  },
  "admin-duplicate-capture-refund": {
    "defaultSubject": "Duplicate capture auto-refunded: {{memberName}}",
    "defaultBody": "Duplicate Card Capture Auto-Refunded\n\n{{refundOutcomeNote}}\n\nMember: {{memberName}}\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\nAmount refunded: {{amount}}\nDuplicate Stripe PI: {{paymentIntentId}}\nRecovery operation: {{operation}}\n\nView Payments: {{reviewUrl}}"
  },
  "admin-manual-settlement-conflict": {
    "defaultSubject": "Cash settlement vs Xero payment — reconcile: {{memberName}}",
    "defaultBody": "Cash Settlement vs Xero Payment - Reconcile By Hand\n\nThis booking looks paid TWICE: once as a cash / off-Xero settlement recorded here, and again by a payment Xero now reports against its invoice. Nothing further has been written - please reconcile.\n\nAn admin recorded this booking's payment manually (cash, or a bank transfer that never reached Xero). Xero has since reported the booking's invoice as PAID. The system stopped rather than settling it a second time or minting member credit, so the two records now disagree and only a person can decide which money is real.\n\nCheck whether the Xero payment is genuinely separate funds - a second payment that needs refunding - or the same money reaching Xero late. Reverse the manual settlement, or refund the duplicate, whichever is true.\n\nMember: {{memberName}}\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\nBooking: {{bookingId}}\nBooking status: {{status}}\nAmount recorded as cash: {{amount}}\nXero invoice: {{xeroInvoiceNumber}}\nOpen the invoice in Xero: {{xeroObjectUrl}}\n\nView Payments: {{reviewUrl}}"
  },
  "admin-manual-refund-task": {
    "defaultSubject": "Manual refund needed - cash booking cancelled: {{memberName}}",
    "defaultBody": "Manual Refund Needed - Cash Booking Cancelled\n\nA booking settled in cash (or by an off-Xero bank transfer) has been cancelled. The refund has to be paid back by hand - nothing was refunded automatically.\n\nThe member's cancellation refund has been worked out under the club's normal policy, but there is no card charge to reverse and no Xero invoice to credit, so the system has raised a hand-back task instead of pretending money moved. The member has been told the club will arrange the refund.\n\nPay the member back, then mark the task complete on the payments board so the ledger records the refund. If the member declines it, or it was settled another way, dismiss the task with a note.\n\nMember: {{memberName}}\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\nBooking: {{bookingId}}\nAmount to refund: {{refundAmount}}\nReason: {{reason}}\n\nView Payments: {{reviewUrl}}"
  },
  // #2761: the alert for an automatically refunded late capture. Its OWN entry
  // rather than a variant of admin-payment-failure, so an admin's override of the
  // routine payment-failure wording cannot rewrite this notice and muting that
  // one cannot mute this one. Delivery-locked (see LOCKED_DELIVERY_TEMPLATE_NAMES)
  // because it reports an automatic money movement. {{refundOutcomeNote}} carries
  // the sentence that differs between a deleted and a merely cancelled booking, so
  // an override keeps both cases correct without needing conditional syntax.
  //
  // #2773: the two hard-coded sentences that said "a booking-change payment" and
  // "the supplementary Xero invoice for the change" moved into
  // {{lateCaptureLeadNote}}. BOTH late-capture handlers send this alert now, and
  // those sentences are false about a booking's OWN payment - which has no
  // supplementary invoice at all - so leaving them fixed would have shipped a
  // default body that misdescribed half the events it reports. Safe to rewrite
  // rather than frozen the way a stored note prefix is: this template is
  // introduced by the same unreleased work (#2761), so no club can be holding an
  // override of it yet.
  "admin-late-capture-auto-refund": {
    "defaultSubject": "Payment refunded automatically - booking {{bookingStateLabel}}: {{memberName}}",
    "defaultBody": "Payment Refunded Automatically\n\nA payment was captured after the booking had already been cancelled, and it has been refunded in full automatically. There is nothing to pay back.\n\n{{lateCaptureLeadNote}}\n\n{{refundOutcomeNote}}\n\nMember: {{memberName}}\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\nAmount refunded: {{amount}}\nBooking status when the payment arrived: {{bookingStateLabel}}\nBooking: {{bookingId}}\nStripe PI: {{paymentIntentId}}\n\nView Payments: {{reviewUrl}}"
  },
  // #2774: the reconciliation notice for a late capture that collided with a
  // hand-back an operator had already made. Its OWN entry rather than a flag on
  // admin-late-capture-auto-refund: on this path the money either did not go back
  // at all or went back twice, so that template's "refunded automatically, nothing
  // to pay back" heading and body would be false in both directions, and one
  // editable body cannot be correct about a refund that happened AND one that did
  // not. Delivery-locked for the same reason as its sibling, and more so - this is
  // the mail that says money may have left the club twice.
  // {{handBackConflictNote}} carries the one sentence saying which way the money
  // went, so an override stays correct on both.
  // AND {{handBackConflictLabel}} carries the same direction in the SUBJECT, which
  // is not a nicety: a stored subject override replaces the sender's computed
  // subject unconditionally, so a default subject with one direction written into it
  // would title every suspected DOUBLE payment "Automatic refund withheld" the
  // moment any admin saved this template. Same construction as its sibling's
  // {{bookingStateLabel}} (#2761), and #2774 additionally makes this one the first
  // token REQUIRED IN A SUBJECT (REQUIRED_SUBJECT_TEMPLATE_TOKENS), so an admin
  // cannot type the direction back out either.
  "admin-late-capture-hand-back-conflict": {
    "defaultSubject": "{{handBackConflictLabel}}: {{memberName}}",
    "defaultBody": "Late Capture vs Hand-Back - Reconcile By Hand\n\nA payment captured after the booking was cancelled has collided with a refund an operator had already paid back by hand.\n\n{{handBackConflictNote}}\n\nMember: {{memberName}}\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\nAmount captured: {{amount}}\nBooking: {{bookingId}}\nStripe PI: {{paymentIntentId}}\n\nView Payments: {{reviewUrl}}"
  },
  "admin-pending-deadline": {
    "defaultSubject": "{{count}} Pending Booking{{s}} Approaching Deadline",
    "defaultBody": "Pending Bookings Approaching Deadline\n\n{{count}} pending booking(s) will reach their hold deadline within 48 hours.\n\nMember | Dates | Guests | Deadline | Remaining\n{{memberName}} | {{checkIn}} – {{checkOut}} | {{guestCount}} | {{deadline}} | {{hoursRemaining}}h\n...\n\nView Bookings: {{BASE_URL}}/admin/bookings"
  },
  "admin-booking-bumped": {
    "defaultSubject": "Booking Bumped: {{bumpedMemberName}}",
    "defaultBody": "Booking Bumped\n\nA pending booking has been bumped due to a member booking.\n\nBumped Member: {{bumpedMemberName}}\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\nGuests: {{guestCount}}\nTriggered By: {{triggeringMemberName}}\n\nView Bookings: {{BASE_URL}}/admin/bookings"
  },
  "admin-capacity-warning": {
    "defaultSubject": "Capacity Warning: {{count}} high-occupancy day{{s}} ahead",
    "defaultBody": "Capacity Warning\n\n{{count}} day(s) in the next 14 days have high occupancy.\n\nDate | Occupied | Available | Occupancy\n{{date}} | {{occupiedBeds}}/{{LODGE_CAPACITY}} | {{availableBeds}} | {{percent}}%\n...\n\nView Bookings: {{BASE_URL}}/admin/bookings"
  },
  "admin-daily-digest": {
    "defaultSubject": "Admin Daily Digest - {{totalAlerts}} alert{{s}} in past 24h",
    "defaultBody": "Admin Daily Digest\n\nSummary of admin alerts from the past 24 hours.\n\nAlert Type | Count | Action\nNew Bookings | {{count}} | View\nPayment Failures | {{count}} | View\nCapacity Warnings | {{count}} | View\nBookings Bumped | {{count}} | View\nPending Deadlines | {{count}} | View\nXero Errors | {{count}} | View\n\nTotal alerts: {{totalAlerts}}\n\nOpen Admin Dashboard: {{BASE_URL}}/admin/dashboard"
  },
  "admin-xero-sync-error": {
    "defaultSubject": "Xero Sync Error — {{CLUB_BOOKINGS_NAME}}",
    "defaultBody": "Xero Sync Error\n\nA Xero integration error occurred and may require attention.\n\nError Type: {{errorType}}\nOperation: {{operation}}\nError Message: {{errorMessage}}\nTimestamp: {{timestamp}}\n\nView Xero Status: {{BASE_URL}}/admin/xero"
  },
  "admin-xero-repeated-failure": {
    "defaultSubject": "Repeated Xero Failure: {{correlationKey}}",
    "defaultBody": "Repeated Xero Failures\n\nThe same Xero sync correlation key has failed repeatedly and now needs operator attention.\n\nCorrelation Key: {{correlationKey}}\nFailures in Window: {{failureCount}} in the last {{windowHours}} hour(s)\nEntity: {{entityType}}\nOperation: {{operationType}}\n{{localRecordNote}}{{latestErrorNote}}Timestamp: {{timestamp}}\n\n{{xeroLinksNote}}Open Xero Admin: {{BASE_URL}}/admin/xero"
  },
  "admin-xero-reconciliation-report": {
    "defaultSubject": "Xero Reconciliation Report - {{issueTotalCount}} item{{s}}",
    "defaultBody": "Xero Reconciliation Report\n\nNo open reconciliation gaps were detected in this report window."
  },
  "admin-credit-sync-drift": {
    "defaultSubject": "Xero Credit Sync Drift — {{CLUB_BOOKINGS_NAME}}",
    "defaultBody": "Xero Credit Sync Drift\n\nBookingApp's known applied credit does not match Xero's live invoice allocation for one or more bookings. Each drift names the member, booking, invoice and the exact amount. Nothing has been changed automatically — review and reconcile in Xero."
  },
  "admin-refund-request": {
    "defaultSubject": "Refund Appeal: {{memberName}}",
    "defaultBody": "Refund Appeal Submitted\n\n{{memberName}} has submitted a refund appeal.\n\nMember: {{memberName}}\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\nPaid: {{paidAmount}}\nAlready Refunded: {{refundedAmount}}\nRemaining: {{remainingAmount}}\n{{requestedAmountNote}}\n{{reason}}\n\nReview Appeal: {{BASE_URL}}/admin/refund-requests"
  },
  "admin-booking-change-request": {
    "defaultSubject": "Booking Change Request: {{memberName}}",
    "defaultBody": "Booking Change Request Submitted\n\n{{memberName}} has requested an admin-reviewed booking change for a locked same-day or past-night period.\n\nMember: {{memberName}}\nEmail: {{memberEmail}}\nBooking: {{bookingId}}\nCurrent check-in: {{checkIn}}\nCurrent check-out: {{checkOut}}\nRequested change: {{requestedSummary}}\n\n{{reasonNote}}Review Request: {{reviewUrl}}"
  },
  "refund-request-approved": {
    "defaultSubject": "Refund Appeal Approved — {{CLUB_BOOKINGS_NAME}}",
    "defaultBody": "Refund Appeal Approved\n\nHi {{firstName}},\n\nYour refund appeal for your booking ({{checkIn}} - {{checkOut}}) has been approved. A refund of {{amount}} will be processed to your original payment method.\n\n{{adminNotesLine}}If you have questions, contact the club at {{SUPPORT_EMAIL}}."
  },
  "refund-request-declined": {
    "defaultSubject": "Refund Appeal Update — {{CLUB_BOOKINGS_NAME}}",
    "defaultBody": "Refund Appeal Update\n\nHi {{firstName}},\n\nYour refund appeal for your booking ({{checkIn}} - {{checkOut}}) was not approved at this time.\n\n{{adminNotesLine}}If you have questions, contact the club at {{SUPPORT_EMAIL}}."
  },
  "admin-issue-report": {
    "defaultSubject": "Issue Report: {{memberName}}",
    "defaultBody": "Issue Report Submitted\n\n{{memberName}} has reported an issue from the bookings site.\n\nMember: {{memberName}}\nEmail: {{memberEmail}}\nPage: {{pageTitle}}\nScreenshot: Available in admin OR Not included\n\n{{description}}\n\nReview Issue Report: {{issueReportUrl}}\n\nOpen Reported Page: {{pageUrl}}"
  },
  "bulk-communication": {
    "defaultSubject": "{{adminEnteredSubject}}",
    "defaultBody": "{{adminEnteredSubject}}\n\n{{adminEnteredBody}}\n\nThis email was sent to you by the {{CLUB_NAME}} administration. You can update your email preferences in your account settings.\n\nManage Preferences: {{BASE_URL}}/profile"
  },
  "notice-published": {
    "defaultSubject": "New notice: {{noticeTitle}}",
    "defaultBody": "Hi {{firstName}},\n\nThe {{CLUB_NAME}} committee has posted a new notice: {{noticeTitle}}\n\nRead it here: {{noticeUrl}}\n\nYou can update your email preferences in your account settings.\n\nManage Preferences: {{BASE_URL}}/profile"
  },
  "website-contact": {
    "defaultSubject": "Website Contact{{recipientLabel}}: {{name}}",
    "defaultBody": "New Contact Form Submission\n\nName: {{name}}\nEmail: {{email}}\nMessage: {{message}}"
  },
  "admin-email-failure": {
    "defaultSubject": "Email delivery permanently failed",
    "defaultBody": "Email to {{originalRecipient}} (template: {{originalTemplateName}}) has failed after {{attemptCount}} attempts and will not be retried."
  },
  "booking-request-verification": {
    "defaultSubject": "Confirm your booking request — {{CLUB_NAME}}",
    "defaultBody": "Confirm Your Booking Request\n\nHi {{firstName}}, thanks for your booking request with {{CLUB_NAME}}.\n\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\nGuests: {{guestCount}}\n\nPlease confirm your email address to add your request to our review queue.\n\nConfirm Request: {{BASE_URL}}/booking-requests/verify/{{token}}\n\nThis link expires on {{expiresAt}}. If you did not submit this request, please ignore this email."
  },
  "booking-request-approved": {
    "defaultSubject": "Your booking request has been approved — {{CLUB_NAME}}",
    "defaultBody": "Booking Request Approved\n\nHi {{firstName}}, great news — your booking request has been approved!\n\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\nGuests: {{guestCount}}\nTotal: {{price}}\nBooking reference: {{bookingReference}}\n\nPlease complete payment to confirm your booking.\n\nPay Now: {{BASE_URL}}/pay/{{token}}\n\nThis payment link expires on {{expiresAt}}. If it expires before you pay, please contact the club to request a new link."
  },
  "split-guest-payment-link": {
    "defaultSubject": "Pay for your guests to confirm their place — {{CLUB_NAME}}",
    "defaultBody": "Pay for Your Guests to Confirm Their Place\n\nHi {{firstName}}, your own place is confirmed, but your non-member guests still need to be paid for before we can hold beds for them. There is no card on file for this part of your booking, so please use the secure link below to pay for your guests.\n\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\nGuests: {{guestCount}}\nAmount due: {{price}}\n\nPay for My Guests: {{BASE_URL}}/pay/{{token}}\n\nUntil payment is received, no beds are held for your guests and their place may be bumped if the lodge fills for these dates.\n\nThis payment link expires on {{expiresAt}}. If you have any questions, just reply to this email or contact the club."
  },
  "booking-request-quote": {
    "defaultSubject": "Your booking quote is ready — {{CLUB_NAME}}",
    "defaultBody": "Booking Quote Ready\n\nHi {{firstName}}, the club has prepared a quote for your lodge request.\n\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\nGuests: {{guestCount}}\n\n{{quoteOptions}}\n\nRespond to Quote: {{BASE_URL}}/booking-requests/respond/{{token}}\n\nThis quote link expires on {{expiresAt}}. You can use it to accept, cancel, request changes, or send a question."
  },
  "booking-request-declined": {
    "defaultSubject": "Update on your booking request — {{CLUB_NAME}}",
    "defaultBody": "Booking Request Update\n\nHi {{firstName}}, thank you for your interest in staying with {{CLUB_NAME}}.\n\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\n\nUnfortunately we're unable to accommodate this request.\n\n{{reasonNote}}If you have any questions, please contact the club at {{SUPPORT_EMAIL}}."
  },
  "booking-request-payment-expired": {
    "defaultSubject": "Your booking was released — payment not received — {{CLUB_NAME}}",
    "defaultBody": "Your Booking Was Released — Payment Not Received\n\nHi {{firstName}}, the booking we approved from your request stayed unpaid up to the check-in day, so it has now been released. Nothing was ever charged.\n\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\n\nIf you still want to stay, you are welcome to submit a new booking request for these or other dates.\n\nIf you have any questions, contact the club at {{SUPPORT_EMAIL}}."
  },
  "admin-booking-request-pending": {
    "defaultSubject": "Booking request ready for review: {{requesterName}}",
    "defaultBody": "Booking Request Ready for Review\n\n{{requesterName}} has verified their email and the request is ready for pricing.\n\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\nGuests: {{guestCount}}\n\nReview Request: {{reviewUrl}}"
  },
  "admin-booking-request-hold-expired": {
    "defaultSubject": "Request booking unpaid at hold expiry: {{requesterName}}",
    "defaultBody": "Request Booking Unpaid at Hold Expiry\n\n{{requesterName}}'s request-origin booking has reached its hold deadline without payment.\n\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\nGuests: {{guestCount}}\nTotal due: {{total}}\nHold until: {{holdUntil}}\n\nThis alert repeats on a capped cadence (the first three hold extensions, then every seventh) while the request booking stays unpaid. A terminal cancellation past the check-in day ends the series with a separate final notice.\n\nReview Bookings: {{reviewUrl}}"
  },
  "admin-booking-request-hold-cancelled": {
    "defaultSubject": "Request booking auto-cancelled — unpaid past check-in: {{requesterName}}",
    "defaultBody": "Request Booking Auto-Cancelled — Unpaid Past Check-in\n\n{{requesterName}}'s booking from a public booking request was still unpaid at the end of its check-in day, with no saved card to charge, so it was automatically cancelled and the beds it was holding have been released. No payment was taken. The requester has been notified.\n\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\nGuests: {{guestCount}}\nAmount (unpaid): {{total}}\n\nNo further action is required. If the requester still intends to come and pay, ask them to submit a new booking request.\n\nThis is a one-off notice — it ends the capped hold-extension alert series for this request booking.\n\nView Bookings: {{reviewUrl}}"
  },
  "admin-split-settlement-unpaid": {
    "defaultSubject": "Split booking guest portion unpaid — no card on file: {{memberName}}",
    "defaultBody": "Split Booking Guest Portion Unpaid — No Card on File\n\n{{settlementActionNote}}\n\nMember: {{memberName}}\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\nGuests: {{guestCount}}\nAmount due: {{total}}\nHold extended to: {{holdUntil}}\n\nNo beds are held for these guests until payment is received. Follow up with the member or cancel the guest portion if payment is not expected.\n\nThis alert repeats on a capped cadence (the first three hold extensions, then every seventh) while the guest portion stays unpaid. A terminal cancellation past the check-in day ends the series with a separate final notice.\n\nView Bookings: {{reviewUrl}}"
  },
  "admin-split-settlement-cancelled": {
    "defaultSubject": "Split booking guest portion auto-cancelled — unpaid past check-in: {{memberName}}",
    "defaultBody": "Split Booking Guest Portion Auto-Cancelled — Unpaid Past Check-in\n\n{{settlementActionNote}}\n\nMember: {{memberName}}\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\nGuests: {{guestCount}}\nAmount (unpaid): {{total}}\n\nNo further action is required for the guest portion. If these guests are in fact coming and the member intends to pay, create a new booking for them.\n\nThis is a one-off notice — it ends the capped hold-extension alert series for this guest portion.\n\nView Bookings: {{reviewUrl}}"
  },
  "split-guest-portion-cancelled": {
    "defaultSubject": "Your guests' provisional place was cancelled — {{CLUB_NAME}}",
    "defaultBody": "Your Guests' Provisional Place Was Cancelled\n\nHi {{firstName}}, the provisional place we were holding for your non-member guests stayed unpaid up to the check-in day, so it has now been automatically cancelled. Nothing was ever charged for it, and no beds were held.\n\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\n{{bookingReferenceNote}}\n{{ownBookingNote}}\n\nIf your guests are still coming, you can make a new booking for them at any time.\n\nMake a New Booking: {{BASE_URL}}/book"
  },
  "booking-review-approved": {
    "defaultSubject": "Your booking has been approved - {{CLUB_LODGE_NAME}}",
    "defaultBody": "Booking Approved\n\nHi {{firstName}}, an admin has approved your booking. You can now complete payment to confirm it.\n\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\n\n{{adminNotesLine}}Complete Payment: {{BASE_URL}}/bookings/{{bookingId}}"
  },
  "booking-review-rejected": {
    "defaultSubject": "Your booking could not be approved - {{CLUB_LODGE_NAME}}",
    "defaultBody": "Booking Declined\n\nHi {{firstName}}, an admin has reviewed your booking and was not able to approve it. The booking has been cancelled — no payment was taken.\n\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\n\n{{adminNotesLine}}You are welcome to make a new booking that includes an adult guest, or contact the club to discuss.\n\nMake a New Booking: {{BASE_URL}}/book"
  },
  "induction-sign-off-request": {
    "defaultSubject": "Lodge induction sign-off for {{inducteeName}} — {{CLUB_NAME}}",
    "defaultBody": "Lodge Induction Sign-Off Request\n\nHi {{signerName}},\n\n{{inducteeName}} needs their {{CLUB_NAME}} lodge induction signed off, and you can do this as their {{signerRoleLabel}}.\n\nOnce you have taken them through the lodge induction checklist and you are satisfied they are competent, please sign in and confirm the sign-off on your induction page.\n\nYou will need to sign in before you can complete the sign-off.\n\nOpen My Induction Page: {{inductionUrl}}"
  },
  "school-attendee-confirmation": {
    "defaultSubject": "Confirm your attendee list — {{CLUB_NAME}}",
    "defaultBody": "Confirm Your Attendee List\n\nHi {{firstName}}, {{schoolName}}'s stay at {{CLUB_NAME}}'s lodge is coming up, and the booking currently lists placeholder attendee names. Please tell us who is coming so the lodge roster shows real names on arrival.\n\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\nAttendees: {{guestCount}}\n\nUse the secure link below to update the names and confirm the list. You can come back and edit until you confirm; the link stays valid until check-in.\n\nConfirm Attendees: {{BASE_URL}}/school-bookings/confirm/{{token}}\n\nNeed to change how many people are coming, or their age groups? Contact the club instead — headcount changes go through a revised quote.\n\nIf you have any questions, contact the club at {{SUPPORT_EMAIL}}."
  },
  "whole-lodge-guest-names-reminder": {
    "defaultSubject": "Who is coming with you? — {{CLUB_NAME}}",
    "defaultBody": "Who Is Coming With You?\n\nHi {{firstName}}, your whole-lodge booking at {{CLUB_NAME}}'s lodge is coming up and some of your party are still listed as placeholders rather than by name.\n\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\nGuests: {{guestCount}}\nStill unnamed: {{unnamedGuestCount}}\n\n{{namingUrgencyNote}}\n\nYou can update the names yourself from your booking. Changing a name does not change anybody's age group or what the stay costs — to change how many people are coming, or their age groups, contact the club.\n\nIf you have any questions, contact the club at {{SUPPORT_EMAIL}}."
  },
  "admin-school-manual-invoice": {
    "defaultSubject": "School booking needs a manual invoice: {{schoolName}}",
    "defaultBody": "School Booking Needs a Manual Invoice\n\nA school group booking has been approved and confirmed. The Xero module is currently off, so no invoice was raised automatically. Please invoice the school manually and record payment through the usual paths.\n\nSchool: {{schoolName}}\nContact email: {{contactEmail}}\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\nGuests: {{guestCount}}\nAmount: {{amount}}\n\nView Booking Requests: {{reviewUrl}}"
  },
  "admin-whole-lodge-manual-invoice": {
    "defaultSubject": "Whole-lodge booking needs a manual invoice: {{memberName}}",
    "defaultBody": "Whole-Lodge Booking Needs a Manual Invoice\n\nA member's whole-lodge request has been approved and the booking is confirmed with the whole lodge held for their group. The Xero module is currently off, so no invoice was raised automatically. Please invoice the member manually and record the payment through the usual paths.\n\nMember: {{memberName}}\nContact email: {{contactEmail}}\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\nGuests: {{guestCount}}\nAmount: {{amount}}\nPayment reference: {{paymentReference}}\n\nThe member has been told the booking is confirmed, that this amount is still owing, and that the club will send them an invoice - so please send one.\n\nView Booking Requests: {{reviewUrl}}"
  },
  "group-booking-join-verification": {
    "defaultSubject": "Confirm your group booking spot — {{CLUB_NAME}}",
    "defaultBody": "Confirm Your Booking Request\n\nHi {{firstName}}, thanks for your booking request for {{CLUB_NAME}}'s lodge.\n\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\nGuests: {{guestCount}}\n\nPlease confirm your email address so the club can review your request. Your request will not be reviewed until you confirm.\n\nConfirm My Email: {{BASE_URL}}/join/verify/{{token}}\n\nThis link expires on {{expiresAt}}. If you did not make this request, you can safely ignore this email and the request will be deleted."
  },
  "group-settlement-receipt": {
    "defaultSubject": "Your group booking is settled — {{CLUB_NAME}}",
    "defaultBody": "Your Group Booking Is Settled\n\nHi {{firstName}}, thanks for settling your group's stay at {{CLUB_NAME}}'s lodge. Everyone you are paying for is now confirmed.\n\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\nJoiners settled: {{joinerCount}}\nTotal paid: {{total}}\n\nEach joiner has been emailed to confirm their spot. There is nothing more for them to pay.\n\nIf anything looks wrong, contact the club at {{SUPPORT_EMAIL}}."
  },
  "group-join-settled": {
    "defaultSubject": "Your spot is confirmed — {{CLUB_NAME}}",
    "defaultBody": "Your Spot Is Confirmed\n\nHi {{firstName}}, {{organiserName}} has settled the cost of your stay at {{CLUB_NAME}}'s lodge as part of their group booking. Your spot is confirmed and there is nothing for you to pay.\n\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\nGuests: {{guestCount}}\n\nIf you have any questions about your stay, contact the club at {{SUPPORT_EMAIL}}."
  },
  "group-settlement-expired": {
    "defaultSubject": "Your group payment expired — {{CLUB_NAME}}",
    "defaultBody": "Your Group Settlement Has Expired\n\nHi {{firstName}}, the combined payment you started for your group's stay at {{CLUB_NAME}}'s lodge was not completed in time, so the beds held for your joiners have been released.\n\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\nJoiners affected: {{joinerCount}}\nAmount not charged: {{total}}\n\nNo money has been taken. If your group still plans to come, restart the payment from your group booking page — the beds are subject to availability.\n\nIf anything looks wrong, contact the club at {{SUPPORT_EMAIL}}."
  },
  "group-join-released": {
    "defaultSubject": "Your held spot has been released — {{CLUB_NAME}}",
    "defaultBody": "Your Held Spot Has Been Released\n\nHi {{firstName}}, {{organiserName}} started a combined payment for your stay at {{CLUB_NAME}}'s lodge but it was not completed in time, so your held bed has been released.\n\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\n\nYour booking is back to awaiting payment. If the group still plans to come, the organiser can restart the payment — or check with them about what happens next.\n\nIf you have any questions, contact the club at {{SUPPORT_EMAIL}}."
  },
  "group-join-cancelled": {
    "defaultSubject": "Your group booking has been cancelled — {{CLUB_NAME}}",
    "defaultBody": "Your Group Booking Has Been Cancelled\n\nHi {{firstName}}, the combined group payment {{organiserName}} started for your stay at {{CLUB_NAME}}'s lodge was never completed, so your pending booking has now been cancelled. Nothing has been charged to you.\n\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\n\nIf you still want to come, you can make your own booking for these dates — or talk to the organiser about starting a fresh group trip.\n\nIf you have any questions, contact the club at {{SUPPORT_EMAIL}}."
  },
  "membership-payment-recorded": {
    "defaultSubject": "Your {{seasonYear}} membership payment has been recorded — {{CLUB_NAME}}",
    "defaultBody": "Membership Payment Recorded\n\nHi {{firstName}}, thank you — {{CLUB_NAME}} has recorded your membership subscription payment for the {{seasonYear}} season.\n\nSeason: {{seasonYear}}\n{{amountRecordedNote}}Date recorded: {{date}}\n\nYour membership is now marked paid for the season, so there is nothing further for you to pay.\n\nIf anything looks wrong, contact the club at {{SUPPORT_EMAIL}}."
  },
  "member-guest-consent-request": {
    "defaultSubject": "{{askHeading}}",
    "defaultBody": "{{askHeading}}\n\nHi {{firstName}}, {{askContextNote}}\n\nLodge: {{CLUB_LODGE_NAME}}\nStay: {{checkIn}} - {{checkOut}}\nNights: {{guestNightsLabel}}\nBooked by: {{bookerName}}\nPlease answer by: {{consentExpiresAt}}\n\n{{partyListNote}}\n\nIf you do not answer by {{consentExpiresAt}}, the request lapses on its own and {{bookerName}} is told. You do not have to do anything to decline. In most cases the held bed is released at the same time; occasionally it cannot be - when there would be nobody left on the booking, for example - and the club sorts that out by hand.\n\nAnswer this request: {{consentUrl}}\n\nIf you were not expecting this, you can safely ignore it - the place is only confirmed if somebody answers yes."
  },
  "member-guest-added": {
    "defaultSubject": "{{addedHeading}} - {{CLUB_LODGE_NAME}}",
    "defaultBody": "{{addedHeading}}\n\nHi {{firstName}}, {{addedContextNote}}\n\nLodge: {{CLUB_LODGE_NAME}}\nStay: {{checkIn}} - {{checkOut}}\nNights: {{guestNightsLabel}}\n\n{{partyListNote}}\n\n{{removalNote}}\n\nView this booking: {{BASE_URL}}/bookings"
  },
  "family-member-added": {
    "defaultSubject": "{{addedHeading}} - {{CLUB_LODGE_NAME}}",
    "defaultBody": "{{addedHeading}}\n\nHi {{firstName}}, {{addedContextNote}}\n\nLodge: {{CLUB_LODGE_NAME}}\nStay: {{checkIn}} - {{checkOut}}\n\n{{removalNote}}\n\nView this booking: {{BASE_URL}}/bookings"
  },
  "member-guest-consent-outcome": {
    "defaultSubject": "{{outcomeHeading}} - {{CLUB_LODGE_NAME}}",
    "defaultBody": "{{outcomeHeading}}\n\nHi {{firstName}}, {{outcomeSentence}}\n\n{{consequenceNote}}\n\nView this booking: {{BASE_URL}}/bookings/{{bookingId}}"
  },
  "member-guest-consent-answered": {
    "defaultSubject": "{{answeredHeading}} - {{CLUB_LODGE_NAME}}",
    "defaultBody": "{{answeredHeading}}\n\nHi {{firstName}}, {{answeredSentence}}\n\n{{answeredNote}}"
  },
  "member-guest-request-withdrawn": {
    "defaultSubject": "{{withdrawnHeading}} - {{CLUB_LODGE_NAME}}",
    "defaultBody": "{{withdrawnHeading}}\n\nHi {{firstName}}, {{withdrawnContextNote}}\n\nLodge: {{CLUB_LODGE_NAME}}\nStay: {{checkIn}} - {{checkOut}}\n\nYou do not need to do anything. If you think this is a mistake, contact the club at {{SUPPORT_EMAIL}}.\n\nThe link in the earlier email no longer works. If plans change, you can be added to a booking again later."
  },
  "member-guest-consent-expired": {
    "defaultSubject": "The request to add you to a lodge booking has lapsed",
    "defaultBody": "That request has lapsed\n\nHi {{firstName}}, the request from {{bookerName}} to add you to a booking at {{CLUB_LODGE_NAME}} on {{checkIn}} - {{checkOut}} has lapsed, and the bed that was held for you has been released.\n\nYou do not need to do anything. If you did want to come, ask {{bookerName}} to add you again."
  },
  "hosting-coverage-lost": {
    "defaultSubject": "Your booking needs adult member cover - {{CLUB_LODGE_NAME}}",
    "defaultBody": "Your booking needs adult member cover\n\nHi {{firstName}}, a change elsewhere means your booking at {{CLUB_LODGE_NAME}} no longer has a qualifying adult member staying on every night your non-member guests are there.\n\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\nNights needing cover: {{uncoveredNights}}\n\nYour booking has not been cancelled and your beds and payments are unchanged. A Booking Officer has been notified and will be in touch.\n\nYou can fix it yourself by adding adult member cover for those nights, by changing the affected booking, or by asking a Booking Officer to approve an exception. If you have any questions, contact the club at {{SUPPORT_EMAIL}}."
  },
  "booking-policy-exception-refused": {
    "defaultSubject": "Your request was not approved - {{CLUB_LODGE_NAME}}",
    "defaultBody": "Your request was not approved\n\nHi {{firstName}}, a Booking Officer has looked at {{askDescription}} at {{CLUB_LODGE_NAME}} and decided not to allow it this time.\n\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\n\n{{reasonLine}}\n\nNothing was booked and nothing was changed. Any beds this request was holding have gone back into the pool.\n\nYou can ask again with different dates or a different party. Your requests are listed under My booking-rule requests on your My Bookings page.\n\nIf you would like to talk it through, contact the club at {{SUPPORT_EMAIL}}."
  },
  "policy-exception-request-expired": {
    "defaultSubject": "Your exception request has lapsed - {{CLUB_LODGE_NAME}}",
    "defaultBody": "Your exception request has lapsed\n\nHi {{firstName}}, the exception request you raised for your stay at {{CLUB_LODGE_NAME}} was not decided by {{expiresAt}}, so it has lapsed and the beds it was holding have been released.\n\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\n\nYour booking itself has not changed. Only the change you asked the club to allow has lapsed.\n\nIf you still want that change, you can raise a fresh request from your booking. If you have any questions, contact the club at {{SUPPORT_EMAIL}}."
  }
} as const;

export type EmailAuditTemplateName = keyof typeof EMAIL_AUDIT_DEFAULTS_BASE;

type EmailAuditDefaults = Record<
  EmailAuditTemplateName,
  { defaultSubject: string; defaultBody: string }
>;

function removeLegacyAuthenticatedBookingLines(body: string): string {
  return body
    .split("\n")
    .map((line) => {
      const urlIndex = line.indexOf("{{BASE_URL}}/bookings");
      if (urlIndex < 0) return line;
      // Preserve any composed optional token before the old link label. For
      // example booking-review-approved starts its action line with
      // {{adminNotesLine}}, whose independent note must remain in the default.
      return line.slice(0, urlIndex).match(/^(?:\{\{[^{}]+\}\})*/)?.[0] ?? "";
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

/**
 * Add the optional canonical booking link to every live concrete-booking
 * default. Stored overrides are separate database rows and are never rewritten;
 * an override that omits `bookingUrl` therefore remains byte-for-byte intact.
 */
export const EMAIL_AUDIT_DEFAULTS = Object.fromEntries(
  Object.entries(EMAIL_AUDIT_DEFAULTS_BASE).map(([key, defaults]) => {
    if (!BOOKING_URL_TEMPLATE_NAMES.has(key)) return [key, defaults];

    const withoutLegacyBookingLink = removeLegacyAuthenticatedBookingLines(
      defaults.defaultBody,
    );
    return [
      key,
      {
        ...defaults,
        defaultBody: `${withoutLegacyBookingLink}\n\nView this booking: {{bookingUrl}}`,
      },
    ];
  }),
) as EmailAuditDefaults;
