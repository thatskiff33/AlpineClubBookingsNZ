import { describe, expect, it } from "vitest";
import {
  DISPLAY_WIZARD_ID,
  DISPLAY_WIZARD_STEP_IDS,
  boundTemplateId,
  isBoardStepVerified,
  isBoardsStepVerified,
  isConfigStepVerified,
  isDoneStepVerified,
  isLodgeUnresolved,
  isModuleStepVerified,
  isPairStepVerified,
  liveDevicesForLodge,
  pendingDeviceForLodge,
  savedConfigKeys,
  shouldLeadWithSetupCard,
  type DisplayWizardContext,
  type DisplayWizardDevice,
} from "../display-wizard-state";

// The wizard's gates ARE its correctness surface: the shell re-runs every one of
// these against live server truth on each render, so a gate that reads local
// state (or reads the wrong row) silently lets an operator "finish" setup with
// nothing on the wall.

function makeContext(
  overrides: Partial<DisplayWizardContext> = {},
): DisplayWizardContext {
  return {
    moduleEnabled: true,
    templates: [],
    devices: [],
    lodges: [{ id: "lodge-1", name: "Ruapehu Lodge" }],
    lodgeId: "lodge-1",
    lodgeConfig: {
      lodgeId: "lodge-1",
      lodgeName: "Ruapehu Lodge",
      displayConfig: {},
      unrepresentableConfigKeys: [],
      displayNotice: null,
    },
    loaded: true,
    moduleBlockedReads: false,
    ...overrides,
  };
}

function makeDevice(
  overrides: Partial<DisplayWizardDevice> = {},
): DisplayWizardDevice {
  return {
    id: "device-1",
    name: "Lobby TV",
    lodgeId: "lodge-1",
    lodgeName: "Ruapehu Lodge",
    templateId: null,
    templateName: null,
    paired: true,
    pairingArmedUntil: null,
    lastSeenAt: null,
    revoked: false,
    ...overrides,
  };
}

const template = {
  id: "tpl-1",
  key: "everyday-board",
  name: "Everyday board",
  layout: { id: "lay-1", key: "everyday-board", name: "Everyday board" },
  deviceCount: 0,
};

describe("display wizard step ids", () => {
  it("is the owner's signed-off order — authoring first, the TV last", () => {
    expect([...DISPLAY_WIZARD_STEP_IDS]).toEqual([
      "module",
      "boards",
      "board",
      "config",
      "pair",
      "done",
    ]);
    // The id the cursor persists under; it must stay on the route allowlist.
    expect(DISPLAY_WIZARD_ID).toBe("display");
  });
});

describe("step 1 — module", () => {
  it("tracks the module flag and nothing else", () => {
    expect(isModuleStepVerified(makeContext({ moduleEnabled: true }))).toBe(
      true,
    );
    expect(isModuleStepVerified(makeContext({ moduleEnabled: false }))).toBe(
      false,
    );
  });
});

describe("step 2 — built-in boards", () => {
  it("verifies on any template, restored or hand-authored", () => {
    expect(isBoardsStepVerified(makeContext({ templates: [template] }))).toBe(
      true,
    );
    expect(isBoardsStepVerified(makeContext({ templates: [] }))).toBe(false);
  });

  it("does not verify before the lists have loaded", () => {
    // An unloaded context has an empty template list for a different reason;
    // reading it as "no boards" would flash the restore prompt at a club that
    // has seven.
    expect(
      isBoardsStepVerified(makeContext({ templates: [], loaded: false })),
    ).toBe(false);
  });
});

