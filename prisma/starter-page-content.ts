// Starter editable page content shared by prisma/seed.ts and the
// 20260611101500_backfill_starter_page_content,
// 20260613090000_update_starter_home_page_content,
// 20260702090000_backfill_policy_page_content,
// 20260702120000_update_starter_faq_accordion, and
// 20260802150000_update_starter_home_guest_copy migrations. The migrations
// duplicate these values as SQL because production deploys run migrations
// without the seed; src/lib/__tests__/page-content-starter-backfill.test.ts
// keeps them in sync.
//
// The "home" hero (headerText) is now written by
// 20260802150000_update_starter_home_guest_copy (#2431), not by
// 20260613090000_update_starter_home_page_content (#716) -- #716 only supplies
// the superseded sentence that #2431's WHERE clause guards on. Changing any
// starter value here needs a NEW migration: an applied migration must never be
// edited, because Prisma records its checksum and a rewrite is migration drift
// on every database that already ran it.
//
// The privacy page is now written by
// 20261222030000_rewrite_starter_privacy_recipients (#5007), which guards on the
// bodies #4914's 20261214010000_correct_starter_privacy_retention_and_hosting
// and #4031's 20261119010000_correct_starter_privacy_audit_retention wrote.
import type { PRIVACY_RECIPIENTS } from "../src/lib/privacy-recipient-classification";

export type StarterPageContent = {
  slug: string;
  path: string;
  caption: string;
  menuTitle: string;
  title: string;
  headerText: string;
  sortOrder: number;
  contentHtml: string;
};

const POLICY_DATE_LINE =
  "Effective 1 April 2026 &mdash; Last updated 1 April 2026";

// #5007: sections 5 and 6 follow the recipient register and the club's hosting
// settings; section 10 promises a date bump. Terms is unchanged and keeps the
// shared line.
const PRIVACY_POLICY_DATE_LINE =
  "Effective 1 April 2026 &mdash; Last updated 15 November 2026";

/** Register recipients a club's privacy notice must cover when the flow is used. */
type MemberFacingRecipientId = {
  [Id in keyof typeof PRIVACY_RECIPIENTS]: (typeof PRIVACY_RECIPIENTS)[Id]["memberFacing"] extends true ? Id : never;
}[keyof typeof PRIVACY_RECIPIENTS];

