import type { Prisma } from "@prisma/client";
import type { FeatureFlags } from "./schema";

export const MODULE_KEYS = [
  "kiosk",
  "chores",
  "financeDashboard",
  "waitlist",
  "xeroIntegration",
  "bedAllocation",
  "internetBankingPayments",
  "addressAutocomplete",
  "groupBookings",
  "lockers",
  "induction",
  "workParties",
  "promoCodes",
  "hutLeaders",
  "communications",
  "memberNotices",
  "eventsCalendar",
  "skifieldConditions",
  "twoFactor",
  "magicLink",
  "googleLogin",
  "analytics",
  "lobbyDisplay",
  "aiAssistant",
  "memberGuests",
  "aiDiagnostics",
  "maintenanceReports",
  "alpineCentralServer",
  "commsPortal",
] as const;

export type ModuleKey = (typeof MODULE_KEYS)[number];
export type ModuleSettingsValues = Record<ModuleKey, boolean>;

/**
 * Prisma `select` for every read of the ClubModuleSettings singleton — the live
 * module columns (derived from MODULE_KEYS) plus the two audit fields. Deriving
 * it from MODULE_KEYS matters for blue/green safety: a bare
 * `findUnique({ where })` has no `select`, so Prisma names EVERY column in its
 * schema — including retired-but-not-yet-dropped columns like the former
 * `multiLodge` flag. Selecting only the live module columns means the generated
 * SQL never references such a column, so a later contract migration that DROPs
 * it (#139) is safe from this release onward: this release's client does not
 * read it. Any read of ClubModuleSettings must use this select.
 */
export const CLUB_MODULE_SETTINGS_COLUMN_SELECT = {
  ...(Object.fromEntries(MODULE_KEYS.map((key) => [key, true])) as Record<
    ModuleKey,
    true
  >),
  updatedAt: true,
  updatedByMemberId: true,
} satisfies Prisma.ClubModuleSettingsSelect;

// Default activation for a club that has not saved its Modules page yet. The
// optional "capability" modules (which require deploy-time setup such as Xero
// credentials, kiosk hardware, or bed inventory) default OFF so a fresh install
// opts into them deliberately. The general-purpose modules default ON so the
// software is fully featured out of the box and each club switches OFF what it
// does not use.
export const DEFAULT_MODULE_SETTINGS: ModuleSettingsValues = {
  kiosk: false,
  chores: false,
  financeDashboard: false,
  waitlist: false,
  xeroIntegration: false,
  bedAllocation: false,
  internetBankingPayments: false,
  addressAutocomplete: false,
  groupBookings: true,
  lockers: true,
  induction: true,
  workParties: true,
  promoCodes: true,
  hutLeaders: true,
  communications: true,
  memberNotices: true,
  eventsCalendar: true,
  skifieldConditions: true,
  twoFactor: false,
  magicLink: false,
  googleLogin: false,
  analytics: false,
  lobbyDisplay: false,
  aiAssistant: false,
  memberGuests: false,
  aiDiagnostics: false,
  // General-purpose, no deploy-time setup, so it follows the ON default the
  // comment above describes. Turning it ON does NOT open the unauthenticated QR
  // form: that is a separate, default-OFF setting (#2780).
  maintenanceReports: true,
  alpineCentralServer: false,
  // Default OFF, inverting the general ON rule above on purpose: sharing a
  // post from this module publishes member-written content to other clubs.
  // An upgrade must not start doing that because nobody opted out (#2993).
  commsPortal: false,
};

export interface ModuleDefinition {
  key: ModuleKey;
  label: string;
  description: string;
  dependencies: string[];
}

