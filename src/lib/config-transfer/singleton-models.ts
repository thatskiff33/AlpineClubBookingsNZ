// Model-level completeness for config transfer (#2200). PR #2199 (#2178) proved
// no COLUMN inside a registered singleton is silently dropped. This is the
// MODEL-level analogue: every singleton-shaped Prisma model must be either
// registered for export or named in MODEL_LEVEL_EXCLUSIONS with a reason, so a
// newly added settings singleton cannot silently join config transfer's blind
// spot by default. The guard test enumerates singleton-shaped models
// mechanically from prisma/schema.prisma and fails on any that is neither.

/**
 * "Singleton-shaped" is the id="default" upsert pattern every club-settings
 * singleton uses: a model whose `@id` scalar defaults to the literal string
 * "default", so the app reads/writes exactly one row via `where: { id: "default" }`.
 * That is how this repo identifies its config singletons (see the per-model
 * loaders and `categories/club-settings.ts`). Models keyed by `cuid()`/`uuid()`
 * or by a business unique — e.g. `AgeTierSetting` (`@default(cuid())`, `tier
 * @unique`, one row per age tier) — are NOT singletons and are deliberately out
 * of scope for this guard: they are multi-row tables that, if portable, belong
 * in the natural-key entity mechanism, not the singleton upsert path.
 *
 * The signature is read from prisma/schema.prisma TEXT, not the runtime DMMF,
 * because Prisma 7's client-side DMMF strips `isId`/`default` from fields (only
 * name/kind/type survive). Parsing the schema source is both the authoritative
 * signal and a truly mechanical enumeration.
 */
