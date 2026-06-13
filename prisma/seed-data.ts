// Club-agnostic seed data shared by prisma/seed.ts and the seed tests in
// src/lib/__tests__/seed-account-defaults.test.ts. Everything here must stay
// free of real personal data: names, phone numbers, and emails are clearly
// generic placeholders that a club replaces through the admin screens.

// Placeholder phone number used for every seeded committee entry.
export const SEED_PLACEHOLDER_PHONE = "+64 21 000 0000";

export interface SeedMemberAccountData {
  email: string;
  passwordHash: string;
  firstName: string;
  lastName: string;
  role: "ADMIN" | "LODGE";
  ageTier: "ADULT";
  canLogin: boolean;
  emailVerified: boolean;
  forcePasswordChange: boolean;
}

/**
 * First admin account created from the SEED_ADMIN_* environment variables.
 * canLogin and emailVerified must both be true or the account cannot pass
 * the credentials login flow; forcePasswordChange routes the first login
 * through /change-password.
 */
export function buildSeedAdminMemberData(params: {
  email: string;
  passwordHash: string;
  firstName?: string;
  lastName?: string;
}): SeedMemberAccountData {
  return {
    email: params.email,
    passwordHash: params.passwordHash,
    firstName: params.firstName?.trim() || "Admin",
    lastName: params.lastName?.trim() || "User",
    role: "ADMIN",
    ageTier: "ADULT",
    canLogin: true,
    emailVerified: true,
    forcePasswordChange: true,
  };
}

/** Shared lodge kiosk account created from SEED_LODGE_PASSWORD. */
export function buildSeedLodgeMemberData(params: {
  email: string;
  passwordHash: string;
}): SeedMemberAccountData {
  return {
    email: params.email,
    passwordHash: params.passwordHash,
    firstName: "Lodge",
    lastName: "Kiosk",
    role: "LODGE",
    ageTier: "ADULT",
    canLogin: true,
    emailVerified: true,
    forcePasswordChange: false,
  };
}

export interface SeedCommitteeMember {
  id: string;
  role: string;
  name: string;
  phone: string;
  email: string | null;
  contactKey: string;
  description: string;
  sortOrder: number;
}

/**
 * Generic committee placeholders. Names and phone numbers are deliberately
 * fake; clubs replace them in Admin -> Committee after first login. Emails
 * derive from the deployed club config so they are never hardcoded here.
 * The contact keys feed the public contact form recipient list, and the
 * "bookings" key also powers the booking officer sidebar.
 */
export function buildSeedCommitteePlaceholders(params: {
  domainEmail: (localPart: string) => string;
  contactEmail: string;
}): SeedCommitteeMember[] {
  const placeholders: Array<{
    role: string;
    contactKey: string;
    email: string | null;
    description: string;
  }> = [
    {
      role: "President",
      contactKey: "president",
      email: params.domainEmail("president"),
      description: "Chairs meetings and oversees club operations.",
    },
    {
      role: "Vice President",
      contactKey: "vicePresident",
      email: params.domainEmail("vicePresident"),
      description: "Backup to the President and assists with club operations.",
    },
    {
      role: "Secretary",
      contactKey: "secretary",
      email: params.domainEmail("secretary"),
      description: "Manages club correspondence and meeting minutes.",
    },
    {
      role: "Treasurer",
      contactKey: "treasurer",
      email: params.domainEmail("treasurer"),
      description: "Manages club finances, subscriptions, and accounts.",
    },
    {
      role: "Membership Officer",
      contactKey: "membership",
      email: params.domainEmail("membership"),
      description: "Manages club membership, renewals, and member records.",
    },
    {
      role: "Booking Officer",
      contactKey: "bookings",
      email: params.contactEmail,
      description:
        "Manages lodge bookings, confirms non-member stays, and handles booking enquiries.",
    },
    {
      role: "Custodian",
      contactKey: "custodian",
      email: params.domainEmail("custodian"),
      description: "Responsible for the care and maintenance of club property.",
    },
  ];

  return placeholders.map((entry, sortOrder) => ({
    id: `seed-committee-${entry.contactKey}`,
    role: entry.role,
    name: `Example ${entry.role}`,
    phone: SEED_PLACEHOLDER_PHONE,
    email: entry.email,
    contactKey: entry.contactKey,
    description: entry.description,
    sortOrder,
  }));
}

export interface SeedChoreTemplate {
  name: string;
  description: string;
  recommendedPeopleMin: number;
  recommendedPeopleMax: number;
  isEssential: boolean;
  ageRestriction:
    | "ANY"
    | "ADULTS_ONLY"
    | "MIXED_PREFERRED"
    | "ADULT_SUPERVISED";
  conditionalNote: string | null;
  minAge: number;
  sortOrder: number;
  timeOfDay: "MORNING" | "EVENING" | "ANYTIME";
  frequencyMode: "DAILY" | "EVERY_X_DAYS" | "SPECIFIC_DAYS";
  frequencyDays: number | null;
  frequencyDaysOfWeek: number[];
}