export const MODULE_DEFINITIONS: Record<ModuleKey, ModuleDefinition> = {
  kiosk: {
    key: "kiosk",
    label: "Lodge kiosk",
    description: "Guest arrival, departure, and lodge access screens.",
    dependencies: [],
  },
  chores: {
    key: "chores",
    label: "Chores and roster",
    description: "Roster generation, chore templates, and guest chore tracking.",
    dependencies: [],
  },
  financeDashboard: {
    key: "financeDashboard",
    label: "Finance dashboard",
    description: "Finance reports, sync diagnostics, and finance-only dashboards.",
    dependencies: [
      "Finance access levels and finance data sync are configured separately.",
    ],
  },
  waitlist: {
    key: "waitlist",
    label: "Waitlist",
    description: "Waitlist booking state, admin queue, and offer handling.",
    dependencies: [],
  },
  xeroIntegration: {
    key: "xeroIntegration",
    label: "Xero integration",
    description: "Operational Xero linking, sync actions, and reconciliation tools.",
    dependencies: [
      "Xero OAuth credentials, tenant tokens, and account mappings are configured outside this table.",
    ],
  },
  bedAllocation: {
    key: "bedAllocation",
    label: "Bed allocation",
    description: "Room and bed setup plus admin guest-to-bed allocation.",
    dependencies: [
      "Room and bed inventory is configured separately.",
      "When on, each lodge's capacity is its active bed count; set a lower per-lodge capacity on the lodge page to cap sleeping below the installed beds.",
      // #2286 review M11: turning the module off does NOT release a custodian
      // bed hold, and it must not — the bed is physically occupied whatever a
      // feature flag says. State it here so an admin turning the module off is
      // not surprised by capacity that stays reduced, and knows the way back.
      "Turning this off does not release a bed already held for a hut leader: that bed is genuinely occupied, so it keeps counting. Release it with the Release bed button on Hut Leaders, which stays available while this module is off.",
    ],
  },
  internetBankingPayments: {
    key: "internetBankingPayments",
    label: "Internet Banking payments",
    description: "Member Internet Banking payment option backed by Xero invoices.",
    dependencies: [
      "Operational Xero must be active before invoices can be issued.",
    ],
  },
  addressAutocomplete: {
    key: "addressAutocomplete",
    label: "Address autocomplete",
    description:
      "Optional Addy-powered suggestions for address fields. Manual address entry remains available.",
    dependencies: [
      "ADDY_API_KEY and ADDY_API_SECRET must be configured server-side before suggestions can load.",
    ],
  },
  groupBookings: {
    key: "groupBookings",
    label: "Group bookings",
    description:
      "Organisers open a booking as a group and share a join code so members and guests can add themselves.",
    dependencies: [
      "Organiser-paid settlement also requires Xero integration and Internet Banking payments.",
    ],
  },
  lockers: {
    key: "lockers",
    label: "Lockers",
    description:
      "Record physical lockers and allocate them to members; allocations show on the member dashboard.",
    dependencies: [],
  },
  induction: {
    key: "induction",
    label: "Lodge induction",
    description:
      "New-member and hut-leader induction checklists, assigned signers, and single-Pass sign-off.",
    dependencies: [
      "When off, inductions are no longer auto-created for newly approved members.",
    ],
  },
  workParties: {
    key: "workParties",
    label: "Work parties",
    description:
      "Organised volunteer working bees and the booking discounts they grant.",
    dependencies: [],
  },
  promoCodes: {
    key: "promoCodes",
    label: "Promo codes",
    description:
      "Discount codes members can apply to bookings, plus admin management.",
    dependencies: [],
  },
  hutLeaders: {
    key: "hutLeaders",
    label: "Hut leaders",
    description:
      "Daily hut-leader assignments, kiosk access, and auto-assignment. Roster generation stays under the Chores module.",
    dependencies: [],
  },
  communications: {
    key: "communications",
    label: "Communications",
    description:
      "Admin bulk email to members. Does not affect transactional notifications.",
    dependencies: [],
  },
  memberNotices: {
    key: "memberNotices",
    label: "Member notices",
    description:
      "Committee-authored news notices targeted to member audiences, shown on the member dashboard with per-member read tracking.",
    dependencies: [],
  },
  eventsCalendar: {
    key: "eventsCalendar",
    label: "Events calendar",
    description:
      "Club events calendar for meetings, working bees, and social events, with recurring events and optional video-meeting links.",
    dependencies: [
      // Stated because turning the module off is the ONLY thing that removes
      // the calendar: it has no credential or inventory prerequisite, so an
      // admin reading this card needs to know what the switch actually hides.
      "When off, the member and admin calendar pages and the calendar API return Not Found, and the dashboard Events card disappears. Existing events are kept and reappear when it is switched back on.",
      "Video meetings on an event need a separately hosted MiroTalk service; the calendar itself works without one.",
    ],
  },
  skifieldConditions: {
    key: "skifieldConditions",
    label: "Ski-field conditions",
    description:
      "Live mountain/road status panel and widgets, plus the admin conditions cache.",
    dependencies: [],
  },
  twoFactor: {
    key: "twoFactor",
    label: "Two-factor authentication",
    description:
      "Require members and admins to verify an authenticator app, email code, or recovery code after password login.",
    dependencies: [
      "Transactional email delivery should be configured before enabling email one-time codes.",
    ],
  },
  magicLink: {
    key: "magicLink",
    label: "Email sign-in link",
    description:
      "Let members request a single-use email link to sign in without typing their password. Additive to password login, never a replacement, and only for existing verified members.",
    dependencies: [
      "Transactional email delivery must be configured so sign-in links can be sent.",
      "The link expiry (default 15 minutes) is set on the Login & Security page.",
    ],
  },
  googleLogin: {
    key: "googleLogin",
    label: "Google sign-in",
    description:
      "Let members sign in with their linked Google account. Additive to password login, never a replacement. A member links their own Google account from their profile while signed in — no account is ever created from Google, and unlinked Google accounts are refused.",
    dependencies: [
      "Your club's Google Cloud OAuth credentials are entered and verified in-app on the Google sign-in setup page (Admin → Integrations → Google) — no environment variables or restart. The module stays locked until a real Google sign-in round-trip verifies.",
    ],
  },
  analytics: {
    key: "analytics",
    label: "Google Analytics",
    description:
      "GA4 tracking on the public website, with configurable visitor consent settings. Never runs on admin pages, signed-in member pages, or any page whose address carries a token, PIN or personal identifier.",
    dependencies: [
      // #2573: the measurement ID moved into the database and the environment
      // variable was removed from runtime, so this no longer names one.
      "Complete the Google Analytics setup under Admin → Integrations after enabling this module. Analytics stays off until a valid GA4 measurement ID is saved there.",
    ],
  },
  lobbyDisplay: {
    key: "lobbyDisplay",
    label: "Lobby TV display",
    description:
      "Read-only paired lobby screens showing per-lodge arrivals, departures, chores, and lodge information.",
    dependencies: [
      "Display devices are paired from the lodge admin pages once the module is on.",
    ],
  },
  aiAssistant: {
    key: "aiAssistant",
    label: "AI help assistant",
    description:
      "Free-text help questions answered by a paid AI model, grounded in each page's help content. Curated page help works without it.",
    dependencies: [
      "Enter your Anthropic API key under Admin → Integrations before the assistant can answer.",
      "A monthly spend cap (default NZ$10) hard-stops AI answers for the rest of the month once reached; adjust it on the AI assistant settings.",
    ],
  },
  memberGuests: {
    key: "memberGuests",
    label: "Add another member as a guest",
    // MG1 (#2306) shipped this switch with a "Not available yet" prefix because
    // it genuinely gated nothing. MG2 (#2307) is the release that makes it real,
    // so that copy is gone — leaving it would be a worse lie than shipping it
    // was. What replaces it is the one thing an admin needs before flipping it:
    // that turning this on lets members reach OTHER households, and that the
    // other member is asked first by default.
    description:
      "Lets a member add another club member, outside their own family group, as a guest on their booking — when they first book it and when they edit it later. By default the other member is emailed and asked first, and a bed is held for them until they answer or the request lapses.",
    dependencies: [
      // The MG2 honesty gate ("not ready to turn on yet") lived here while the
      // accept screen was held for the owner's mockup sign-off. That screen —
      // the booking-page consent card and the delegate page — ships in the same
      // release as this bullet's deletion, so the module is now genuinely
      // usable end to end.
      //
      // MG4 (#2309) adds the fourth bullet. The first three describe what
      // happens when a MEMBER adds somebody; the fourth is the half an admin is
      // most likely to be surprised by, because it changes what THEIR OWN
      // actions do — an officer's add, a booking copy and an approved booking
      // request all start emailing people the moment this switch goes on.
      "The other member is asked before they are added, unless you change that on the member-guest settings. Set how long a request waits there too.",
      "A member who has been asked but has not answered yet holds a bed, and is deliberately left off the kiosk arrivals list, the chore roster and the arrival emails until they accept.",
      "Finding another member is by exact email address unless you switch on name search — which makes your membership list browsable to any member. It ships off.",
      "It also covers what YOUR staff do: adding a member guest on somebody's booking, copying a booking, and approving a booking request with a member linked to a place all email that member to say so. Those emails are not optional, and nobody is asked first on an admin path.",
    ],
  },
  maintenanceReports: {
    key: "maintenanceReports",
    label: "Maintenance reports",
    description:
      "Members report a physical fault at the lodge from a card on their dashboard, and the report lands in a queue for whoever holds Lodge Operations. Optionally, a printed QR code in the lodge opens the same form without signing in.",
    dependencies: [
      // Stated because the module switch is NOT what opens the public door, and
      // an admin reading this card is the person most likely to assume it is.
      "The QR code that lets somebody report a fault WITHOUT signing in is off until you switch it on under Admin -> Lodge -> Maintenance reports, and each lodge needs its own code generated on that lodge's page.",
      "The questions the form asks are yours to edit, reorder and retire; five plain-English ones are set up for you.",
      "Photos attached to a report are deleted automatically after the number of days you set (30 by default); the report itself is kept.",
    ],
  },
  aiDiagnostics: {
    key: "aiDiagnostics",
    label: "AI Diagnostics",
    description:
      "A separate admin-only assistant that can explain the deployed code and retrieve bounded, permission-scoped operational evidence. Distinct from the AI help assistant: it has its own paid credential, spend budget, and security model.",
    dependencies: [
      // Stated because turning the switch on does NOT by itself enable anything
      // that spends money — the two setup steps below, and a passing readiness
      // check, are what make the product usable.
      "Enter a DEDICATED Anthropic API key under Admin → Integrations (a separate key from the AI help assistant — the keys are never shared).",
      "Set a monthly spend budget on the AI Diagnostics settings. It ships at NZ$0, which hard-stops every paid diagnostics call until you raise it.",
    ],
  },
  alpineCentralServer: {
    key: "alpineCentralServer",
    label: "Alpine Central Server",
    description:
      "Connect this club to the Alpine Central Server (ServerNZ) to upload and download data shared across clubs — starting with the Other Clubs registry. SHARES DATA OUTSIDE THIS CLUB: your lodges' names, locations, bed counts and booking-officer contact details are sent to the central server and redistributed to every other connected club. The booking-officer email is the committee role's shared address, never a member's personal one, and a member's phone is shared only if your club already publishes it on your own committee page. Nothing is sent until you also enable an item on the setup page.",
    dependencies: [
      "Request a connection and obtain an API key from the central server, then enter it under Admin → Integrations → Alpine Central Server.",
    ],
  },
  commsPortal: {
    key: "commsPortal",
    label: "Message board",
    description:
      "A member-written message board for the club. Posts stay inside this club unless a member chooses to share one with every other connected club.",
    dependencies: [
      // Stated because the module is useful on its own and an admin reading
      // this card should not think it needs the central server to work.
      "The board works with no central-server connection: posts are club-only unless a member ticks 'share with all clubs'.",
      "Sharing a post with other clubs additionally needs the Alpine Central Server module switched on and connected.",
      "When off, the member board and its admin screens return Not Found. Existing posts are kept and reappear when it is switched back on.",
    ],
  },
};

export function getEffectiveModuleFlags(
  settings: ModuleSettingsValues,
): FeatureFlags {
  // Modules are controlled solely by the admin Modules page.
  return Object.fromEntries(
    MODULE_KEYS.map((key) => [key, settings[key]]),
  ) as FeatureFlags;
}
