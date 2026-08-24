import { prisma } from "@/lib/prisma";
import { CLUB_TIME_SETTINGS_ID } from "@/lib/club-time-zone";
import { resolveEnvironmentRole } from "@/lib/environment-role";
import { readWithheldApplicationEmail } from "@/lib/environment-safety-withheld";
import { getDefaultLodgeCapacity } from "@/lib/lodge-capacity";
import {
  computeMembershipTypeRateGaps,
  type SetupDatabaseSnapshot,
} from "@/lib/setup-readiness";
import { collapseHutFeeColumns } from "@/lib/public-hut-fee-columns";
import { getXeroTokenReadability } from "@/lib/xero-token-store";
import { getStripeSetupState } from "@/lib/stripe-config";

/**
 * The sentinel a failed `ClubTimeSettings` read resolves to, so "the read did
 * not answer" stays distinguishable from "there is no row" all the way to the
 * readiness check. A symbol rather than a string or a null, so no value the
 * database could hold is able to impersonate it.
 */
const CLUB_TIME_SETTINGS_UNREADABLE: unique symbol = Symbol(
  "club-time-settings-unreadable",
);

/** What the guarded `ClubTimeSettings` read resolves to: a row, no row, or neither. */
type ClubTimeSettingsRead =
  | { timeZone: string }
  | null
  | typeof CLUB_TIME_SETTINGS_UNREADABLE;

/**
 * Build the database half of the setup-readiness snapshot (C8 #1987).
 *
 * Extracted from the /admin/setup route so both the admin API and the
 * `setup:check` CLI resolve DB readiness the same way. Under the DB-first
 * configuration model the club-config and age-tier gates read this snapshot
 * (clubIdentityName / configuredCapacity / ageTierSettingCount) rather than
 * `config/club.json`, so an install configured only in the DB reports as
 * complete without any file on disk. The club-time-zone gate (CT-1, #2989) reads
 * `clubTimeZone` here for the same reason — the club's timezone is database
 * state, never the host's `TZ`.
 *
 * The environment-role gate (ENV-SAFETY 1, #3034) is the one entry here that is
 * not a bare table read: `resolveEnvironmentRole()` combines the deployment's
 * `APP_ENVIRONMENT_ROLE` declaration with the database safer override, and the
 * readiness step is handed the resolved answer rather than the raw halves, so
 * that the checklist and every other consumer cannot disagree about the rule.
 */