// Section 5's list, one item per member-facing register entry (#5007). Keyed by
// register id, so a new member-facing recipient does not compile until the
// starter policy names it. Optional services say "Only if the club turns it on."
// Locations are never stated here: the register fixes none, and the hosting
// entry reads the club's own settings through {{data-hosting}}.
export const STARTER_PRIVACY_RECIPIENT_ITEMS: Record<MemberFacingRecipientId, string> = {
  hosting: `<li><strong>Hosting provider</strong> &mdash; Runs the System and stores its database, uploaded files and server logs, which include your personal information. {{data-hosting}}</li>`,
  backup: `<li><strong>Amazon S3 (database backups)</strong> &mdash; Compressed copies of the database, stored in Amazon S3 with restricted access. Only if the club turns it on. See <a href="https://aws.amazon.com/privacy/" target="_blank" rel="noopener noreferrer">AWS Privacy Notice</a>.</li>`,
  email: `<li><strong>Email service</strong> &mdash; Delivers the System&rsquo;s emails, so it receives your name, email address and each message, which can include booking details and sign-in links. The club uses either Amazon Simple Email Service (SES) or its own email relay. See <a href="https://aws.amazon.com/privacy/" target="_blank" rel="noopener noreferrer">AWS Privacy Notice</a>.</li>`,
  stripe: `<li><strong>Stripe</strong> &mdash; Payment processing. Stripe receives payment amounts, the payer&rsquo;s email address and booking or subscription references. Card details go from your browser directly to Stripe. See <a href="https://stripe.com/privacy" target="_blank" rel="noopener noreferrer">Stripe&rsquo;s Privacy Policy</a>.</li>`,
  xero: `<li><strong>Xero</strong> &mdash; Accounting and invoicing. Your contact details and accounting records, including invoice, payment and subscription references, are kept in step with Xero. See <a href="https://www.xero.com/about/legal/privacy/" target="_blank" rel="noopener noreferrer">Xero&rsquo;s Privacy Policy</a>.</li>`,
  google: `<li><strong>Google</strong> &mdash; Website analytics (Google Analytics 4) and Google sign-in. Analytics loads only after you accept analytics cookies and receives usage events and browser and device details, not your name or email address. If you choose to sign in with Google, Google exchanges your identity details with the System. Only if the club turns it on. See <a href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer">Google&rsquo;s Privacy Policy</a>.</li>`,
  anthropic: `<li><strong>Anthropic</strong> &mdash; The AI help assistant and AI Diagnostics. The assistant receives your questions, the conversation and the page context it is allowed to use. AI Diagnostics receives officers&rsquo; troubleshooting questions and the records they look up, which can include your personal information. Only if the club turns it on. See <a href="https://privacy.anthropic.com/" target="_blank" rel="noopener noreferrer">Anthropic&rsquo;s Privacy Policy</a>.</li>`,
  sentry: `<li><strong>Sentry</strong> &mdash; Error reporting. Sentry receives error reports and diagnostic details, filtered to reduce personal information, and, if the club also turns on session replay, masked recordings of how a page was used. Only if the club turns it on. See <a href="https://sentry.io/privacy/" target="_blank" rel="noopener noreferrer">Sentry&rsquo;s Privacy Policy</a>.</li>`,
  "breached-passwords": `<li><strong>Have I Been Pwned</strong> &mdash; Checks whether a new password has appeared in a known data breach. It receives only the first five characters of a scrambled (hashed) form of the password, never the password itself or who you are. On unless the club turns it off. See <a href="https://haveibeenpwned.com/Privacy" target="_blank" rel="noopener noreferrer">Have I Been Pwned&rsquo;s Privacy Policy</a>.</li>`,
  addy: `<li><strong>Addy</strong> &mdash; Address lookup. Addy receives the address you type while searching and the address you pick. Only if the club turns it on. See <a href="https://www.addysolutions.com/privacy-policy" target="_blank" rel="noopener noreferrer">Addy&rsquo;s Privacy Policy</a>.</li>`,
  mirotalk: `<li><strong>Video-meeting server</strong> &mdash; Video meetings, run on a meeting server the club chooses. It receives your display name and network details and, when you join a meeting, your audio and video. Only if the club turns it on.</li>`,
  servernz: `<li><strong>Alpine Central Server</strong> &mdash; Shares the club&rsquo;s lodge listings and the booking officer&rsquo;s contact details with other connected clubs. No member list is uploaded. Only if the club turns it on.</li>`,
};

const privacySharingSectionHtml = [
  `<div><h2>5. Who We Share Your Information With</h2>`,
  `<p>We share your personal information with the service providers below where necessary to operate the System. A service marked &ldquo;Only if the club turns it on&rdquo; receives nothing unless the club has switched it on.</p>`,
  `<ul>${Object.values(STARTER_PRIVACY_RECIPIENT_ITEMS).join("")}</ul>`,
  `<p>We do not sell, rent, or trade your personal information to any third party for marketing or other unrelated purposes (IPP 11 &mdash; Limits on disclosure of personal information).</p>`,
  `<p>The System does not fix the country in which any of these providers processes information; that depends on the provider and on the club&rsquo;s account with it, so your information may be processed outside New Zealand. Where we disclose information to a provider outside New Zealand, we take reasonable steps to ensure it is required to protect the information consistently with the Privacy Act 2020 (IPP 12 &mdash; Disclosure of information outside New Zealand).</p>`,
  `<p><strong>Admin note:</strong> Fill in <em>Where members&rsquo; data is held</em> under Club Identity so the hosting entry names your provider and location, and check this list against the services your club uses.</p></div>`,
].join("");

