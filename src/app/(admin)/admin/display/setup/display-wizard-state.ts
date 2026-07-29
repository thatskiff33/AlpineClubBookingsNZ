/**
 * Derived state + step gates for the Lodge Display guided setup wizard (#2249).
 *
 * Deliberately PURE and framework-free so every gate can be unit-tested without
 * rendering: the wizard shell (`IntegrationWizard`, #2080) calls each step's
 * `isVerified(context)` against live server truth on every render, so these
 * predicates ARE the wizard's correctness surface.
 *
 * Step order is the owner's signed-off order (29 Jul 2026) — authoring first,
 * the TV hung last:
 *
 *   module → boards → board → config → pair → done
 *
 * That order changed from the mockup (which paired at step 4). The reason it
 * matters here is that "pick a board" now happens BEFORE anything server-side
 * records the choice: a board is only bound to a device at pairing. So the
 * board step's gate cannot read a "chosen board" — there is no such row — and
 * inventing one (local form state, or a flag persisted in the cursor) would be
 * exactly the fake verification the shell contract forbids. It is instead an
 * OPTIONAL step whose gate is the real binding, satisfied at pairing; the pick
 * made on it is carried forward in memory and pre-selects the binding on the
 * pairing step.
 */

/** A template (a board's content) as the admin templates list returns it. */
export interface DisplayWizardTemplate {
  id: string;
  key: string;
  name: string;
  layout: { id: string; key: string; name: string };
  deviceCount: number;
}

/** A lobby screen record as the admin devices list returns it. */
export interface DisplayWizardDevice {
  id: string;
  name: string;
  lodgeId: string;
  lodgeName: string;
  templateId: string | null;
  templateName: string | null;
  paired: boolean;
  pairingArmedUntil: string | null;
  lastSeenAt: string | null;
  revoked: boolean;
}

export interface DisplayWizardLodge {
  id: string;
  name: string;
}

/** The per-lodge display settings the config quick-set step edits. */
export interface DisplayWizardLodgeConfig {
  lodgeId: string;
  lodgeName: string;
  /** The text values — everything the quick-set can faithfully show and re-post. */
  displayConfig: Record<string, string>;
  /**
   * Keys saved on this lodge whose value is NOT text. `displayConfig` is a JSON
   * column, so a hand-edited (or imported) row can hold a number, a list or an
   * object; the lodge-config route accepts string values ONLY, and it replaces
   * the whole object on every write.
   *
   * That combination means such a value cannot survive a save from this step —
   * re-posting it verbatim is refused with a 400, and omitting it deletes it.
   * The keys are carried here so the step can SAY that before the operator
   * saves, rather than dropping them quietly (#2249 review L7).
   */
  unrepresentableConfigKeys: string[];
  displayNotice: string | null;
}

/**
 * Everything the six steps verify against. Assembled by
 * `useDisplayWizardContext` from the module flag (server-rendered) plus the
 * four existing admin display reads — the wizard adds NO new server surface.
 */
export interface DisplayWizardContext {
  /** The `lobbyDisplay` module flag, resolved server-side on the page. */
  moduleEnabled: boolean;
  templates: DisplayWizardTemplate[];
  devices: DisplayWizardDevice[];
  lodges: DisplayWizardLodge[];
  /** The lodge the wizard is setting up (defaults to the first active lodge). */
  lodgeId: string | null;
  lodgeConfig: DisplayWizardLodgeConfig | null;
  /**
   * True once the display reads have settled at least once. Before that the
   * counts below are all zero, which must not be read as "nothing exists".
   */
  loaded: boolean;
  /**
   * True when the display API refused the reads because the module is off (it
   * 404s the whole `/api/admin/display/*` tree). The wizard page itself is
   * exempt from that gate, so this is an expected state on step 1 — not an
   * error to report.
   */
  moduleBlockedReads: boolean;
}

/** A device that is paired and not revoked — i.e. a screen that can be serving. */
export function isLiveDevice(device: DisplayWizardDevice): boolean {
  return device.paired && !device.revoked;
}

/**
 * True once the reads have settled but no lodge could be resolved — the lodges
 * list failed, or the club has no active lodge.
 *
 * This is a BLOCKING state for steps 3–6, not a wildcard. An unresolved lodge
 * used to widen every device query to "any lodge", which meant another lodge's
 * screen could tick this lodge's steps off and the pairing step could adopt a
 * device belonging to somewhere else entirely. Reading nothing is the honest
 * answer: the operator is told to reload rather than shown someone else's TV.
 */
export function isLodgeUnresolved(context: DisplayWizardContext): boolean {
  return context.loaded && context.lodgeId === null;
}

/**
 * Live devices for the lodge being set up. EMPTY while no lodge is resolved —
 * see {@link isLodgeUnresolved}; the steps render a blocking notice in that
 * state rather than verifying against another lodge's screens.
 */
export function liveDevicesForLodge(
  context: DisplayWizardContext,
): DisplayWizardDevice[] {
  if (context.lodgeId === null) return [];
  return context.devices.filter(
    (device) => isLiveDevice(device) && device.lodgeId === context.lodgeId,
  );
}

