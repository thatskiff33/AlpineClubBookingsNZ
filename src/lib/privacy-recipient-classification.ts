import type { IntegrationCredentialNamespace } from "@/lib/integration-credential-namespaces";

interface PrivacyRecipient {
  name: string;
  dataSent: string;
  enablement: string;
  processing: string;
  /** Whether members need this recipient disclosed in their privacy notice. */
  memberFacing: boolean;
  /**
   * When members' information reaches this recipient: `always` (setup requires
   * it, or the System cannot run without it), `club-turns-on` (nothing is sent
   * until the club turns the feature on or connects it) or `club-turns-off`
   * (sent from the start unless the club turns it off). The starter privacy
   * policy's "Only if the club turns it on" marking is derived from this, so it
   * is defined here and nowhere else (#5007).
   */
  availability: "always" | "club-turns-on" | "club-turns-off";
  /** Literal HTTPS destinations; configured addresses and SDK hosts are also described in the row. */
  hosts: readonly string[];
  privacyUrl: string;
}

/**
 * Outside recipients, cross-checked with docs/PRIVACY_RECIPIENTS.md by the census.
 * Locations belong to the club's contract with the provider, never a guessed region.
 */
export const PRIVACY_RECIPIENTS = {
  stripe: {
    name: "Stripe",
    dataSent: "Payment amounts, payer name and email, an internal member identifier, and payment and booking identifiers; card details go directly from the browser to Stripe.",
    enablement: "Stripe credentials and payment features enable payments; disconnecting or disabling the payment feature stops new payments, but does not delete Stripe records.",
    processing: "See the club's Stripe account terms and Stripe's privacy notice; the application does not fix a processing country.",
    memberFacing: true,
    availability: "always",
    hosts: ["api.stripe.com", "hooks.stripe.com", "js.stripe.com"],
    privacyUrl: "https://stripe.com/privacy",
  },
  xero: {
    name: "Xero",
    dataSent: "Member name, email address, phone number, street and postal addresses and date of birth; where the club groups its Xero contacts, membership type and age group as Xero contact groups; on a membership cancellation, the club's cancelled groups and, if the club has archiving on, archiving the contact; and accounting records, including invoice, payment and subscription references. Invoices and credit notes can also name the people on a booking with their age group, member status and stay dates, and carry the membership type billed, an internal member identifier and any reason an administrator records for a credit.",
    enablement: "The Xero integration module, saved credentials and an OAuth connection enable sync; switching the module off or disconnecting stops new sync, without deleting Xero records.",
    processing: "See the club's Xero account terms and Xero's privacy notice; the application does not fix a processing country.",
    memberFacing: true,
    availability: "club-turns-on",
    hosts: [],
    privacyUrl: "https://www.xero.com/about/legal/privacy/",
  },
  email: {
    name: "Email service (Amazon SES or the club's SMTP relay)",
    dataSent: "Recipient addresses, names and message contents, which can include booking details and one-time action links.",
    enablement: "USE_AWS_SES or USE_SMTP_RELAY and their credentials enable delivery; disabling delivery stops new messages, including sign-in and recovery email.",
    processing: "The club chooses its mail service and configured region or relay; check that provider's contract and privacy notice.",
    memberFacing: true,
    availability: "always",
    hosts: [],
    privacyUrl: "https://aws.amazon.com/privacy/",
  },
  hosting: {
    name: "Hosting provider",
    dataSent: "The application database, uploaded content, request and server logs, including members' personal information.",
    enablement: "Running the application and database on the club's chosen infrastructure enables this flow; ending hosting requires an operational migration or shutdown.",
    processing: "The club's choice: see Admin → Setup & Configuration → Site Appearance & Content → Club Identity → Where members' data is held. Ask the Privacy Officer if it is not set.",
    memberFacing: true,
    availability: "always",
    hosts: [],
    privacyUrl: "https://www.privacy.org.nz/your-rights/",
  },
  backup: {
    name: "Amazon S3 backups",
    dataSent: "Compressed database backups containing the personal information stored in the database. The upload does not itself request S3 encryption.",
    enablement: "Enabled backup settings, a bucket and usable S3 credentials enable uploads; disabling backups stops new uploads, without deleting stored copies.",
    processing: "The club chooses its S3 bucket and region in backup settings; check its AWS account terms and bucket encryption configuration.",
    memberFacing: true,
    availability: "club-turns-on",
    hosts: [],
    privacyUrl: "https://aws.amazon.com/privacy/",
  },
  google: {
    name: "Google (Analytics and sign-in)",
    dataSent: "Analytics receives consented usage events and browser/device information, without intentional member identifiers. Google sign-in exchanges identity and authentication information.",
    enablement: "Analytics needs the analytics module, a measurement ID and the visitor's consent; withdrawing consent stops analytics. Sign-in needs the googleLogin module and verified OAuth credentials; disabling it stops new Google sign-ins.",
    processing: "See Google's privacy notice and the club's Google account terms; the application does not fix a processing country.",
    memberFacing: true,
    availability: "club-turns-on",
    hosts: ["www.google-analytics.com", "www.googletagmanager.com"],
    privacyUrl: "https://policies.google.com/privacy",
  },
  anthropic: {
    name: "Anthropic (AI help and AI Diagnostics)",
    dataSent: "AI help receives questions, conversation and permitted page context. AI Diagnostics receives operator questions, earlier questions and answers in the same conversation, screen context, excerpts of the application's code, its built-in guides and any private notes the deployment adds, and tool results; a question can cause personal information to be returned to the model, and an answer that includes it is sent again with later questions in the same conversation.",
    enablement: "Each feature needs its own module and dedicated saved API key; both are off unless configured. Switching its module off stops new calls; removing one key does not disable the other feature.",
    processing: "Can be processed outside New Zealand; see the club's Anthropic account terms and Anthropic's privacy notice — the application does not fix which country.",
    memberFacing: true,
    availability: "club-turns-on",
    hosts: [],
    privacyUrl: "https://privacy.anthropic.com/",
  },
  sentry: {
    name: "Sentry",
    dataSent: "Filtered errors and diagnostic context. Optional session replay adds masked browser interaction recordings; filtering and masking do not establish that every possible value is absent.",
    enablement: "A configured Sentry DSN enables error reporting. Replay also needs sentryReplayEnabled and eligible browser sampling; it is off by default. Disable replay separately or remove the DSN to stop new reporting.",
    processing: "See the club's Sentry project region, account terms and Sentry's privacy notice.",
    memberFacing: true,
    availability: "club-turns-on",
    hosts: ["sentry.io"],
    privacyUrl: "https://sentry.io/privacy/",
  },
  "breached-passwords": {
    name: "Have I Been Pwned (breached-password check)",
    dataSent: "Only the first five hexadecimal characters of the chosen password's SHA-1 hash, plus the server's network request; neither the password, full hash nor member identity is sent.",
    enablement: "The breachedPasswordCheck login-security setting enables chosen-password screening; switching it off stops new range lookups.",
    processing: "See Have I Been Pwned's privacy notice; the application does not fix a processing country.",
    memberFacing: true,
    availability: "club-turns-off",
    hosts: ["api.pwnedpasswords.com"],
    privacyUrl: "https://haveibeenpwned.com/Privacy",
  },
  addy: {
    name: "Addy",
    dataSent: "Typed address searches, selected address identifiers and an optional search-session identifier.",
    enablement: "The addressAutocomplete module and ADDY_API_KEY / ADDY_API_SECRET enable lookups; the feature is off unless configured. Disable the module or remove credentials to stop lookups.",
    processing: "See the club's Addy account terms and Addy's privacy notice; the application does not fix a processing country.",
    memberFacing: true,
    availability: "club-turns-on",
    hosts: ["api-nz.addysolutions.com"],
    privacyUrl: "https://www.addysolutions.com/privacy-policy",
  },
  mirotalk: {
    name: "Video-meeting server (MiroTalk)",
    dataSent: "Meeting room and signed access claims, participant display names and network information; participants send audio/video when they join.",
    enablement: "The videoMeetings module and a usable meeting-server configuration enable meetings; it is off unless configured. Disable the module or revoke its credentials to stop issuing new access; existing calls may need ending on the meeting server.",
    processing: "The club chooses its meeting server and host; check that operator's location, contract and privacy notice.",
    memberFacing: true,
    availability: "club-turns-on",
    hosts: [],
    privacyUrl: "https://github.com/miroslavpejic85/mirotalk",
  },
  servernz: {
    name: "Alpine Central Server",
    dataSent: "The club's owned lodge listings, booking officer contact details and callback address; no member directory is uploaded. Listings can be shared with other connected clubs. When a member ticks Share with all clubs on a message-board post, that post, its images, the member's name and an internal member identifier are also sent so the central server can show the post on other connected clubs' boards.",
    enablement: "The serverNZ module, configured server, API key and sync opt-in enable sharing; it is off unless configured. Disable the module or sync opt-in to stop new sync; the central operator controls copies already shared.",
    processing: "The club chooses its central server address; ask that operator where it processes and shares listings and for its privacy notice.",
    memberFacing: true,
    availability: "club-turns-on",
    hosts: [],
    privacyUrl: "https://github.com/thatskiff33/AlpineClubServerNZ",
  },
  "ai-apps": {
    name: "AI app a member or officer connects",
    dataSent: "What the connected app's actions return for the person who approved it: their name, email address, phone number, street address, age group and whether two-step sign-in is on; the names, age groups and relationships of their family group's active members, and the family group requests, invitations and partner link they make or receive, with the names of the people involved; the names, ids and age groups of other members the person looks up to add as a guest, as the club's guest picker shows them, never their contact details or dates of birth; whose memberships they may ask to cancel and their cancellation requests, without email addresses; their bookings and drafts, with the name, age group and member status of everyone in each party and the price and note on a booking they made; the refund figures for cancelling their own booking; their credit balance, subscription status and email preferences; the notices they can see, including those addressed to a committee role they hold; a one-line summary of each entry in their own account history, which can name other people the entry involves; the names and nights of others staying at lodges they can book, reduced as the club's roster page reduces them, only while the roster module is on; the club's published age groups, booking messages, committee entries (name, role and description) and ski-field report; the club's events calendar and open work parties; the message board's posts with each author's name and, for a post shared from another connected club, that club's name; their own food orders and lodge induction, with the names of those who signed it or are assigned to sign it, and the food order and maintenance report forms; and their own whole-lodge requests (dates, party size and status), the group bookings they open, with their join code, and, for a group join code, what the group's public join page shows, including the organiser's first name. A post, food order, maintenance report or whole-lodge request the app makes on the person's word is shown to members or emailed to the club's officers, as one made on the website is. A date of birth the app saves, for the person or a family member without a login, can move that person's age group and so the prices of their future bookings. An officer's connection also sends other members' information that officer can see on the admin screens of the areas they hold: for Bookings & Beds, booker and guest names, age groups, booking dates, prices and status, the names, age groups and relationships of a member's family group when booking for them, members found by name or email search to add as guests (name and age group), the reasons and messages on booking, change and exception requests, officers' notes on them and the names of the officers who priced or reviewed them, the email address and phone number of a non-member or booking-request contact, school teachers' names and email addresses, a change request's payment amounts and Xero invoice number, the bed allocation board with guest and custodian names, and promo codes with their assigned members' names and uses. Card details and passwords are never sent.",
    enablement: "The mcpServer module (off by default), a host on the club's approved list (an app on the person's own computer is always allowed), the members' switch or, for an officer, the separate officers' switch (off by default), and the person approving the app enable the flow; an officer's connection sends other members' information only once the officer has approved it on the screen that says the app can act as an officer. Switching the module or a switch off, removing the host, or disconnecting the app stops new calls; it does not erase what the app's provider already received.",
    processing: "The person connecting chooses the app; check that provider's terms and privacy notice. The application does not fix a processing country.",
    memberFacing: true,
    availability: "club-turns-on",
    hosts: [],
    privacyUrl: "https://modelcontextprotocol.io/",
  },
} as const satisfies Record<string, PrivacyRecipient>;