// Section 6 keeps only what the code guarantees for every club; hosting and
// backups are described once, in section 5.
const privacyStorageSectionHtml = `<div><h2>6. How We Store and Protect Your Information</h2><ul><li>Your information is stored in a PostgreSQL database run by the hosting company described in section 5.</li><li>Passwords are hashed using bcrypt before storage &mdash; we cannot see your password.</li><li>Stored credentials for connected services (such as the club&rsquo;s Xero connection) are encrypted using AES-256-GCM before storage.</li><li>All communication between your browser and our servers uses HTTPS.</li><li>We use security headers (Content Security Policy, HSTS, etc.) to protect against common web attacks.</li></ul><p>We take reasonable steps to protect your personal information from unauthorised access, disclosure, or misuse (IPP 5 &mdash; Storage and security of personal information).</p></div>`;

const privacyPolicyContentHtml = [
  `<div class="website-legal-copy">`,
  `<div><h2>1. Who We Are</h2><p>The {{club-name}} Incorporated (&ldquo;we&rdquo;, &ldquo;us&rdquo;, &ldquo;our&rdquo;) is a not-for-profit incorporated society registered in New Zealand. We operate {{lodge-name}} and this booking and membership management system (&ldquo;the System&rdquo;).</p><p>We are committed to protecting your personal information and complying with the <strong>New Zealand Privacy Act 2020</strong> and its 13 Information Privacy Principles (IPPs).</p></div>`,
  `<div><h2>2. What Information We Collect</h2><p>We collect the following categories of personal information:</p><ul><li><strong>Identity and contact details:</strong> Title, first and last name, email address, phone number, date of birth, gender, occupation, street and postal addresses.</li><li><strong>Profile and stay details:</strong> Profile photos and any dietary or allergy information you provide, including for individual stays.</li><li><strong>Account credentials:</strong> Hashed password (we never store your password in plain text), verification and sign-in records, two-factor authentication settings and secrets, and linked sign-in account identifiers.</li><li><strong>Booking information:</strong> Dates of stay, guest names and age groups, member/non-member status.</li><li><strong>Payment information:</strong> Payment status, Stripe payment reference IDs. We do <em>not</em> store full card numbers &mdash; payment card data is handled directly by Stripe.</li><li><strong>Membership information:</strong> Membership subscription status, season year, Xero invoice references, membership dates and history, family relationships, roles and lodge induction or hosting eligibility, account preferences and consent choices, and administrative notes and reasons for membership changes.</li><li><strong>Chore roster data:</strong> Chore assignments linked to your lodge stays.</li><li><strong>Communication records:</strong> Emails sent to you by the system (booking confirmations, reminders, notifications).</li><li><strong>System usage logs:</strong> IP addresses and request logs for security and troubleshooting purposes.</li></ul><p>We collect only the information necessary for managing club membership and lodge bookings (IPP 1 &mdash; Purpose of collection).</p></div>`,
  `<div><h2>3. How We Collect Information</h2><p>We collect your information:</p><ul><li>Directly from you when you register an account, make a booking, or contact us.</li><li>From Xero, our accounting platform, when we import membership and subscription information.</li><li>Automatically through the System when you log in and use the booking features.</li></ul><p>Where we collect information from you, we will tell you why we are collecting it at the point of collection (IPP 3 &mdash; Collection of information from subject).</p></div>`,
  `<div><h2>4. How We Use Your Information</h2><p>We use your personal information to:</p><ul><li>Create and manage your member account.</li><li>Process and manage lodge bookings.</li><li>Process payments and issue refunds through Stripe.</li><li>Manage membership subscriptions and invoicing through Xero.</li><li>Send you booking confirmations, reminders, and other transactional emails.</li><li>Assign chore roster duties during your lodge stays.</li><li>Maintain financial and membership records as required by law.</li><li>Ensure the security and integrity of the System.</li></ul><p>We will only use your information for the purposes for which it was collected, or for directly related purposes (IPP 10 &mdash; Limits on use of personal information).</p></div>`,
  privacySharingSectionHtml,
  privacyStorageSectionHtml,
  `<div><h2>7. How Long We Keep Your Information</h2><ul><li><strong>Active member accounts:</strong> Retained for as long as you remain a member or have an active account.</li><li><strong>Booking and payment records:</strong> Retained for 7 years as required by New Zealand tax law (Income Tax Act 2007).</li><li><strong>Email logs:</strong> {{email-log-retention}}.</li><li><strong>System audit logs</strong> (a record of who did what in the booking system, including the IP address and browser of the person acting). How long an entry is normally kept depends on its kind:<ul><li>Routine diagnostic entries: deleted after 90 days.</li><li>Records of access to sensitive information: kept for 2 years, or up to 7 years if the club keeps an audit archive.</li><li>Records of changes to accounts, bookings and payments, security events, and routine system records: kept for 7 years.</li></ul>Two rules apply to every kind: IP address and browser details are removed from entries after 90 days, and an entry kept as evidence of an incident is kept, with its IP address and browser details, for at least 10 years.</li><li><strong>Password reset and verification tokens:</strong> Automatically deleted after use or expiry (1&ndash;24 hours).</li></ul><p>We do not keep personal information for longer than is necessary for the purpose for which it was collected (IPP 9 &mdash; Retention of personal information).</p></div>`,
  `<div><h2>8. Your Rights</h2><p>Under the Privacy Act 2020, you have the right to:</p><ul><li><strong>Access your information (IPP 6):</strong> Request a copy of the personal information we hold about you. You can download your data from your <a href="/profile">Profile page</a>.</li><li><strong>Correct your information (IPP 7):</strong> Request that inaccurate information be corrected. You can update your profile details directly, or contact us for assistance.</li><li><strong>Request deletion:</strong> Request deletion of your account and personal data from your Profile page. Note that some financial records must be retained for legal compliance.</li><li><strong>Complain:</strong> If you believe we have breached the Privacy Act 2020, you may complain to us first, or directly to the <a href="https://www.privacy.org.nz/" target="_blank" rel="noopener noreferrer">Office of the Privacy Commissioner</a>.</li></ul></div>`,
  `<div><h2>9. Cookies and Tracking</h2><p>This System uses a session cookie to keep you logged in. This cookie contains an encrypted session token and no personal information. If the club enables Google Analytics, we ask for your consent before loading GA4 analytics cookies. Consent Mode starts with analytics storage denied; GA4 loads only after you accept and is used for aggregate site-use reporting, not advertising. You can decline and keep using the System. The session cookie expires after 8 hours of inactivity or when you sign out.</p><p><strong>Admin note:</strong> Review this section before enabling the Analytics module for your club.</p></div>`,
  `<div><h2>10. Changes to This Policy</h2><p>We may update this Privacy Policy from time to time. When we do, we will update the &ldquo;Last updated&rdquo; date at the top of this page. Continued use of the System after any changes constitutes acceptance of the updated policy.</p></div>`,
  `<div><h2>11. Contact Our Privacy Officer</h2><p>For any questions or concerns about this Privacy Policy, or to exercise your privacy rights, please contact our Privacy Officer:</p><div class="website-legal-callout"><p><strong>Privacy Officer</strong></p><p>{{club-name}} Incorporated</p><p>Please use our <a href="/contact">contact form</a>.</p></div></div>`,
  `</div>`,
].join("\n");