describe("step 3 — pick the board", () => {
  it("verifies only once a LIVE screen is bound to a named board", () => {
    const chosenButUnbound = makeContext({ templates: [template] });
    expect(isBoardStepVerified(chosenButUnbound)).toBe(false);

    const bound = makeContext({
      templates: [template],
      devices: [
        makeDevice({ templateId: "tpl-1", templateName: "Everyday board" }),
      ],
    });
    expect(isBoardStepVerified(bound)).toBe(true);
    expect(boundTemplateId(bound)).toBe("tpl-1");
  });

  it("ignores an unpaired or revoked screen, and screens at other lodges", () => {
    expect(
      boundTemplateId(
        makeContext({
          devices: [makeDevice({ templateId: "tpl-1", paired: false })],
        }),
      ),
    ).toBeNull();
    expect(
      boundTemplateId(
        makeContext({
          devices: [makeDevice({ templateId: "tpl-1", revoked: true })],
        }),
      ),
    ).toBeNull();
    expect(
      boundTemplateId(
        makeContext({
          devices: [makeDevice({ templateId: "tpl-1", lodgeId: "lodge-2" })],
        }),
      ),
    ).toBeNull();
  });

  // #2249 review M4. This used to fall back to "every lodge" when no lodge had
  // been resolved (the lodges fetch failed, or the club has no active lodge),
  // which let a screen at ANOTHER lodge tick this lodge's steps off and let the
  // pairing step adopt a device belonging somewhere else. An unresolved lodge is
  // now a blocking state that reads nothing at all.
  it("reads NO screens while no lodge has been resolved, and says so", () => {
    const context = makeContext({
      lodgeId: null,
      devices: [
        makeDevice({ lodgeId: "lodge-9", templateId: "tpl-1" }),
        makeDevice({ id: "device-2", lodgeId: "lodge-9", paired: false }),
      ],
    });
    expect(isLodgeUnresolved(context)).toBe(true);
    expect(liveDevicesForLodge(context)).toEqual([]);
    expect(pendingDeviceForLodge(context)).toBeNull();
    expect(boundTemplateId(context)).toBeNull();
    expect(isBoardStepVerified(context)).toBe(false);
    expect(isPairStepVerified(context)).toBe(false);
    expect(isDoneStepVerified(context)).toBe(false);
  });

  it("is not 'unresolved' before the reads have settled", () => {
    // Mid-load there is no lodge yet either, but that is a loading state, not a
    // failure to report — the steps must not flash the blocking notice.
    expect(
      isLodgeUnresolved(makeContext({ lodgeId: null, loaded: false })),
    ).toBe(false);
  });

  it("finds only THIS lodge's screen awaiting pairing", () => {
    const context = makeContext({
      devices: [
        makeDevice({ id: "other-lodge", lodgeId: "lodge-2", paired: false }),
        makeDevice({ id: "revoked", paired: false, revoked: true }),
        makeDevice({ id: "ours", paired: false }),
      ],
    });
    expect(pendingDeviceForLodge(context)?.id).toBe("ours");
  });
});

describe("step 4 — lodge details", () => {
  it("verifies on a saved config value or a notice", () => {
    expect(isConfigStepVerified(makeContext())).toBe(false);
    expect(
      isConfigStepVerified(
        makeContext({
          lodgeConfig: {
            lodgeId: "lodge-1",
            lodgeName: "Ruapehu Lodge",
            displayConfig: { "wifi-name": "RUAPEHU-GUEST" },
            unrepresentableConfigKeys: [],
            displayNotice: null,
          },
        }),
      ),
    ).toBe(true);
    expect(
      isConfigStepVerified(
        makeContext({
          lodgeConfig: {
            lodgeId: "lodge-1",
            lodgeName: "Ruapehu Lodge",
            displayConfig: {},
            unrepresentableConfigKeys: [],
            displayNotice: "Lights out 10:30pm",
          },
        }),
      ),
    ).toBe(true);
  });

  it("treats a blank value as no value", () => {
    const context = makeContext({
      lodgeConfig: {
        lodgeId: "lodge-1",
        lodgeName: "Ruapehu Lodge",
        displayConfig: { "wifi-code": "   " },
        unrepresentableConfigKeys: [],
        displayNotice: "  ",
      },
    });
    expect(savedConfigKeys(context)).toEqual([]);
    expect(isConfigStepVerified(context)).toBe(false);
  });

  it("cannot verify while the lodge config could not be read", () => {
    expect(isConfigStepVerified(makeContext({ lodgeConfig: null }))).toBe(
      false,
    );
  });
});

describe("steps 5 and 6 — pair, then proof it works", () => {
  it("pairing verifies on a live screen, done needs the screen to have checked in", () => {
    const paired = makeContext({ devices: [makeDevice()] });
    expect(isPairStepVerified(paired)).toBe(true);
    // Deliberately a STRONGER gate: an admin-side pairing that the TV never
    // acted on leaves a blank wall, and "done" must not claim otherwise.
    expect(isDoneStepVerified(paired)).toBe(false);

    const seen = makeContext({
      devices: [makeDevice({ lastSeenAt: "2026-07-29T09:41:00.000Z" })],
    });
    expect(isDoneStepVerified(seen)).toBe(true);
  });

  it("a revoked screen is neither paired nor done", () => {
    const revoked = makeContext({
      devices: [
        makeDevice({ revoked: true, lastSeenAt: "2026-07-29T09:41:00.000Z" }),
      ],
    });
    expect(isPairStepVerified(revoked)).toBe(false);
    expect(isDoneStepVerified(revoked)).toBe(false);
  });
});

describe("hub entry card", () => {
  it("leads while boards OR working screens are missing, and steps back once both exist", () => {
    expect(
      shouldLeadWithSetupCard({ templateCount: 0, pairedDeviceCount: 0 }),
    ).toBe(true);
    expect(
      shouldLeadWithSetupCard({ templateCount: 7, pairedDeviceCount: 0 }),
    ).toBe(true);
    expect(
      shouldLeadWithSetupCard({ templateCount: 0, pairedDeviceCount: 1 }),
    ).toBe(true);
    expect(
      shouldLeadWithSetupCard({ templateCount: 7, pairedDeviceCount: 1 }),
    ).toBe(false);
  });
});