/**
 * The screen record for THIS lodge that is awaiting pairing, if any. The wizard
 * creates one and re-arms it, so a mistyped code does not litter the club with
 * half-created screens. Null while no lodge is resolved, for the same reason
 * {@link liveDevicesForLodge} is empty there.
 */
export function pendingDeviceForLodge(
  context: DisplayWizardContext,
): DisplayWizardDevice | null {
  if (context.lodgeId === null) return null;
  return (
    context.devices.find(
      (device) =>
        !device.paired &&
        !device.revoked &&
        device.lodgeId === context.lodgeId,
    ) ?? null
  );
}

/**
 * The board a live screen for this lodge is actually bound to, or null when
 * none is (either nothing is paired yet, or every paired screen is on the club
 * default rather than a named template).
 */
export function boundTemplateId(context: DisplayWizardContext): string | null {
  return (
    liveDevicesForLodge(context).find((device) => device.templateId !== null)
      ?.templateId ?? null
  );
}

/** Config keys with a non-blank value saved on the lodge being set up. */
export function savedConfigKeys(context: DisplayWizardContext): string[] {
  const config = context.lodgeConfig?.displayConfig ?? {};
  return Object.keys(config)
    .filter((key) => (config[key] ?? "").trim() !== "")
    .sort();
}

// ---------------------------------------------------------------------------
// Step gates. Each reads ONLY server truth carried on the context.
// ---------------------------------------------------------------------------

/** Step 1 — the `lobbyDisplay` module flag is on. */
export function isModuleStepVerified(context: DisplayWizardContext): boolean {
  return context.moduleEnabled;
}

/**
 * Step 2 — at least one template exists. A club that already authored its own
 * boards is verified here without pressing Restore, which is the point: the
 * restore action is offered, never forced (#2247 is restore-only, never an
 * auto-seed).
 */
export function isBoardsStepVerified(context: DisplayWizardContext): boolean {
  return context.loaded && context.templates.length > 0;
}

/**
 * Step 3 — a live screen for this lodge is bound to a named board. Nothing
 * records the pick before pairing, so this is unsatisfiable until step 5; the
 * step is OPTIONAL so the operator can carry their choice forward and move on.
 */
export function isBoardStepVerified(context: DisplayWizardContext): boolean {
  return boundTemplateId(context) !== null;
}

/**
 * Step 4 — the lodge has at least one display value saved (a `{{config:…}}`
 * value or the notice). Optional: a club whose boards use no config tokens has
 * nothing legitimate to fill in here.
 */
export function isConfigStepVerified(context: DisplayWizardContext): boolean {
  if (!context.lodgeConfig) return false;
  return (
    savedConfigKeys(context).length > 0 ||
    (context.lodgeConfig.displayNotice ?? "").trim() !== ""
  );
}

/** Step 5 — a screen for this lodge is paired and not revoked. */
export function isPairStepVerified(context: DisplayWizardContext): boolean {
  return liveDevicesForLodge(context).length > 0;
}

/**
 * Step 6 — a paired screen has actually CHECKED IN (`lastSeenAt`). This is a
 * genuinely stronger gate than step 5, and the only evidence the admin has that
 * the whole path works end to end: the TV fetched state with its own token.
 */
export function isDoneStepVerified(context: DisplayWizardContext): boolean {
  return liveDevicesForLodge(context).some(
    (device) => device.lastSeenAt !== null,
  );
}

/** Stable step ids — persisted as the resume cursor and used in `?step=` links. */
export const DISPLAY_WIZARD_STEP_IDS = [
  "module",
  "boards",
  "board",
  "config",
  "pair",
  "done",
] as const;

/** The wizard id the cursor is persisted under (allowlisted on the route). */
export const DISPLAY_WIZARD_ID = "display";

/** Where the wizard lives. A hard `<a>` is not required — it frames nothing. */
export const DISPLAY_WIZARD_HREF = "/admin/display/setup";

/**
 * Whether the Lobby Display hub should LEAD with the guided-setup card
 * (#2249, owner decision 29 Jul 2026: "while boards or devices are missing").
 *
 * Counted server-side on the hub. `pairedDeviceCount` counts only screens that
 * are paired and not revoked — a device row created but never paired is not a
 * working screen, and a club in that state still needs the guided path.
 */
export function shouldLeadWithSetupCard(counts: {
  templateCount: number;
  pairedDeviceCount: number;
}): boolean {
  return counts.templateCount === 0 || counts.pairedDeviceCount === 0;
}

/**
 * The shared-cursor sentence, stated on every step.
 *
 * `IntegrationWizardProgress.wizardId` is globally unique, so one row holds the
 * position for the whole install. The owner accepted that (28 Jul 2026) rather
 * than take a schema change for a resume hint — on the condition it is said out
 * loud rather than left as a surprise between two admins.
 */
export const DISPLAY_WIZARD_SHARED_CURSOR_NOTE =
  "Where you got to is saved for the whole club, not for you personally — " +
  "another admin opening this wizard resumes from the same step, and every " +
  "step re-checks the real state of your club, so nothing can be ticked off " +
  "that has not actually happened.";
