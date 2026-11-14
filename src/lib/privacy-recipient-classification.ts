import type { IntegrationCredentialNamespace } from "@/lib/integration-credential-namespaces";

interface PrivacyRecipient {
  name: string;
  dataSent: string;
  enablement: string;
  processing: string;
  /** Whether members need this recipient disclosed in their privacy notice. */
  memberFacing: boolean;
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
    dataSent: "Payment amounts, payer email, payment references and booking or subscription identifiers; card details go directly from the browser to Stripe.",
    enablement: "Stripe credentials and payment features enable payments; disconnecting or disabling the payment feature stops new payments, but does not delete Stripe records.",
    processing: "See the club's Stripe account terms and Stripe's privacy notice; the application does not fix a processing country.",
    memberFacing: true,
    hosts: ["api.stripe.com", "hooks.stripe.com", "js.stripe.com"],
    privacyUrl: "https://stripe.com/privacy",
  },
  xero: {
    name: "Xero",
    dataSent: "Member contact details and accounting records, including invoice, payment and subscription references.",
    enablement: "The Xero integration module, saved credentials and an OAuth connection enable sync; switching the module off or disconnecting stops new sync, without deleting Xero records.",
    processing: "See the club's Xero account terms and Xero's privacy notice; the application does not fix a processing country.",
    memberFacing: true,
    hosts: [],
    privacyUrl: "https://www.xero.com/about/legal/privacy/",
  },
  email: {
    name: "Email service (Amazon SES or the club's SMTP relay)",
    dataSent: "Recipient addresses, names and message contents, which can include booking details and one-time action links.",
    enablement: "USE_AWS_SES or USE_SMTP_RELAY and their credentials enable delivery; disabling delivery stops new messages, including sign-in and recovery email.",
    processing: "The club chooses its mail service and configured region or relay; check that provider's contract and privacy notice.",
    memberFacing: true,
    hosts: [],
    privacyUrl: "https://aws.amazon.com/privacy/",
  },
  hosting: {
    name: "Hosting provider",
    dataSent: "The application database, uploaded content, request and server logs, including members' personal information.",
    enablement: "Running the application and database on the club's chosen infrastructure enables this flow; ending hosting requires an operational migration or shutdown.",
    processing: "The club's choice: see Admin → Setup & Configuration → Site Appearance & Content → Club Identity → Where members' data is held. Ask the Privacy Officer if it is not set.",
    memberFacing: true,
    hosts: [],
    privacyUrl: "https://www.privacy.org.nz/your-rights/",
  },
  backup: {
    name: "Amazon S3 backups",
    dataSent: "Compressed database backups containing the personal information stored in the database. The upload does not itself request S3 encryption.",
    enablement: "Enabled backup settings, a bucket and usable S3 credentials enable uploads; disabling backups stops new uploads, without deleting stored copies.",
    processing: "The club chooses its S3 bucket and region in backup settings; check its AWS account terms and bucket encryption configuration.",
    memberFacing: true,
    hosts: [],
    privacyUrl: "https://aws.amazon.com/privacy/",
  },
  google: {
    name: "Google (Analytics and sign-in)",
    dataSent: "Analytics receives consented usage events and browser/device information, without intentional member identifiers. Google sign-in exchanges identity and authentication information.",
    enablement: "Analytics needs the analytics module, a measurement ID and the visitor's consent; withdrawing consent stops analytics. Sign-in needs the googleLogin module and verified OAuth credentials; disabling it stops new Google sign-ins.",
    processing: "See Google's privacy notice and the club's Google account terms; the application does not fix a processing country.",
    memberFacing: true,
    hosts: ["www.google-analytics.com", "www.googletagmanager.com"],
    privacyUrl: "https://policies.google.com/privacy",
  },
  anthropic: {
    name: "Anthropic (AI help and AI Diagnostics)",
    dataSent: "AI help receives questions, conversation and permitted page context. AI Diagnostics receives operator questions and tool results; a question can cause personal information to be returned to the model.",
    enablement: "Each feature needs its own module and dedicated saved API key; both are off unless configured. Switching its module off stops new calls; removing one key does not disable the other feature.",
    processing: "See the club's Anthropic account terms and Anthropic's privacy notice; the application does not fix a processing country.",
    memberFacing: true,
    hosts: [],
    privacyUrl: "https://privacy.anthropic.com/",
  },
  sentry: {
    name: "Sentry",
    dataSent: "Filtered errors and diagnostic context. Optional session replay adds masked browser interaction recordings; filtering and masking do not establish that every possible value is absent.",
    enablement: "A configured Sentry DSN enables error reporting. Replay also needs sentryReplayEnabled and eligible browser sampling; it is off by default. Disable replay separately or remove the DSN to stop new reporting.",
    processing: "See the club's Sentry project region, account terms and Sentry's privacy notice.",
    memberFacing: true,
    hosts: ["sentry.io"],
    privacyUrl: "https://sentry.io/privacy/",
  },
  "breached-passwords": {
    name: "Have I Been Pwned (breached-password check)",
    dataSent: "Only the first five hexadecimal characters of the chosen password's SHA-1 hash, plus the server's network request; neither the password, full hash nor member identity is sent.",
    enablement: "The breachedPasswordCheck login-security setting enables chosen-password screening; switching it off stops new range lookups.",
    processing: "See Have I Been Pwned's privacy notice; the application does not fix a processing country.",
    memberFacing: true,
    hosts: ["api.pwnedpasswords.com"],
    privacyUrl: "https://haveibeenpwned.com/Privacy",
  },
  addy: {
    name: "Addy",
    dataSent: "Typed address searches, selected address identifiers and an optional search-session identifier.",
    enablement: "The addressAutocomplete module and ADDY_API_KEY / ADDY_API_SECRET enable lookups; the feature is off unless configured. Disable the module or remove credentials to stop lookups.",
    processing: "See the club's Addy account terms and Addy's privacy notice; the application does not fix a processing country.",
    memberFacing: true,
    hosts: ["api-nz.addysolutions.com"],
    privacyUrl: "https://www.addysolutions.com/privacy-policy",
  },
  mirotalk: {
    name: "Video-meeting server (MiroTalk)",
    dataSent: "Meeting room and signed access claims, participant display names and network information; participants send audio/video when they join.",
    enablement: "The videoMeetings module and a usable meeting-server configuration enable meetings; it is off unless configured. Disable the module or revoke its credentials to stop issuing new access; existing calls may need ending on the meeting server.",
    processing: "The club chooses its meeting server and host; check that operator's location, contract and privacy notice.",
    memberFacing: true,
    hosts: [],
    privacyUrl: "https://github.com/miroslavpejic85/mirotalk",
  },
  servernz: {
    name: "Alpine Central Server",
    dataSent: "The club's owned lodge listings, booking officer contact details and callback address; no member directory is uploaded. Listings can be shared with other connected clubs.",
    enablement: "The serverNZ module, configured server, API key and sync opt-in enable sharing; it is off unless configured. Disable the module or sync opt-in to stop new sync; the central operator controls copies already shared.",
    processing: "The club chooses its central server address; ask that operator where it processes and shares listings and for its privacy notice.",
    memberFacing: true,
    hosts: [],
    privacyUrl: "https://github.com/thatskiff33/AlpineClubServerNZ",
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