export function singletonShapedModelNamesFromSchema(schemaText: string): string[] {
  const names: string[] = [];
  let current: string | null = null;
  for (const rawLine of schemaText.split(/\r?\n/)) {
    const line = rawLine.trim();
    const modelMatch = line.match(/^model\s+(\w+)\s*\{/);
    if (modelMatch) {
      current = modelMatch[1];
      continue;
    }
    if (line.startsWith("}")) {
      current = null;
      continue;
    }
    // The id line of a singleton: `id String @id @default("default")`. Tolerate
    // spacing variants inside @default(...) so a reformatted schema can't slip a
    // singleton past the enumeration.
    if (current && /@id\b/.test(line) && /@default\(\s*"default"\s*\)/.test(line)) {
      names.push(current);
    }
  }
  return [...names].sort();
}

/**
 * Singleton-shaped models registered for export OUTSIDE the club-settings
 * category (whose registered set the guard derives mechanically from its own
 * SINGLETONS list). Each maps to a one-line note. Kept small and cross-checked:
 * a guard test asserts every entry is genuinely singleton-shaped AND genuinely a
 * registered entity, so a stale claim of registration fails loudly.
 */
export const SINGLETON_MODELS_REGISTERED_ELSEWHERE: Record<string, string> = {
  ClubTheme:
    "exported as the club-theme singleton in the site-content category " +
    "(seed brand columns; format-version 2 collapse, #2187)",
};

/**
 * Singleton-shaped models DELIBERATELY not exported by config transfer, each with
 * a one-line reason — the model-level analogue of `COMMON_EXCLUDED_COLUMNS` /
 * per-spec `excluded` (#2199). A new singleton-shaped model must be registered or
 * added here, or the completeness guard fails until someone classifies it as
 * portable club policy or instance-local. Every reason must be non-empty and name
 * a real, currently singleton-shaped model (both asserted by the guard test).
 */
export const MODEL_LEVEL_EXCLUSIONS: Record<string, string> = {
  XeroGroupingSettings:
    "Xero member-grouping mode is bound to the SOURCE install's connected Xero " +
    "organisation (tenant) and its contact-group configuration; Xero settings are " +
    "tenant-specific and never travel across installs (see the sealed xero-config " +
    "provenance) — instance-local",
  LodgeSettings:
    "per-lodge physical/operational settings (bed capacity, school-group soft cap) " +
    "keyed to a specific lodge via lodgeId; lodge identity and capacity travel " +
    "through the lodge-config category's Lodge rows, not this singleton — " +
    "instance-local",
  SetupProgress:
    "deployment-local setup-wizard progress (which steps THIS install has " +
    "completed/skipped, and by whom); operational install state, not portable " +
    "club policy — instance-local",
  AiAssistantSettings:
    "deployment-specific AI monthly spend cap (NZD integer cents); an operational " +
    "spend control a source club must never silently reset on a target — a fresh " +
    "import keeps the target's own cap (#2211) — instance-local",
  AnalyticsSettings:
    "the club's Google Analytics configuration (#2573): the GA4 measurement ID is " +
    "bound to THIS install's own Google Analytics property, and importing it would " +
    "silently point a target club's website at the source club's property and mix " +
    "two clubs' traffic in one report. The consent revision counts this install's " +
    "own visitors' choices, and the consent-banner mode is a privacy posture a " +
    "source club must never set on a target's behalf — a fresh import keeps the " +
    "target's own analytics configuration, and a target with none stays off " +
    "(fail-closed) — instance-local",
  DiagnosticsSettings:
    "deployment-local AI Diagnostics monthly spend cap (NZD integer cents) for a " +
    "SEPARATE admin-only paid product (AID-2, #2371); like AiAssistantSettings it " +
    "is an operational spend control a source club must never silently reset on a " +
    "target — enabling paid diagnostics is a per-deployment decision, so a fresh " +
    "import keeps the target's own cap — instance-local",
  MaintenanceReportSettings:
    "maintenance-report policy (#2780) carries anonymousReportsEnabled, the master " +
    "switch for an UNAUTHENTICATED public submit endpoint. Like the AnalyticsSettings " +
    "consent-banner mode, that is a security posture a source club must never set on " +
    "a target's behalf — importing it could silently open a target club's public door. " +
    "The photo-retention window and photo/contact toggles are equally an operational " +
    "posture; a fresh import keeps the target's own settings, and a target with none " +
    "stays fail-closed (anonymous OFF by default) — instance-local",
  ClubTimeSettings:
    "the installation's ONE club timezone (CT-1, #2989): the IANA identifier that " +
    "is this club's sole civil-time authority. It does not travel for the same " +
    "reason it is Full-Admin-only, confirmation-gated and audited in the first " +
    "place — a bundle apply is none of those things, so importing it would move " +
    "every displayed time and every club-local scheduled job on the target club " +
    "with no acknowledgement of the consequences and no before/after audit row " +
    "naming who did it. A fresh import keeps the target's own configured zone, and " +
    "a target that has none keeps resolving the zone it is already effectively " +
    "using (INV-CONFIG-002) — instance-local",
  EnvironmentSafetySettings:
    "the safer environment override (ENV-SAFETY 1, #3034; epic #2986): whether " +
    "THIS installation has been forced to behave as a copy rather than as the " +
    "club's live site. It describes the installation and never portable club " +
    "policy, so it is instance-local by definition — and config transfer is " +
    "precisely the path by which a bundle exported from a staging copy reaches " +
    "the live site, where importing it is harmful in BOTH directions: the " +
    "override ON would silently suppress a target club's live member email, and " +
    "OFF would silently strip a copy's protection while it holds real members' " +
    "real addresses. Either way it would bypass the Full-Admin server-side " +
    "confirmation and the ENVIRONMENT_SAFETY_OVERRIDE_UPDATED audit row the " +
    "admin route enforces — the same ground ClubTimeSettings is excluded on, " +
    "because a bundle apply is none of those things. A fresh import keeps the " +
    "target's own override, and a target with none keeps resolving from its own " +
    "deployment declaration (INV-CONFIG-003) — instance-local",
  ClubPostSettings:
    "club message board retention (#2999) carries retentionDays, the window " +
    "after which a nightly job PERMANENTLY DELETES member posts. Like " +
    "MaintenanceReportSettings' photo-retention window it is an operational " +
    "posture a source club must never set on a target's behalf -- importing a " +
    "non-zero window would start destroying a target club's member content on a " +
    "schedule it never chose, and INV-CONFIG-001 is explicit that the " +
    "keep-everything default exists so an upgrade cannot do that. The cleanup " +
    "bookkeeping beside it (cleanupStartedAt, lastCleanupAt, lastCleanupDeleted) " +
    "is this install's own run history and is meaningless on another -- " +
    "instance-local",
  ServerNzSettings:
    "this install's own Alpine Central Server connection: a base URL bound to the " +
    "server THIS club was issued a key for (the key itself lives in the encrypted " +
    "credential store and never travels), plus the opt-in flag for outward Other " +
    "Clubs sharing and the upload watermark / download cursor that track what THIS " +
    "install has already exchanged. Importing any of it would either point a target " +
    "club at a server it has no key for, enrol it in a data-sharing arrangement it " +
    "never agreed to, or hand it a foreign sync position that silently skips rows " +
    "it has never sent — a fresh import keeps the target's own connection, and a " +
    "target with none stays disconnected (fail-closed) — instance-local",
};

/**
 * Pure partition helper: given every singleton-shaped model name and the set of
 * names that are accounted for (registered or excluded), return the names that
 * are neither. The guard test asserts this is empty for the live schema, and
 * mutation-checks it with synthetic inputs (a fake unclassified model must be
 * returned; removing a real classification must surface that model).
 */
export function unclassifiedSingletonModels(
  allSingletonModelNames: readonly string[],
  accountedFor: ReadonlySet<string>,
): string[] {
  return allSingletonModelNames.filter((name) => !accountedFor.has(name));
}