const termsOfServiceContentHtml = [
  `<div class="website-legal-copy">`,
  `<div><h2>1. Agreement to Terms</h2><p>By registering an account or using the {{club-name}} Incorporated (&ldquo;we&rdquo;, &ldquo;us&rdquo;, &ldquo;our&rdquo;) booking and membership system (&ldquo;the System&rdquo;), you agree to be bound by these Terms of Service. If you do not agree, do not use the System.</p><p>These terms apply to all users of the System, including club members, non-member guests, and any other visitors.</p></div>`,
  `<div><h2>2. Eligibility</h2><ul><li>You must be 18 years or older to create an account.</li><li>Children and youth members must be managed by a parent or guardian who holds an account.</li><li>Membership is subject to approval by the {{club-name}} committee. Creating an account does not constitute membership.</li><li>You must provide accurate and truthful information when registering. False information may result in account suspension.</li></ul></div>`,
  `<div><h2>3. Booking Rules</h2><ul><li>Lodge bookings are for accommodation at {{lodge-name}}. The lodge sleeps a maximum of {{lodge-capacity}} guests.</li><li>Bookings must be made through the System. Verbal or informal bookings are not accepted.</li><li>Members may book for themselves and invite non-member guests. The booking member must be present during the stay of any non-member guests.</li><li>The committee configures whether bookings with non-member guests use Members First priority holds or First Paid, First In payment. See Section 5 for details.</li><li>All guests must participate in the lodge chore roster. Chore assignments are allocated by the hut leader for each night.</li><li>Guests must treat the lodge, equipment, and other guests with respect. The committee reserves the right to refuse future bookings to guests who cause damage or behave inappropriately.</li><li>The lodge is a shared facility. Quiet hours are from 10pm to 7am. Alcohol consumption must be responsible and is not permitted in common areas after quiet hours.</li></ul></div>`,
  `<div><h2>4. Payment Terms</h2><ul><li>Lodge accommodation fees are charged per person per night based on age group and membership status. Current rates are published on the <a href="/join">Join page</a>.</li><li>For confirmed bookings and First Paid, First In bookings, payment is collected immediately via Stripe at the time of booking.</li><li>When Members First priority holds apply, a payment method is saved for the pending non-member portion and is not charged until the booking is confirmed inside the configured threshold before check-in.</li><li>Annual membership subscriptions are invoiced separately through Xero and must be current to access member booking rates.</li><li>All prices are in {{currency}} inclusive of GST where applicable.</li><li>Payment processing is handled by Stripe. {{club-name}} does not store credit card details.</li></ul></div>`,
  `<div><h2>5. Non-Member Booking Priority</h2><p>The committee can choose the booking policy for stays that include non-member guests:</p><ul><li><strong>Members First:</strong> non-member guests outside the configured confirmation threshold are held as &ldquo;Pending&rdquo;. If a member booking requires that capacity before the hold is confirmed, pending non-member bookings may be cancelled (&ldquo;bumped&rdquo;) until sufficient capacity is available.</li><li><strong>First Paid, First In:</strong> non-member guests are included in the normal booking and payment flow immediately, with no provisional member-priority hold.</li><li>Bumped bookings receive a full refund and immediate email notification.</li><li>{{club-name}} accepts no liability for costs incurred by guests (e.g. travel, equipment hire) as a result of a booking being bumped.</li></ul></div>`,
  `<div><h2>6. Cancellation and Refunds</h2><p>Refunds are calculated based on the cancellation policy set by the {{club-name}} committee. Current tiers are shown on the <a href="/rules">Club Rules</a> page. General principles:</p><ul><li>Cancellations with 14 or more days' notice: full refund.</li><li>Cancellations with 7 to 13 days' notice: partial refund (as per current policy).</li><li>Cancellations with less than 7 days' notice: no refund.</li><li>A change fee may apply to date modifications made within the late-notice period.</li><li>Refunds are processed to the original payment method within 5&ndash;10 business days.</li><li>{{club-name}} reserves the right to cancel a booking due to circumstances beyond our control (e.g. natural disaster, lodge damage) and will provide a full refund in such cases.</li></ul></div>`,
  `<div><h2>7. Member Conduct</h2><ul><li>You are responsible for the conduct of all guests on your booking.</li><li>You must not make bookings on behalf of others without their knowledge and consent.</li><li>Any damage to lodge property caused by you or your guests may be invoiced to you.</li><li>Abuse of the booking system (e.g. making and cancelling bookings repeatedly to block dates) may result in account suspension.</li><li>New members must attend their first stay accompanied by their nominating members for lodge induction.</li></ul></div>`,
  `<div><h2>8. Account Security</h2><ul><li>You are responsible for keeping your account credentials confidential. Do not share your password with others.</li><li>If you suspect your account has been compromised, change your password immediately and contact us.</li><li>{{club-name}} accepts no liability for losses resulting from unauthorised access to your account due to your failure to maintain credential security.</li></ul></div>`,
  `<div><h2>9. Limitation of Liability</h2><p>The {{club-name}} is a volunteer-run, not-for-profit organisation. To the maximum extent permitted by New Zealand law:</p><ul><li>The System is provided &ldquo;as is&rdquo; without warranties of any kind, express or implied.</li><li>{{club-name}} is not liable for any indirect, incidental, or consequential losses arising from use of the System or the lodge.</li><li>{{club-name}} is not responsible for personal injury, loss of property, or other incidents occurring during your lodge stay. All guests are advised to hold appropriate personal insurance.</li><li>Nothing in these terms excludes any rights you may have under the Consumer Guarantees Act 1993 or the Fair Trading Act 1986.</li></ul></div>`,
  `<div><h2>10. Account Suspension and Termination</h2><ul><li>{{club-name}} may suspend or terminate an account for breach of these terms, unpaid membership fees, or conduct that is harmful to the club or other members.</li><li>You may request deletion of your account from your Profile page. Deletion will cancel any future bookings (with refunds per the cancellation policy) and anonymise your personal data. Financial records required by law are retained.</li><li>Admin accounts cannot be deleted by the account holder &mdash; contact another administrator.</li></ul></div>`,
  `<div><h2>11. Changes to These Terms</h2><p>{{club-name}} may update these Terms of Service from time to time. We will update the &ldquo;Last updated&rdquo; date at the top of this page. Continued use of the System after any changes constitutes acceptance of the updated terms.</p></div>`,
  `<div><h2>12. Governing Law</h2><p>These terms are governed by the laws of New Zealand. Any disputes will be subject to the exclusive jurisdiction of the New Zealand courts.</p></div>`,
  `<div><h2>13. Contact Us</h2><p>For questions about these terms, please <a href="/contact">contact us</a>.</p></div>`,
  `</div>`,
].join("\n");

