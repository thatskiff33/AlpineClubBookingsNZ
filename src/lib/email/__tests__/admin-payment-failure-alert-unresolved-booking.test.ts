import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The payment-anomaly alert must still be DELIVERED when its booking cannot be
 * resolved (#3113 review).
 *
 * WHY THIS FILE EXISTS. Three senders raise this alert from a money event whose
 * booking they could not look up — a superseded group-settlement intent, a paid
 * settlement invoice whose group detail has gone, a stalled recovery queue — and
 * they used to fill the gap with `?? new Date()`. Once the check-in/check-out
 * tokens moved onto `emailCalendarDay`, which correctly REFUSES a wall-clock
 * instant, that fallback started throwing. Both live callers wrap the send in a
 * `catch` that only logs, so nothing surfaced: the alert was simply deleted, and
 * on the Stripe path it was deleted again on every webhook retry. That alert is
 * the only notice that an organiser has been charged with nothing settled.
 *
 * So the property pinned here is not a string but a delivery: an absent night
 * renders "Unknown" and the mail still goes out. The webhook suite mocks this
 * sender away, which is why it is pinned at the sender — the same reason its
 * two late-capture siblings in this directory have their own files
 * (`admin-late-capture-auto-refund-alert.test.ts` and
 * `admin-late-capture-hand-back-conflict-alert.test.ts`).
 *
 * MUTATION PROOF (measured, each restored by byte backup):
 *  - make `emailCalendarDayOrUnknown` return "" for null and "names the two
 *    rows it cannot fill" fails;
 *  - give it a try/catch that answers "Unknown" for any refusal and "keeps the
 *    wrong-KIND refusal" fails;
 *  - restore `?? new Date()` at any of the three call sites and "no caller
 *    invents a date it does not have" fails.
 */

const mocks = vi.hoisted(() => ({
  sendToAdmins: vi.fn(),
  sendUnmuteableAdminAlert: vi.fn(),
}));

vi.mock("@/lib/email/admin-alerts-shared", () => ({
  sendToAdmins: mocks.sendToAdmins,
  sendUnmuteableAdminAlert: mocks.sendUnmuteableAdminAlert,
}));

import { sendAdminPaymentFailureAlert } from "@/lib/email/admin-alerts-finance";

type Captured = {
  subject: string;
  html: string;
  templateName: string;
  templateData: Record<string, unknown>;
};

function captured(): Captured {
  expect(mocks.sendToAdmins).toHaveBeenCalledTimes(1);
  return mocks.sendToAdmins.mock.calls[0][0] as Captured;
}

/** The stored lodge night a resolvable booking would have supplied. */
const STORED_NIGHT = new Date("2026-08-01T00:00:00.000Z");

async function send(dates: { checkIn: Date | null; checkOut: Date | null }) {
  await sendAdminPaymentFailureAlert({
    memberName: "Unknown group organiser",
    ...dates,
    amountCents: 12_345,
    errorMessage: "Group settlement payment failed.",
    paymentIntentId: "pi_test_1",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the payment-anomaly alert with no resolvable booking", () => {
  it("still sends, and names the two rows it cannot fill", async () => {
    await expect(send({ checkIn: null, checkOut: null })).resolves.toBeUndefined();

    const alert = captured();
    expect(alert.templateName).toBe("admin-payment-failure");
    // Both rendering paths: the hand-built body an operator has not edited, and
    // the templateData an operator's saved override is rebuilt from. #3113 is
    // about these two disagreeing, so neither may be left unasserted.
    expect(alert.templateData.checkIn).toBe("Unknown");
    expect(alert.templateData.checkOut).toBe("Unknown");
    expect(alert.html).toContain("Unknown");
    // And the alert still carries the part an officer acts on.
    expect(alert.html).toContain("pi_test_1");
  });

  it("renders a real stored night normally, so the null path did not replace it", async () => {
    await send({ checkIn: STORED_NIGHT, checkOut: STORED_NIGHT });
    const alert = captured();
    expect(alert.templateData.checkIn).toBe("1 Aug 2026");
    expect(alert.html).toContain("1 Aug 2026");
  });

  it("keeps the wrong-KIND refusal: a real timestamp is still rejected", async () => {
    // The nullable field exists so a sender can say "I do not have this night".
    // If it also swallowed a value of the wrong kind it would become the quiet
    // way round the guard, and the next synthesised instant would mail a
    // plausible wrong lodge night instead of failing.
    await expect(
      send({
        checkIn: new Date("2026-08-01T09:30:00.000Z"),
        checkOut: STORED_NIGHT,
      }),
    ).rejects.toThrow(RangeError);
  });
});

describe("no caller invents a date it does not have", () => {
  /**
   * Read from disk, so this cannot be satisfied by the module graph. The defect
   * was a call-site expression, and no behavioural test at the sender can see
   * one.
   */
  const CALL = "sendAdminPaymentFailureAlert(";

  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || entry.name === "node_modules") continue;
        out.push(...sourceFiles(path));
      } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
        out.push(path);
      }
    }
    return out;
  }

  it("binds no check-in or check-out to a synthesised instant", () => {
    const offenders: string[] = [];
    let callSites = 0;

    for (const file of sourceFiles(join(process.cwd(), "src"))) {
      const source = readFileSync(file, "utf8");
      if (!source.includes(CALL)) continue;
      const lines = source.split(String.fromCharCode(10));
      lines.forEach((line, index) => {
        if (!line.includes(CALL)) return;
        callSites += 1;
        // The alert's own argument object, generously bounded.
        for (const candidate of lines.slice(index, index + 20)) {
          const bound = candidate.trim();
          if (!/^check(In|Out)\s*:/.test(bound)) continue;
          if (!/new Date\s*\(/.test(bound)) continue;
          offenders.push(`${file}:${index + 1} -> ${bound}`);
        }
      });
    }

    // Anti-vacuity: a scan that stopped finding call sites would pass silently,
    // which is the shape of guard this repository has shipped before. The count
    // is a FLOOR, so adding a caller does not fail the gate.
    expect(
      callSites,
      "Found fewer sendAdminPaymentFailureAlert call sites than exist, so this scan is no longer reading what it claims to read.",
    ).toBeGreaterThanOrEqual(20);

    expect(
      offenders,
      "A check-in/check-out passed to the payment-anomaly alert is built from `new Date()`. That is a wall-clock instant, the alert renders these as stored calendar days and refuses an instant, and every caller swallows the throw — so this does not show a wrong date, it deletes the alert. Pass `null`; it renders \"Unknown\".",
    ).toEqual([]);
  });
});
