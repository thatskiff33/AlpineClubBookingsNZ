import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

/**
 * Operator diagnostic — gate-parity contract (#2241).
 *
 * `scripts/diagnose-calendar-access.ts` is the tool `docs/guides/calendar.md`
 * sends an operator to for "why can this person do that?", and it does not call
 * the gates — it RE-DERIVES their answer from the legs so it can print each leg
 * beside the verdict. That re-derivation is a second copy of the rule, and a
 * second copy drifts: it silently kept answering the pre-#2241 question
 * (`viaAdmin || committee`) after the view gate and the module switch were
 * added, so it would have told an operator that an organisation account with a
 * committee assignment "CAN create" when the app refuses it.
 *
 * This test is the alarm on that copy. It asserts the script still consults the
 * module flag and `canViewCalendarEvents`, and that both write verdicts are
 * conjoined with the view gate — so the next change to `calendar-access.ts`
 * that the script does not follow fails CI instead of misleading an operator.
 * It is a source scan, not a behavioural test, because the script is a `tsx`
 * entry point that connects to a database on import.
 */

const SCRIPT_PATH = "scripts/diagnose-calendar-access.ts";

function readScript(): string {
  // Test helper: reads a fixed repo file under process.cwd(); the path is a
  // constant in this file, not user input.
  return readFileSync(path.resolve(process.cwd(), SCRIPT_PATH), "utf8");
}

describe("diagnose-calendar-access mirrors the real calendar gates", () => {
  it("consults the eventsCalendar module flag", () => {
    const source = readScript();

    expect(source).toContain("loadEffectiveModuleFlags");
    expect(source).toContain("modules.eventsCalendar");
  });

  it("consults the organisation view gate rather than re-implementing it", () => {
    const source = readScript();

    expect(source).toContain("canViewCalendarEvents");
    expect(source).toContain('from "@/lib/calendar-access"');
  });

  it("short-circuits both write verdicts on the view gate", () => {
    const source = readScript();

    // The exact shape of `canManageCalendarEvents` / `canEditCalendarEvents` in
    // src/lib/calendar-access.ts: no view, no write.
    expect(source).toContain("const canCreate = canView && (viaAdmin || committee)");
    expect(source).toContain("const canEditDelete = canView && viaAdmin");
  });
});