const faqContentHtml = [
  `<div class="website-legal-copy">`,
  `<div><h2>Booking &amp; Stays</h2><details><summary>How do I book a stay at the lodge?</summary><p>Members can book directly through this website. Log in, click "Book a Stay", select your dates and add your guests. The calendar shows available beds for each night. You'll need a current membership subscription to book at member rates.</p></details><details><summary>What is the cancellation policy?</summary><p>Refunds are tiered based on how much notice you give. Generally, cancellations 14 or more days before your stay receive a full refund. Between 7 and 14 days you receive a partial refund, and cancellations with less than 7 days' notice receive no refund. The exact tiers are set by the committee and shown on the Club Rules page. Always cancel as early as possible if your plans change.</p></details><details><summary>What are the nightly rates?</summary><p>Rates vary by season (Winter and Summer) and by age group (Adult, Youth, Child). Members pay a significantly lower rate than non-member guests. Current rates are shown on the Join page. Non-member guests must be accompanied by a financial member.</p></details><details><summary>Can I stay at the lodge as a non-member?</summary><p>Yes, but you must be invited as a guest by a current financial member, who must also be staying at the lodge during your visit. Depending on the club's current Booking Policies, your booking may either be paid and confirmed immediately under First Paid, First In, or held under Members First until the configured non-member confirmation threshold.</p></details><details><summary>How does the non-member priority (bumping) system work?</summary><p>When Members First is enabled, the lodge gives priority to member bookings. Non-member guests booked outside the configured threshold are held as "Pending" until the hold expires. If a member needs those beds and the lodge is at capacity, pending non-member bookings may be bumped to free up space. You'll be notified immediately by email and receive a full refund. Under First Paid, First In, the provisional hold and bumping copy do not apply.</p></details><details><summary>Can I change my booking dates?</summary><p>Yes, members can change their booking dates from the booking detail page, subject to availability. A change fee may apply if you're modifying a booking within the late-notice period. The system will show you the fee before you confirm the change.</p></details></div>`,
  `<div><h2>Membership</h2><details><summary>How do I become a member?</summary><p>Membership is by nomination. You need to be nominated by two existing financial members. Start by visiting the lodge as someone's guest, get to know some members, and ask if they'd be willing to nominate you. See the Join page for the full process.</p></details><details><summary>What does membership cost?</summary><p>There is a one-off entrance fee for new members, plus an annual subscription. Subscriptions run April to March and are invoiced through Xero. Family memberships cover all household members at a reduced combined rate. Contact the Treasurer for current fee amounts.</p></details><details><summary>When does the membership year run?</summary><p>The membership year runs from 1 April to 31 March. Annual subscriptions are due at the start of each year. Members with unpaid subscriptions lose access to member booking rates until their subscription is paid.</p></details><details><summary>How do I reset my password?</summary><p>Click "Forgot password?" on the login page and enter your email address. You'll receive a password reset link valid for one hour. If you don't receive the email, check your spam folder or contact the Booking Officer.</p></details></div>`,
  `<div><h2>The Lodge</h2><details><summary>What facilities does the lodge have?</summary><p>{{lodge-name}} sleeps up to {{lodge-capacity}} guests across 6 rooms. The lodge has a fully equipped communal kitchen, dining area, lounge, drying room, and ski storage. Bedding is provided. The lodge is accessible by 2WD vehicle in summer and requires 4WD or chains in winter snow conditions.</p></details><details><summary>What should I bring?</summary><p>Bring your own sleeping bag or hire one. The lodge provides pillows and mattresses. Pack warm clothing, appropriate footwear for the season, and any personal toiletries. If skiing, you can store your gear in the drying room. Check the weather forecast before your trip &mdash; conditions on the mountain can change quickly.</p></details><details><summary>How do chore rosters work?</summary><p>Every guest staying at the lodge is assigned a chore to help keep it clean and tidy. The hut leader for the night assigns chores (such as cleaning the kitchen, vacuuming, or tidying bathrooms) based on who is staying. You'll receive an email with your assigned chore. Chores are shared fairly and take around 15 to 30 minutes. It's how we keep lodge fees affordable for everyone.</p></details></div>`,
  `<div><h2>Privacy &amp; Account</h2><details><summary>What personal data does the club hold about me?</summary><p>The club holds your name, title, gender, date of birth and occupation; your email address, phone number, and street and postal addresses; your profile photo, if you add one; any dietary or allergy information you give; your family group and how its members are related; your membership history and subscriptions; your bookings and the guests on them; your payment records; and your chore assignments. It also keeps copies of the emails the system sends you and security logs of activity on your account. This information is used to manage bookings and club membership.</p><p>This is a summary. Section 2 of our <a href="/privacy">Privacy Policy</a> lists everything the club collects, and the rest of the policy explains how it is stored, used and shared. You can download a copy of your data from your <a href="/profile">Profile page</a>.</p></details><details><summary>How do I update my personal details?</summary><p>Log in and go to your Profile page to update your name, phone number, and date of birth. To change your email address, use the "Change Email" section on your profile &mdash; you'll need to verify the new address. To change your password, use the "Change Password" option.</p></details></div>`,
  `<div class="website-legal-callout"><h2>Still have a question?</h2><p>Can't find what you're looking for? Get in touch and we'll help.</p><p><a href="/contact">Contact Us</a></p></div>`,
  `</div>`,
].join("\n");

