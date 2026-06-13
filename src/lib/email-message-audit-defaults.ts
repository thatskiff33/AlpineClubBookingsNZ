// Seeded from docs/email-message-audit.md with editor-safe default subjects.
// Keep template keys and wording aligned when the audit changes.

export const EMAIL_AUDIT_DEFAULTS = {
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
  "welcome": {
    "defaultSubject": "Welcome to {{CLUB_BOOKINGS_NAME}}",
    "defaultBody": "Welcome, {{firstName}}!\n\nYour {{CLUB_NAME}} booking account has been created successfully.\n\nYou can now log in to book stays at the lodge, manage your bookings, and view your upcoming trips.\n\nLog In to Your Account: {{BASE_URL}}/login\n\nIf you did not create this account, please ignore this email."
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
  "booking-confirmed": {
    "defaultSubject": "Booking Confirmed - {{CLUB_LODGE_NAME}}",
    "defaultBody": "Booking Confirmed\n\nHi {{firstName}}, your lodge booking has been confirmed!\n\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\nGuests: {{guestCount}}\nSubtotal: {{subtotal}}                  [only when discountCents > 0]\nDiscount ({{promoCode}}): -{{discount}} [only when promoCode exists]\nDiscount: -{{discount}}                 [only when discount exists without promoCode]\nTotal Paid: {{totalPaid}}\n\nPayment has been processed successfully.\n\nHow to get to the lodge\n\n{{CLUB_LODGE_TRAVEL_NOTE}}\n\nDoor code: {{doorCode}} [only when a door code is set]\n\nYou can view your booking details and manage your stay from your account.\n\nView Booking: {{BASE_URL}}/bookings"
  },
  "booking-pending": {
    "defaultSubject": "Booking Pending - {{CLUB_LODGE_NAME}}",
    "defaultBody": "Booking Pending\n\nHi {{firstName}}, your lodge booking has been received and is currently pending.\n\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\nGuests: {{guestCount}}\nHold Until: {{holdUntil}}\n\nYour booking includes non-member guests and will be held as pending until {{holdUntil}}.\n\nDuring this time, club members have priority. If the lodge fills up with member bookings, your booking may be bumped. Your card will only be charged when the booking is confirmed.\n\nView Booking: {{BASE_URL}}/bookings"
  },
  "booking-bumped": {
    "defaultSubject": "Booking Update - {{CLUB_LODGE_NAME}}",
    "defaultBody": "Booking Update\n\nHi {{firstName}}, unfortunately your pending lodge booking has been bumped due to member demand.\n\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\nGuests: {{guestCount}}\n\nYour card has not been charged.\n\nAs a non-member booking, priority is given to club members when the lodge reaches capacity. You're welcome to rebook for different dates where availability exists.\n\nBook Again: {{BASE_URL}}/book\n\nWe apologise for the inconvenience."
  },
  "booking-cancelled": {
    "defaultSubject": "Booking Cancelled - {{CLUB_LODGE_NAME}}",
    "defaultBody": "Booking Cancelled\n\nHi {{firstName}}, your lodge booking has been cancelled.\n\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\n\n{{refundMessage}}\n\nYou can make a new booking at any time from your account.\n\nMake a New Booking: {{BASE_URL}}/book"
  },
  "booking-modified": {
    "defaultSubject": "Booking Modified - {{CLUB_LODGE_NAME}}",
    "defaultBody": "Booking Modified\n\nHi {{firstName}}, your booking has been updated.\n\n{{modificationTypeLabel}}\n\nPrevious Dates: {{oldCheckIn}} – {{oldCheckOut}} [only when dates changed]\nNew Dates: {{newCheckIn}} – {{newCheckOut}}       [only when dates changed]\nDates: {{newCheckIn}} – {{newCheckOut}}           [when dates did not change]\nPrevious Guests: {{oldGuestCount}}                [only when guest count changed]\nNew Guests: {{newGuestCount}}                     [only when guest count changed]\nGuests: {{newGuestCount}}                         [when guest count did not change]\nPrevious Total: {{oldTotal}}                      [only when total changed]\nNew Total: {{newTotal}}                           [only when total changed]\nTotal: {{newTotal}}                               [when total did not change]\nChange Fee: {{changeFee}}                         [only when changeFeeCents > 0]\n\n{{paymentNote}}\n\nAdditional payment method: {{additionalPaymentMethod}} [only when additional payment is due]\nPayment reference: {{paymentReference}}              [only when provided]\nXero invoice number: {{xeroInvoiceNumber}}           [only when provided]\n\nYou can view your updated booking details from your account.\n\nView Booking: {{BASE_URL}}/bookings"
  },
  "checkin-reminder": {
    "defaultSubject": "Check-in Reminder - {{CLUB_LODGE_NAME}}",
    "defaultBody": "Check-in Reminder\n\nHi {{firstName}}, your lodge stay begins tomorrow!\n\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\nGuests: {{guestCount}}\n\nGuest list:\n\n{{guestFirstName}} {{guestLastName}}\n...\n\nYour arrival day chores:        [only when chores exist]\n\n{{choreName}}: {{choreDescription}}\n...\n\nPlease ensure you arrive prepared for alpine conditions. Check the weather forecast before departing.\n\n{{CLUB_LODGE_TRAVEL_NOTE}}\n\nView Booking: {{BASE_URL}}/bookings"
  },
  "pre-arrival-reminder": {
    "defaultSubject": "Pre-arrival Information - {{CLUB_LODGE_NAME}}",
    "defaultBody": "Upcoming Lodge Stay\n\nHi {{firstName}}, your lodge stay is coming up.\n\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\nGuests: {{guestCount}}\nExpected arrival: {{expectedArrivalTime}} [only when provided]\n\nHow to get to the lodge\n\n{{CLUB_LODGE_TRAVEL_NOTE}}\n\nDoor code: {{doorCode}} [only when a door code is set]\n\nView Booking: {{BASE_URL}}/bookings"
  },
  "chore-roster": {
    "defaultSubject": "Your chore roster for {{formattedDate}} - {{CLUB_LODGE_NAME}}",
    "defaultBody": "Chore Roster\n\nHi {{guestName}},\n\nHere are your assigned chores for {{formattedDate}} at the lodge:\n\n{{choreName}}: {{choreDescription}}\n...\n\nMark Chores Complete: {{choreLink}} [only when choreLink exists]\n\nUse this link to mark your chores as done from your phone. Link expires in 48 hours. [only when choreLink exists]\n\nLast person to bed: Check heaters and fire are safe and doors are secure.\n\nThanks for helping keep the lodge running smoothly!"
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
    "defaultBody": "A Spot Has Opened Up!\n\nHi {{firstName}}, great news — a spot has become available for your waitlisted booking.\n\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\nGuests: {{guestCount}}\n\nThis offer expires on {{expiresAt}}. If you don't confirm in time, the spot will be offered to the next person in line.\n\nConfirm Booking: {{BASE_URL}}/bookings/{{bookingId}}\n\nIf you no longer need this booking, you can decline from your booking page."
  },
  "waitlist-offer-expired": {
    "defaultSubject": "Waitlist Offer Expired - {{CLUB_LODGE_NAME}}",
    "defaultBody": "Waitlist Offer Expired\n\nHi {{firstName}}, your waitlist offer for the dates below has expired.\n\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\nNew Position: #{{position}}\n\nYou've been returned to the waitlist. We'll notify you again if another spot opens up.\n\nView Booking: {{BASE_URL}}/bookings"
  },
  "admin-waitlist-offer": {
    "defaultSubject": "Waitlist Offer: {{memberName}}",
    "defaultBody": "Waitlist Offer Made\n\nA waitlist offer has been sent to {{memberName}}.\n\nMember: {{memberName}}\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\nGuests: {{guestCount}}\nQueue Position: #{{position}}\n\nThe member has 48 hours to confirm their booking.\n\nView Waitlist: {{BASE_URL}}/admin/waitlist"
  },
  "nomination-request": {
    "defaultSubject": "Nomination request for {{applicantName}} — {{CLUB_NAME}}",
    "defaultBody": "Membership Nomination Request\n\nHi {{nominatorName}},\n\n{{applicantName}} has listed you as one of their {{CLUB_NAME}} nominators.\n\nThis application also includes {{familyMemberCount}} dependent family member(s). [only when familyMemberCount > 0]\n\nPlease review the application and confirm whether you agree to nominate this person for membership.\n\nYou will need to sign in before you can confirm the nomination.\n\nReview Application: {{BASE_URL}}/nominations/{{token}}\n\nThis link expires on {{expiresAt}}."
  },
  "admin-membership-application-pending": {
    "defaultSubject": "Membership application ready: {{applicantName}}",
    "defaultBody": "Membership Application Ready for Review\n\nBoth nominators have now confirmed a new membership application.\n\nApplicant: {{applicantName}}\nEmail: {{applicantEmail}}\n\nThis application includes {{familyMemberCount}} dependent family member(s). [only when familyMemberCount > 0]\n\nReview Application: {{BASE_URL}}/admin/member-applications\n\n{{CLUB_NAME}} — {{SUPPORT_EMAIL}}"
  },
  "membership-application-approved": {
    "defaultSubject": "Your {{CLUB_NAME}} membership has been approved",
    "defaultBody": "Membership Approved\n\nHi {{firstName}}, your {{CLUB_NAME}} membership application has been approved.\n\nYour account is ready. Use the button below to set your password and access the bookings system.\n\nSet Up My Account: {{BASE_URL}}/reset-password?token={{token}}\n\nCommittee note: {{adminNotes}} [only when adminNotes exists]\n\nYour entrance fee and any membership charges will be managed separately through the club's normal process.\n\nThis setup link expires in 7 days."
  },
  "membership-application-rejected": {
    "defaultSubject": "Update on your {{CLUB_NAME}} membership application",
    "defaultBody": "Membership Application Update\n\nHi {{firstName}}, your {{CLUB_NAME}} membership application has been reviewed.\n\nThe committee has decided not to approve the application at this time.\n\nCommittee note: {{adminNotes}} [only when adminNotes exists]\n\nIf you would like more information, please contact the club directly.\n\n{{CLUB_NAME}} — {{SUPPORT_EMAIL}}"
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
    "defaultBody": "Infant/Child/Youth Request Update\n\nHi {{parentName}},\n\nYour request to add {{childName}} to your family group was not approved.\n\nAdmin note: {{reason}} [only when reason exists]\n\nIf you have questions, please contact the club.\n\n{{CLUB_NAME}} — {{SUPPORT_EMAIL}}"
  },
  "admin-family-group-request": {
    "defaultSubject": "Family Group Request: {{requesterName}} ({{requestType}})",
    "defaultBody": "Family Group Request\n\nA new {{requestType}} request has been submitted.\n\nRequester: {{requesterName}}\n\nGroup: {{groupName}}\n\n{{details}}\n\nReview Requests: {{BASE_URL}}/admin/family-groups\n\n{{CLUB_NAME}} — {{SUPPORT_EMAIL}}"
  },
  "join-request-confirmation": {
    "defaultSubject": "Join request submitted — {{CLUB_BOOKINGS_NAME}}",
    "defaultBody": "Join Request Submitted\n\nHi {{requesterName}},\n\nYour request to join the family group {{groupName}} has been submitted.\n\nAn administrator will review your request. You'll be notified once it's been processed.\n\n{{CLUB_NAME}} — {{SUPPORT_EMAIL}}"
  },
  "membership-cancellation-submitted": {
    "defaultSubject": "Membership cancellation request submitted — {{CLUB_BOOKINGS_NAME}}",
    "defaultBody": "Membership Cancellation Request Submitted\n\nHi {{firstName}},\n\nYour membership cancellation request has been submitted for admin review.\n\nIncluded memberships: {{participantSummary}}\n\nReason: {{reason}} [only when reason exists]\n\nMemberships remain active until an administrator approves the request. Any included login-capable adult must confirm before an administrator can process their cancellation.\n\nView Request: {{reviewUrl}}\n\n{{CLUB_NAME}} — {{SUPPORT_EMAIL}}"
  },
  "membership-cancellation-confirmation": {
    "defaultSubject": "Confirm membership cancellation request — {{CLUB_BOOKINGS_NAME}}",
    "defaultBody": "Confirm Membership Cancellation\n\nHi {{firstName}},\n\n{{requesterName}} has included {{participantName}} in a membership cancellation request.\n\nYour membership will remain active unless you sign in and confirm that you want to be included. This confirmation does not approve or process the cancellation; an administrator still needs to review the request.\n\nPaid subscriptions are non-refundable if an administrator approves the cancellation. Any unpaid or overdue subscription invoice will be cancelled with a Xero credit note.\n\nReview Cancellation Request: {{BASE_URL}}/membership-cancellation/{{token}}\n\nThis link expires on {{expiresAt}}.\n\nIf you do not want to be included, use the link and choose Decline. If you were not expecting this request, you can ignore this email or contact the club."
  },
  "membership-cancellation-approved": {
    "defaultSubject": "Membership cancellation approved — {{CLUB_BOOKINGS_NAME}}",
    "defaultBody": "Membership Cancellation Approved\n\nHi {{firstName}},\n\nThe membership cancellation for {{participantName}} has been approved and processed.\n\nRequest reason: {{reason}} [only when reason exists]\n\nThis membership is now inactive and the booking login has been disabled. Booking, payment, and audit history has been retained.\n\nIf this membership had an unpaid or overdue subscription invoice, that invoice has been cancelled with a Xero credit note. Paid subscriptions will not be refunded; thank you for being a member of {{CLUB_NAME}}.\n\nAdmin note: {{adminNote}} [only when adminNote exists]\n\n{{rejoinProcessText}} [only when rejoinProcessText exists]\n\n{{CLUB_NAME}} — {{SUPPORT_EMAIL}}"
  },
  "membership-cancellation-rejected": {
    "defaultSubject": "Membership cancellation update — {{CLUB_BOOKINGS_NAME}}",
    "defaultBody": "Membership Cancellation Request Update\n\nHi {{firstName}},\n\nThe membership cancellation request for {{participantName}} was not approved at this time.\n\nRequest reason: {{reason}} [only when reason exists]\n\nAdmin note: {{adminNote}} [only when adminNote exists]\n\nThis membership remains active.\n\n{{CLUB_NAME}} — {{SUPPORT_EMAIL}}"
  },
  "admin-membership-cancellation-request": {
    "defaultSubject": "Membership cancellation ready: {{requesterName}}",
    "defaultBody": "Membership Cancellation Ready for Review\n\n{{requesterName}} submitted a membership cancellation request with at least one participant ready for admin review.\n\nRequester: {{requesterName}}\nIncluded memberships: {{participantSummary}}\n\nReason: {{reason}} [only when reason exists]\n\nReview Cancellation Requests: {{reviewUrl}}\n\n{{CLUB_NAME}} — {{SUPPORT_EMAIL}}"
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
    "defaultBody": "Account Deletion Request Update\n\nHi {{firstName}},\n\nYour account deletion request has been reviewed and was not approved at this time.\n\nAdmin note: {{adminNote}} [only when adminNote exists]\n\nIf you have questions about this decision, please contact the club directly.\n\n{{CLUB_NAME}} — {{SUPPORT_EMAIL}}"
  },
  "admin-member-archive-requested": {
    "defaultSubject": "Member archive requested: {{memberName}}",
    "defaultBody": "Member Archive Requested\n\n{{requesterName}} requested archive review for {{memberName}}.\n\nMember: {{memberName}}\nRequested by: {{requesterName}}\n\nReason:\n{{reason}}\n\nReview Archive Requests: {{reviewUrl}}\n\n{{CLUB_NAME}} — {{SUPPORT_EMAIL}}"
  },
  "member-archive-approved": {
    "defaultSubject": "Membership archive completed — {{CLUB_BOOKINGS_NAME}}",
    "defaultBody": "Membership Archive Completed\n\nHi {{firstName}},\n\nYour cancelled membership record has been archived.\n\nReason:\n{{reason}}\n\nReview note: {{reviewNote}} [only when reviewNote exists]\n\nArchive preserves booking, payment, Xero, and audit history while removing the record from default operational lists.\n\n{{CLUB_NAME}} — {{SUPPORT_EMAIL}}"
  },
  "member-archive-rejected": {
    "defaultSubject": "Membership archive request update — {{CLUB_BOOKINGS_NAME}}",
    "defaultBody": "Membership Archive Request Update\n\nHi {{firstName}},\n\nThe archive request for your cancelled membership was not approved at this time.\n\nReason:\n{{reason}}\n\nReview note: {{reviewNote}} [only when reviewNote exists]\n\n{{CLUB_NAME}} — {{SUPPORT_EMAIL}}"
  },
  "admin-member-delete-requested": {
    "defaultSubject": "Member delete requested: {{memberName}}",
    "defaultBody": "Member Delete Requested\n\n{{requesterName}} requested hard-delete review for {{memberName}}.\n\nHard delete is only for records added in error with no meaningful booking, financial, lodge, Xero, or audit history.\n\nMember: {{memberName}}\nRequested by: {{requesterName}}\n\nReason:\n{{reason}}\n\nReview Member: {{reviewUrl}}\n\n{{CLUB_NAME}} — {{SUPPORT_EMAIL}}"
  },
  "admin-member-delete-approved": {
    "defaultSubject": "Member delete approved: {{memberName}}",
    "defaultBody": "Member Delete Approved\n\nHi {{requesterName}},\n\nThe hard-delete request for {{memberName}} was approved and processed.\n\nReason:\n{{reason}}\n\nReview note: {{reviewNote}} [only when reviewNote exists]\n\nA request snapshot was retained before the member record was deleted.\n\n{{CLUB_NAME}} — {{SUPPORT_EMAIL}}"
  },
  "admin-member-delete-rejected": {
    "defaultSubject": "Member delete rejected: {{memberName}}",
    "defaultBody": "Member Delete Request Rejected\n\nHi {{requesterName}},\n\nThe hard-delete request for {{memberName}} was not approved.\n\nReason:\n{{reason}}\n\nReview note: {{reviewNote}} [only when reviewNote exists]\n\nOpen Member: {{reviewUrl}}\n\n{{CLUB_NAME}} — {{SUPPORT_EMAIL}}"
  },
  "admin-new-booking": {
    "defaultSubject": "New Booking: {{memberName}} ({{status}})",
    "defaultBody": "New Booking Created\n\nA new booking has been created.\n\n{{reviewReason}} [only when reviewReason exists]\n\nMember: {{memberName}}\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\nGuests: {{guestCount}}\nTotal: {{total}}\nStatus: {{status}}\n\nView Bookings: {{BASE_URL}}/admin/bookings"
  },
  "admin-payment-failure": {
    "defaultSubject": "Payment Failed — {{CLUB_BOOKINGS_NAME}}",
    "defaultBody": "Payment Failed\n\nA payment has failed and may require manual attention.\n\nMember: {{memberName}}\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\nAmount: {{amount}}\nError: {{errorMessage}}\nStripe PI: {{paymentIntentId}}\n\nView Payments: {{BASE_URL}}/admin/payments"
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
    "defaultBody": "Repeated Xero Failures\n\nThe same Xero sync correlation key has failed repeatedly and now needs operator attention.\n\nCorrelation Key: {{correlationKey}}\nFailures in Window: {{failureCount}} in the last {{windowHours}} hour(s)\nEntity: {{entityType}}\nOperation: {{operationType}}\nLocal Record: {{localModel}} {{localId}} OR Unavailable\nLatest Error: {{latestErrorMessage}} OR Unavailable\nTimestamp: {{timestamp}}\n\nOpen local record [only when localUrl exists]\nOpen Xero object [only when xeroObjectUrl exists]\n\nOpen Xero Admin: {{BASE_URL}}/admin/xero"
  },
  "admin-xero-reconciliation-report": {
    "defaultSubject": "Xero Reconciliation Report - {{issueTotalCount}} item{{s}}",
    "defaultBody": "Xero Reconciliation Report\n\nNo open reconciliation gaps were detected in this report window."
  },
  "admin-refund-request": {
    "defaultSubject": "Refund Appeal: {{memberName}}",
    "defaultBody": "Refund Appeal Submitted\n\n{{memberName}} has submitted a refund appeal.\n\nMember: {{memberName}}\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\nPaid: ${{paidAmount}}\nAlready Refunded: ${{refundedAmount}}\nRemaining: ${{remainingAmount}}\nRequested: ${{requestedAmount}} [only when requestedAmountCents is truthy]\n\n{{reason}}\n\nReview Appeal: {{BASE_URL}}/admin/refund-requests"
  },
  "admin-booking-change-request": {
    "defaultSubject": "Booking Change Request: {{memberName}}",
    "defaultBody": "Booking Change Request Submitted\n\n{{memberName}} has requested an admin-reviewed booking change for a locked same-day or past-night period.\n\nMember: {{memberName}}\nEmail: {{memberEmail}}\nBooking: {{bookingId}}\nCurrent check-in: {{checkIn}}\nCurrent check-out: {{checkOut}}\nRequested change: {{requestedSummary}}\n\nReason: {{reason}} [only when reason exists]\n\nReview Request: {{reviewUrl}}"
  },
  "refund-request-resolved": {
    "defaultSubject": "Refund Appeal Approved — {{CLUB_BOOKINGS_NAME}}",
    "defaultBody": "Refund Appeal Approved\n\nHi {{firstName}},\n\nYour refund appeal for your booking ({{checkIn}} - {{checkOut}}) has been approved. A refund of {{amount}} will be processed to your original payment method.\n\nNotes:\n{{adminNotes}} [only when adminNotes exists]\n\nIf you have questions, contact the club at {{SUPPORT_EMAIL}}."
  },
  "admin-issue-report": {
    "defaultSubject": "Issue Report: {{memberName}}",
    "defaultBody": "Issue Report Submitted\n\n{{memberName}} has reported an issue from the bookings site.\n\nMember: {{memberName}}\nEmail: {{memberEmail}}\nPage: {{pageTitle}}\nScreenshot: Available in admin OR Not included\n\n{{description}}\n\nReview Issue Report: {{issueReportUrl}}\n\nOpen Reported Page: {{pageUrl}}"
  },
  "bulk-communication": {
    "defaultSubject": "{{adminEnteredSubject}}",
    "defaultBody": "{{adminEnteredSubject}}\n\n{{adminEnteredBody}}\n\nThis email was sent to you by the {{CLUB_NAME}} administration. You can update your email preferences in your account settings.\n\nManage Preferences: {{BASE_URL}}/profile"
  },
  "website-contact": {
    "defaultSubject": "Website Contact{{recipientLabel}}: {{name}}",
    "defaultBody": "New Contact Form Submission\n\nName: {{name}}\nEmail: {{email}}\nMessage: {{message}}"
  },
  "admin-email-failure": {
    "defaultSubject": "Email delivery permanently failed",
    "defaultBody": "Email to {{originalRecipient}} (template: {{originalTemplateName}}) has failed after {{attemptCount}} attempts and will not be retried."
  },
  "credit-applied-to-booking": {
    "defaultSubject": "Account Credit Applied - {{CLUB_LODGE_NAME}}",
    "defaultBody": "Account Credit Applied\n\nHi {{firstName}}, account credit was applied to your booking.\n\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\nCredit applied: {{creditUsed}}\nRemaining credit: {{remainingCredit}}"
  }
} as const;

export type EmailAuditTemplateName = keyof typeof EMAIL_AUDIT_DEFAULTS;