export async function getSetupDatabaseSnapshot(): Promise<SetupDatabaseSnapshot> {
  const now = new Date();
  /*
    The environment role (ENV-SAFETY 1, #3034), resolved HERE rather than in
    `setup-readiness.ts` because the resolver reads the database and that module
    is deliberately synchronous over an injected snapshot. `resolveEnvironmentRole`
    never throws — an unreadable override resolves UNKNOWN, which is the answer
    the readiness step then reports — so it needs no `.catch()` of its own and
    cannot take the whole snapshot down.

    It is deliberately NOT inside the `Promise.all` below: that array is one
    `prisma.*` call per element and reads as a list of table reads. Putting a
    composite resolver in it would hide a `process.env` read plus a database read
    inside something that looks like a thirteenth query.
  */
  const environmentRole = await resolveEnvironmentRole();
  /*
    How much application email this installation has held back for
    environment-safety reasons (ENV-SAFETY 1, #3034). Answers
    `{ available: false }` for every installation today; **#3035** creates the
    rows and replaces the body of `readWithheldApplicationEmail`. Read here for
    the same reason as the role above — `setup-readiness.ts` is synchronous over
    an injected snapshot — and outside the `Promise.all` for the same reason too.
  */
  const withheldEmail = await readWithheldApplicationEmail();
  const [
    adminCount,
    adminModuleSettings,
    ageTierSettingCount,
    seasonCount,
    cancellationPolicyCount,
    bookingDefaults,
    groupDiscount,
    membershipCancellationSettings,
    operationalXeroToken,
    xeroAccountMappingCount,
    xeroHutFeeItemMappingCount,
    xeroEntranceFeeMappingCount,
    clubIdentity,
    emailSettings,
    lodgeSettings,
    clubTimeSettings,
    publicContentSettings,
  ] = await Promise.all([
    prisma.member.count({ where: { role: "ADMIN", active: true } }),
    prisma.clubModuleSettings.findUnique({
      where: { id: "default" },
      select: {
        kiosk: true,
        chores: true,
        financeDashboard: true,
        waitlist: true,
        xeroIntegration: true,
        bedAllocation: true,
        internetBankingPayments: true,
        addressAutocomplete: true,
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
        twoFactor: true,
        magicLink: true,
        googleLogin: true,
        analytics: true,
        lobbyDisplay: true,
        aiAssistant: true,
        memberGuests: true,
        aiDiagnostics: true,
        maintenanceReports: true,
        alpineCentralServer: true,
        commsPortal: true,
      },
    }),
    prisma.ageTierSetting.count(),
    prisma.season.count({ where: { active: true } }),
    prisma.cancellationPolicy.count(),
    prisma.bookingDefaults.findUnique({ where: { id: "default" } }),
    prisma.groupDiscountSetting.findUnique({ where: { id: "default" } }),
    prisma.membershipCancellationSetting.findUnique({
      where: { id: "default" },
      select: {
        xeroArchiveContactsOnCancellation: true,
        _count: {
          select: { xeroContactGroups: true },
        },
      },
    }),
    prisma.xeroToken.findFirst({
      orderBy: { updatedAt: "desc" },
      select: { expiresAt: true, accessToken: true },
    }),
    prisma.xeroAccountMapping.count({
      where: {
        OR: [{ code: { not: null } }, { itemCode: { not: null } }],
      },
    }),
    prisma.xeroItemCodeMapping.count({
      where: {
        category: "HUT_FEE",
        itemCode: { not: null },
      },
    }),
    prisma.xeroItemCodeMapping.count({
      where: {
        category: "JOINING_FEE",
        OR: [{ itemCode: { not: null } }, { amountCents: { not: null } }],
      },
    }),
    prisma.clubIdentitySettings.findUnique({
      where: { id: "default" },
      select: { name: true },
    }),
    prisma.emailMessageSetting.findUnique({
      where: { id: "default" },
      select: { clubName: true },
    }),
    prisma.lodgeSettings.findUnique({
      where: { id: "default" },
      select: { capacity: true },
    }),
    // The persisted club timezone (CT-1, #2989). An absent row is the normal
    // pre-first-boot state, not an error, so a null here simply means "not
    // stored yet" and the readiness check says so. Validation is NOT done here —
    // the check itself judges the value, so the snapshot stays a plain report of
    // what the database holds.
    //
    // DEFENSIVE, like `getDefaultLodgeCapacity` and the Xero/Stripe probes below
    // (#2989 review). This is the newest table in the schema, so it is the one
    // most likely to be absent on a database a migration has not reached — and
    // unguarded inside this `Promise.all` that single failure rejects the whole
    // snapshot, which `/admin/setup` renders as a 500 for every step rather than
    // as one unread setting. The failure is reported rather than swallowed to
    // null: "no row yet" carries the remedy "the app records it on the next
    // start", which is not the remedy for a table that does not exist.
    prisma.clubTimeSettings
      .findUnique({
        where: { id: CLUB_TIME_SETTINGS_ID },
        select: { timeZone: true },
      })
      // Annotated so the sentinel keeps its `unique symbol` type through the
      // handler: without it the inferred return widens to `symbol` and the
      // `=== CLUB_TIME_SETTINGS_UNREADABLE` check below stops narrowing.
      .catch((): ClubTimeSettingsRead => CLUB_TIME_SETTINGS_UNREADABLE),
    // Public {{hut-fees}} embed opt-in (#2129). Only when this is ON does the
    // single-rate-column readiness warning below apply.
    prisma.publicContentSettings.findUnique({
      where: { id: "default" },
      select: { hutFees: true },
    }),
  ]);

  // Missing-rate readiness (#1930, E4): every ACTIVE MEMBER_RATE membership
  // type must carry tier-complete rate rows (every bookable age tier, or a
  // flat all-ages row) for every active or future season, or bookings for
  // that type × those dates hard-throw at pricing time. Archived types are
  // skipped — they only price history. The tier-aware coverage rule lives in
  // computeMembershipTypeRateGaps (setup-readiness.ts).
  const [
    memberRateTypes,
    currentAndFutureSeasons,
    existingTypeSeasonRates,
    configuredAgeTiers,
    basedOnAgeTierTypes,
  ] = await Promise.all([
    prisma.membershipType.findMany({
      where: { isActive: true, bookingBehavior: "MEMBER_RATE" },
      select: { id: true, name: true, ageGroupsApply: true },
    }),
    prisma.season.findMany({
      where: { OR: [{ active: true }, { endDate: { gte: now } }] },
      select: { id: true, name: true },
    }),
    prisma.membershipTypeSeasonRate.findMany({
      select: { seasonId: true, membershipTypeId: true, ageTier: true },
    }),
    // The club's actual configured age tiers (#2009). A club may run a SUBSET
    // (e.g. CHILD + ADULT only), and only its present tiers are ever priced —
    // so the rate-gap check must demand rate rows for THOSE tiers, not the full
    // built-in four, or a valid subset club is falsely told it is missing
    // INFANT/YOUTH rates. Empty (unconfigured) → let the check use its default.
    // Also carries subscriptionRequiredForBooking for the #2041
    // BASED_ON_AGE_TIER soft-check.
    prisma.ageTierSetting.findMany({
      select: { tier: true, subscriptionRequiredForBooking: true },
    }),
    // #2041 misconfig soft-check: active types deferring their subscription
    // answer to the age tier.
    prisma.membershipType.findMany({
      where: { isActive: true, subscriptionBehavior: "BASED_ON_AGE_TIER" },
      select: { name: true },
    }),
  ]);
  const bookableAgeTiers = configuredAgeTiers.map((row) => row.tier);
  // Flag a BASED_ON_AGE_TIER type only when age tiers ARE configured (≥1 row)
  // yet none require a subscription — then the type can never invoice or lock
  // anyone. When the table is empty the runtime falls back to defaults (Youth/
  // Adult require), so it is not a misconfig and we leave the list empty.
  const anyTierRequiresSubscription = configuredAgeTiers.some(
    (row) => row.subscriptionRequiredForBooking,
  );
  const basedOnAgeTierTypesWithoutSubscribingTier =
    configuredAgeTiers.length > 0 && !anyTierRequiresSubscription
      ? basedOnAgeTierTypes.map((type) => type.name)
      : [];
  const membershipTypeRateGaps = computeMembershipTypeRateGaps({
    types: memberRateTypes,
    seasons: currentAndFutureSeasons,
    rateRows: existingTypeSeasonRates,
    bookableAgeTiers:
      bookableAgeTiers.length > 0 ? bookableAgeTiers : undefined,
  });

  // Public {{hut-fees}} readiness (#2129): the embed renders one nightly-rate
  // column per publicly-listed active membership type that carries rate rows
  // for the season, with identically-priced types collapsed into one shared
  // column (collapseHutFeeColumns — the same helper the embed itself uses, and
  // fed in the same order, so the warning cannot disagree with what visitors
  // see). A season resolving to fewer than two columns publishes a table with
  // nothing to compare, so it is surfaced on the Seasons And Rates step.
  //
  // Two gates, both required. The toggle alone is not enough: a club that
  // flipped it on while exploring settings, without ever placing the token on a
  // page, would otherwise carry a permanent amber warning about a page block
  // that does not exist.
  const publicHutFeeSingleColumnSeasons: string[] = [];
  const hutFeesTokenPlaced =
    publicContentSettings?.hutFees === true &&
    (await prisma.pageContent.count({
      // Deliberately loose: the token may be written `{{hut-fees}}`,
      // `{{ hut-fees: lodge=... }}` or the legacy single-brace form, so match
      // the name alone. Over-matching (the words in prose) merely keeps the
      // warning visible, which is the safe direction; under-matching would
      // silently suppress a real misconfiguration.
      where: {
        published: true,
        contentHtml: { contains: "hut-fees", mode: "insensitive" },
      },
    })) > 0;
  if (hutFeesTokenPlaced) {
    const publicSeasons = await prisma.season.findMany({
      // Active seasons of ACTIVE lodges only — exactly the set the embed
      // renders, so the warning cannot flag a season no visitor can see.
      where: { active: true, lodge: { active: true } },
      orderBy: [{ startDate: "asc" }, { name: "asc" }],
      select: {
        name: true,
        lodge: { select: { name: true } },
        membershipTypeRates: {
          where: { membershipType: { isActive: true, publiclyListed: true } },
          // Same ordering as the embed's query. The fold is order-independent
          // now, but keeping the two queries identical means a future change to
          // one cannot quietly desynchronise the warning from the page.
          orderBy: [{ ageTier: "asc" }],
          select: {
            ageTier: true,
            pricePerNightCents: true,
            membershipType: {
              select: { id: true, name: true, sortOrder: true, ageGroupsApply: true },
            },
          },
        },
      },
    });
    for (const season of publicSeasons) {
      const byType = new Map<
        string,
        {
          id: string;
          name: string;
          sortOrder: number;
          ageGroupsApply: boolean;
          rates: Array<{ ageTier: string | null; pricePerNightCents: number }>;
        }
      >();
      for (const rate of season.membershipTypeRates) {
        const entry = byType.get(rate.membershipType.id) ?? {
          ...rate.membershipType,
          rates: [],
        };
        entry.rates.push({
          ageTier: rate.ageTier,
          pricePerNightCents: rate.pricePerNightCents,
        });
        byType.set(rate.membershipType.id, entry);
      }
      if (collapseHutFeeColumns([...byType.values()]).length < 2) {
        publicHutFeeSingleColumnSeasons.push(
          `${season.lodge.name} — ${season.name}`,
        );
      }
    }
  }

  const clubIdentityName =
    clubIdentity?.name?.trim() || emailSettings?.clubName?.trim() || null;

  // Resolved default-lodge booking capacity (#1982): 0 means the default lodge
  // has no active beds and no capacity override, so it accepts no bookings — the
  // club-config readiness check warns on it. Guarded because a pre-seed DB has
  // no Lodge row (getDefaultLodgeId throws); we then simply omit the signal.
  let defaultLodgeCapacity: number | null = null;
  try {
    defaultLodgeCapacity = await getDefaultLodgeCapacity(prisma);
  } catch {
    defaultLodgeCapacity = null;
  }

  // Truthful Xero connection state (#2079): a token row that no longer decrypts
  // (env→DB upgrade or an auth-secret change) must read as "needs reconnect",
  // not "connected". The readability probe is side-effect-free (peeks the key,
  // never generates one) and never exposes the token value; a DB/crypto hiccup
  // there must not sink the whole readiness snapshot, so it fails soft to
  // "not needing re-entry" (the connect/expiry checks still gate "connected").
  let operationalXeroNeedsReentry = false;
  if (operationalXeroToken) {
    try {
      operationalXeroNeedsReentry =
        (await getXeroTokenReadability({
          accessToken: operationalXeroToken.accessToken,
        })) === "unreadable";
    } catch {
      operationalXeroNeedsReentry = false;
    }
  }

  // DB-only Stripe credential state (#2082): metadata-only set-flags plus GCM
  // readability. A crypto/DB hiccup here must not sink the whole snapshot, so it
  // fails soft to "unknown" (all false) — the Stripe check then reports the keys
  // as not set rather than crashing readiness.
  let stripeSecretKeySet = false;
  let stripePublishableKeySet = false;
  let stripeWebhookSecretSet = false;
  let stripeNeedsReentry = false;
  try {
    const stripeState = await getStripeSetupState();
    stripeSecretKeySet = stripeState.secretKeySet;
    stripePublishableKeySet = stripeState.publishableKeySet;
    stripeWebhookSecretSet = stripeState.webhookSecretSet;
    stripeNeedsReentry = stripeState.needsReentry;
  } catch {
    stripeSecretKeySet = false;
    stripePublishableKeySet = false;
    stripeWebhookSecretSet = false;
    stripeNeedsReentry = false;
  }

  return {
    adminCount,
    adminModuleSettings,
    ageTierSettingCount,
    seasonCount,
    cancellationPolicyCount,
    bookingDefaultsConfigured: Boolean(bookingDefaults),
    groupDiscountConfigured: Boolean(groupDiscount),
    membershipCancellationSettingsConfigured: Boolean(
      membershipCancellationSettings,
    ),
    membershipCancellationXeroGroupCount:
      membershipCancellationSettings?._count.xeroContactGroups ?? 0,
    membershipCancellationArchiveContacts: Boolean(
      membershipCancellationSettings?.xeroArchiveContactsOnCancellation,
    ),
    operationalXeroConnected: Boolean(
      operationalXeroToken &&
        operationalXeroToken.expiresAt > now &&
        !operationalXeroNeedsReentry,
    ),
    operationalXeroNeedsReentry,
    operationalXeroTokenExpiresAt:
      operationalXeroToken?.expiresAt.toISOString() ?? null,
    stripeSecretKeySet,
    stripePublishableKeySet,
    stripeWebhookSecretSet,
    stripeNeedsReentry,
    xeroAccountMappingCount,
    xeroHutFeeItemMappingCount,
    xeroEntranceFeeMappingCount,
    membershipTypeRateGaps,
    publicHutFeeSingleColumnSeasons,
    basedOnAgeTierTypesWithoutSubscribingTier,
    defaultLodgeCapacity,
    clubIdentityName,
    configuredCapacity: lodgeSettings?.capacity ?? null,
    // Reported EXACTLY as stored, not trimmed or blank-collapsed. A row holding
    // an unusable value must read as "stored but invalid" and not as "not stored
    // yet": the boot backfill keys on the ROW existing, so it will never replace
    // a bad value, and telling the operator "the app will store this on the next
    // boot" would then be untrue.
    clubTimeZone:
      clubTimeSettings === CLUB_TIME_SETTINGS_UNREADABLE
        ? null
        : (clubTimeSettings?.timeZone ?? null),
    clubTimeZoneUnreadable: clubTimeSettings === CLUB_TIME_SETTINGS_UNREADABLE,
    environmentRole,
    withheldEmail,
  };
}