export const starterPageContent: StarterPageContent[] = [
  // The home page route ("/") renders the "/home" record and 404s without
  // it, so a starter record must always exist. Seeding is create-if-missing,
  // so content edited in production is never overwritten by a re-run.
  {
    slug: "home",
    path: "/home",
    caption: "Welcome to the Club Lodge",
    menuTitle: "",
    title: "Club Lodge",
    headerText:
      "Our club lodge welcomes members year-round. Log in to book a stay, or apply to join and explore New Zealand's mountains.",
    sortOrder: 5,
    contentHtml: `<h2>Welcome</h2>`.trim(),
  },
  {
    slug: "about",
    path: "/about",
    caption: "About the Club",
    menuTitle: "About",
    title: "About",
    headerText: "Learn about our club history, values, and alpine community.",
    sortOrder: 10,
    contentHtml: `<h2>About the Club</h2>`.trim(),
  },
  {
    slug: "join",
    path: "/join",
    caption: "Join the Club",
    menuTitle: "Join",
    title: "Join",
    headerText:
      "Nomination by two current members, induction process, and membership details.",
    sortOrder: 20,
    contentHtml: `<h2>Becoming a Member</h2>`.trim(),
  },
  {
    slug: "join/apply",
    path: "/join/apply",
    caption: "Membership Application",
    menuTitle: "",
    title: "Apply for Membership",
    headerText:
      "Enter your details, nominate two current club members, and we will move your application through nomination confirmation and committee approval.",
    sortOrder: 25,
    contentHtml: "{{member-application-form}}",
  },
  // The website footer and sitemap link to /rules, so a starter record must
  // exist for the dynamic route to serve.
  {
    slug: "rules",
    path: "/rules",
    caption: "Lodge guidelines",
    menuTitle: "Rules",
    title: "Rules",
    headerText:
      "Lodge rules and expectations for members and guests staying at the lodge.",
    sortOrder: 26,
    contentHtml: `<h2>Lodge Rules</h2>`.trim(),
  },
  {
    slug: "contact",
    path: "/contact",
    caption: "Get in touch",
    // EMPTY like every other opt-in page: the nav is fully the club's to
    // arrange, and Contact is no exception. There is no code fixture for it — a
    // club that wants Contact in its menu gives this page a menu title in the
    // CMS, and until it does, Contact stays out of the nav.
    menuTitle: "",
    title: "Contact Us",
    headerText:
      "Have a question about the club, the lodge, or booking a stay? Get in touch and we'll get back to you.",
    sortOrder: 27,
    contentHtml: "{{contact-form}}",
  },
  {
    slug: "booking-requests",
    path: "/booking-requests",
    caption: "Request a stay",
    // EMPTY on purpose, and it is the whole of the opt-in model (#2818
    // decision 1). An empty menu title keeps the page out of the navigation AND
    // out of search engines — `(website-dynamic)/booking-requests/page.tsx`
    // reads this same field for its robots tag — so a club that does nothing
    // keeps the unlisted behaviour #2421 established. A club that wants the form
    // advertised types a title here under Site Appearance & Content → Page
    // Content, and both follow.
    menuTitle: "",
    title: "Booking Requests",
    headerText:
      "Request a stay without creating an account. We'll email you to confirm your address, then review and price your request.",
    sortOrder: 28,
    contentHtml: "{{booking-requests}}",
  },
  {
    slug: "school-bookings",
    path: "/school-bookings",
    caption: "For schools & groups",
    // Empty for the same reason as the booking-request page above: advertising
    // the form is the club's decision, not the default (#2818 decision 1).
    menuTitle: "",
    title: "School Bookings",
    headerText:
      "Planning a school or group trip? Tell us your dates and numbers, and we'll email you a quote for your school to review.",
    sortOrder: 29,
    contentHtml: "{{school-bookings}}",
  },
  {
    slug: "committee",
    path: "/committee",
    caption: "Volunteer leadership",
    menuTitle: "Committee",
    title: "Committee",
    headerText:
      "The club is run entirely by volunteers. Meet the committee members who keep things going.",
    sortOrder: 30,
    contentHtml: "{{committee-members-cards}}",
  },
  {
    slug: "privacy",
    path: "/privacy",
    caption: "Policy",
    menuTitle: "",
    title: "Privacy Policy",
    headerText: `How we collect, use, and protect your personal information.<br><small>${PRIVACY_POLICY_DATE_LINE}</small>`,
    sortOrder: 80,
    contentHtml: privacyPolicyContentHtml,
  },
  {
    slug: "terms",
    path: "/terms",
    caption: "Policy",
    menuTitle: "",
    title: "Terms of Service",
    headerText: `Please read these terms carefully before using the booking system.<br><small>${POLICY_DATE_LINE}</small>`,
    sortOrder: 81,
    contentHtml: termsOfServiceContentHtml,
  },
  {
    slug: "faq",
    path: "/faq",
    caption: "Common questions",
    menuTitle: "",
    title: "Frequently Asked Questions",
    headerText: "Common questions about the lodge, bookings, and membership.",
    sortOrder: 82,
    contentHtml: faqContentHtml,
  },
  {
    slug: "404",
    path: "/404",
    caption: "Page not found",
    menuTitle: "",
    title: "Page Not Found",
    headerText: "The page you are looking for does not exist.",
    sortOrder: 100,
    contentHtml: "<h2>Page Not Found</h2>",
  },
];