/**
 * Example chore templates for a typical alpine club lodge. Descriptions are
 * intentionally location-neutral; clubs edit or replace them in
 * Admin -> Chores after setup.
 */
export function buildSeedChoreTemplates(): SeedChoreTemplate[] {
  return [
    {
      name: "Breakfast",
      description: "Prepare, cook and serve",
      recommendedPeopleMin: 2,
      recommendedPeopleMax: 2,
      isEssential: true,
      ageRestriction: "ADULTS_ONLY",
      conditionalNote: null,
      minAge: 18,
      sortOrder: 1,
      timeOfDay: "MORNING",
      frequencyMode: "DAILY",
      frequencyDays: null,
      frequencyDaysOfWeek: [],
    },
    {
      name: "Fridge",
      description: "Clear out old food and clean",
      recommendedPeopleMin: 1,
      recommendedPeopleMax: 1,
      isEssential: false,
      ageRestriction: "ADULTS_ONLY",
      conditionalNote: "Essential if closing down lodge",
      minAge: 18,
      sortOrder: 2,
      timeOfDay: "MORNING",
      frequencyMode: "DAILY",
      frequencyDays: null,
      frequencyDaysOfWeek: [],
    },
    {
      name: "Breakfast dishes",
      description: "Wash, dry, put away and wipe tables",
      recommendedPeopleMin: 4,
      recommendedPeopleMax: 4,
      isEssential: true,
      ageRestriction: "MIXED_PREFERRED",
      conditionalNote: null,
      minAge: 0,
      sortOrder: 3,
      timeOfDay: "MORNING",
      frequencyMode: "DAILY",
      frequencyDays: null,
      frequencyDaysOfWeek: [],
    },
    {
      name: "Dining room and kitchen floor",
      description: "Sweep and mop",
      recommendedPeopleMin: 1,
      recommendedPeopleMax: 1,
      isEssential: true,
      ageRestriction: "ANY",
      conditionalNote: null,
      minAge: 0,
      sortOrder: 4,
      timeOfDay: "MORNING",
      frequencyMode: "DAILY",
      frequencyDays: null,
      frequencyDaysOfWeek: [],
    },
    {
      name: "Oven, microwave and hob",
      description: "Clean (may be combined with dishes)",
      recommendedPeopleMin: 1,
      recommendedPeopleMax: 1,
      isEssential: false,
      ageRestriction: "ANY",
      conditionalNote: null,
      minAge: 0,
      sortOrder: 5,
      timeOfDay: "MORNING",
      frequencyMode: "DAILY",
      frequencyDays: null,
      frequencyDaysOfWeek: [],
    },
    {
      name: "Tea towels",
      description:
        "Boil, wring and hang in drying room; when dry, fold and put away",
      recommendedPeopleMin: 1,
      recommendedPeopleMax: 1,
      isEssential: false,
      ageRestriction: "ADULTS_ONLY",
      conditionalNote: "Involves boiling water and heavy pot",
      minAge: 18,
      sortOrder: 6,
      timeOfDay: "MORNING",
      frequencyMode: "DAILY",
      frequencyDays: null,
      frequencyDaysOfWeek: [],
    },
    {
      name: "Firewood",
      description:
        "Fill wood cupboard, cut kindling, clean hearth, empty ash to the outdoor ash bin (keep lid closed)",
      recommendedPeopleMin: 1,
      recommendedPeopleMax: 2,
      isEssential: false,
      ageRestriction: "ADULT_SUPERVISED",
      conditionalNote:
        "Adult or responsible teenager required. Children under 7 can assist alongside 1-2 youth or 1 adult",
      minAge: 7,
      sortOrder: 7,
      timeOfDay: "ANYTIME",
      frequencyMode: "DAILY",
      frequencyDays: null,
      frequencyDaysOfWeek: [],
    },
    {
      name: "Rubbish",
      description:
        "Check kitchen, bathrooms and ski room. Take all rubbish and recycling to the local recycling or transfer station. Line bins and wipe spills. Check with stores person re food needs. Cold ashes can go with rubbish.",
      recommendedPeopleMin: 1,
      recommendedPeopleMax: 1,
      isEssential: true,
      ageRestriction: "ADULTS_ONLY",
      conditionalNote: null,
      minAge: 18,
      sortOrder: 8,
      timeOfDay: "ANYTIME",
      frequencyMode: "DAILY",
      frequencyDays: null,
      frequencyDaysOfWeek: [],
    },
    {
      name: "Dinner",
      description: "Cook and serve",
      recommendedPeopleMin: 2,
      recommendedPeopleMax: 3,
      isEssential: true,
      ageRestriction: "ADULTS_ONLY",
      conditionalNote: null,
      minAge: 18,
      sortOrder: 9,
      timeOfDay: "EVENING",
      frequencyMode: "DAILY",
      frequencyDays: null,
      frequencyDaysOfWeek: [],
    },
    {
      name: "Pre-dinner dishes",
      description: "Wash, dry and put away",
      recommendedPeopleMin: 2,
      recommendedPeopleMax: 2,
      isEssential: false,
      ageRestriction: "ANY",
      conditionalNote: "Only required for full lodge",
      minAge: 0,
      sortOrder: 10,
      timeOfDay: "EVENING",
      frequencyMode: "DAILY",
      frequencyDays: null,
      frequencyDaysOfWeek: [],
    },
    {
      name: "Dinner dishes",
      description:
        "Wash, dry, put away and wipe tables. Includes pots and pans.",
      recommendedPeopleMin: 4,
      recommendedPeopleMax: 6,
      isEssential: true,
      ageRestriction: "MIXED_PREFERRED",
      conditionalNote: null,
      minAge: 0,
      sortOrder: 11,
      timeOfDay: "EVENING",
      frequencyMode: "DAILY",
      frequencyDays: null,
      frequencyDaysOfWeek: [],
    },
    {
      name: "Women's bathroom and toilets",
      description:
        "Clean toilets and all surfaces including inside showers. Glass clean mirror.",
      recommendedPeopleMin: 2,
      recommendedPeopleMax: 2,
      isEssential: true,
      ageRestriction: "MIXED_PREFERRED",
      conditionalNote: "Ideal pairing: adult + child",
      minAge: 0,
      sortOrder: 12,
      timeOfDay: "ANYTIME",
      frequencyMode: "DAILY",
      frequencyDays: null,
      frequencyDaysOfWeek: [],
    },
    {
      name: "Men's bathroom and toilets",
      description:
        "Clean toilets and all surfaces including inside showers. Glass clean mirror.",
      recommendedPeopleMin: 2,
      recommendedPeopleMax: 2,
      isEssential: true,
      ageRestriction: "MIXED_PREFERRED",
      conditionalNote: "Ideal pairing: adult + child",
      minAge: 0,
      sortOrder: 13,
      timeOfDay: "ANYTIME",
      frequencyMode: "DAILY",
      frequencyDays: null,
      frequencyDaysOfWeek: [],
    },
    {
      name: "Ski room, drying room and foyer",
      description: "Sweep and mop. Tip dirty water outside, away from paths.",
      recommendedPeopleMin: 1,
      recommendedPeopleMax: 1,
      isEssential: false,
      ageRestriction: "ANY",
      conditionalNote: null,
      minAge: 0,
      sortOrder: 14,
      timeOfDay: "ANYTIME",
      frequencyMode: "DAILY",
      frequencyDays: null,
      frequencyDaysOfWeek: [],
    },
    {
      name: "Lounge",
      description:
        "Vacuum floors, wipe up dust, wipe moisture from window sills",
      recommendedPeopleMin: 1,
      recommendedPeopleMax: 2,
      isEssential: false,
      ageRestriction: "ANY",
      conditionalNote: null,
      minAge: 0,
      sortOrder: 15,
      timeOfDay: "ANYTIME",
      frequencyMode: "DAILY",
      frequencyDays: null,
      frequencyDaysOfWeek: [],
    },
    {
      name: "Bunkrooms, corridor, stairs and dining room carpet",
      description:
        "Vacuum floors, wipe up dust, wipe moisture from window sills",
      recommendedPeopleMin: 1,
      recommendedPeopleMax: 1,
      isEssential: false,
      ageRestriction: "ANY",
      conditionalNote: null,
      minAge: 0,
      sortOrder: 16,
      timeOfDay: "ANYTIME",
      frequencyMode: "DAILY",
      frequencyDays: null,
      frequencyDaysOfWeek: [],
    },
    {
      name: "Stores",
      description:
        "Stocktake ready for the regular supply order. Pick up stores on resupply days as required.",
      recommendedPeopleMin: 1,
      recommendedPeopleMax: 2,
      isEssential: true,
      ageRestriction: "ADULTS_ONLY",
      conditionalNote: null,
      minAge: 18,
      sortOrder: 17,
      timeOfDay: "ANYTIME",
      frequencyMode: "SPECIFIC_DAYS",
      frequencyDays: null,
      frequencyDaysOfWeek: [1, 4, 5, 7],
    },
  ];
}