/** One recipient can have several credential namespaces; all namespaces must be classified. */
export const CREDENTIAL_RECIPIENTS = {
  xero: "xero",
  "xero-oauth": "xero",
  stripe: "stripe",
  google: "google",
  backup: "backup",
  anthropic: "anthropic",
  "anthropic-diagnostics": "anthropic",
  servernz: "servernz",
  mirotalk: "mirotalk",
} as const satisfies Record<IntegrationCredentialNamespace, keyof typeof PRIVACY_RECIPIENTS>;

/** Literal hosts in server-capable source which do not receive members' information. */
export const NON_RECIPIENT_HTTPS_HOSTS = {
  "bookings.example.org": "Fictional booking address in email-preview example content.",
  "calendar.google.com": "User-opened calendar link with event title and dates; not a server upload of member details.",
  "dashboard.stripe.com": "Operator link to a Stripe record; not an additional API recipient.",
  "example.org": "Fictional safe-default club website.",
  "go.xero.com": "Operator link to a Xero record; not an additional API recipient.",
  "outlook.live.com": "User-opened calendar link with event title and dates; not a server upload of member details.",
  "rmca.org.nz": "Legacy literal recognised only by the config-transfer sanitiser.",
  "snowhq.com": "Public snow conditions fetched without member information.",
  "tacbookings.local": "Parse base for validating internal return paths; never contacted.",
  "visible-email-url.invalid": "Reserved-TLD parse base for URLs shown in email text; never contacted.",
  "www.fmc.org.nz": "Legacy public-link literal recognised only by the config-transfer sanitiser.",
  "www.snow.nz": "Public snow-report link in token help text.",
  "www.whakapapa.com": "Public snow conditions fetched without member information.",
} as const satisfies Record<string, string>;
