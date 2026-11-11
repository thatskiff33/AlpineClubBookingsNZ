/**
 * `pnpm run auth:reset-factors -- --member <email>`
 *
 * The operator's way back when a club's only Full Admin has lost their
 * authenticator or passkey (#4618). It clears the same factors as the in-app
 * reset, and it is audited under the named system actor. It prints no secret.
 */
import process from "node:process";

import { sendOfficerFactorResetEmail } from "../src/lib/email/account";
import logger from "../src/lib/logger";
import { clearMemberSecondFactors } from "../src/lib/officer-factor-reset";
import { OFFICER_SIGN_IN_RELEASE_ENABLED } from "../src/lib/officer-sign-in-release";
import { OFFICER_FACTOR_RESET_JOB_NAME } from "../src/lib/two-factor-audit";
import { normaliseSignInEmail } from "../src/lib/login-throttle";
import { prisma } from "../src/lib/prisma";
import { isMainModule } from "./lib/is-main-module.mjs";

const USAGE = `Usage:
  pnpm run auth:reset-factors -- --member <email>

  Clears that member's authenticator app, emailed codes and passkeys, and
  ends their sessions. While the officer sign-in release is off, it writes
  nothing.

  --member <email>   The member's sign-in email.
  --help, -h         Show this help.

  Exit 0: reset. Exit 1: refused or failed.`;

const OPTION_NAME = /^--?[a-z][a-z-]*$/;

function describeUnknownArgument(arg: string): string {
  const name = arg.split("=", 1)[0] ?? "";
  return OPTION_NAME.test(name) ? name : "an unrecognised argument (not repeated here)";
}

type Parsed =
  | { kind: "help" }
  | { kind: "run"; email: string }
  | { kind: "error"; message: string };

export function parseResetFactorsArgs(argv: readonly string[]): Parsed {
  let email: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--help" || arg === "-h") return { kind: "help" };
    if (arg === "--member") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        return { kind: "error", message: "--member needs an email address." };
      }
      email = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--member=")) {
      const value = arg.slice("--member=".length);
      if (!value) return { kind: "error", message: "--member needs an email address." };
      email = value;
      continue;
    }
    return {
      kind: "error",
      message: `Unrecognised argument: ${describeUnknownArgument(arg)}.`,
    };
  }
  if (!email) return { kind: "error", message: "--member is required." };
  return { kind: "run", email };
}

export async function runResetFactorsCommand(
  argv: readonly string[],
  io: { log: (line: string) => void; error: (line: string) => void } = {
    log: (line) => console.log(line),
    error: (line) => console.error(line),
  },
): Promise<number> {
  const parsed = parseResetFactorsArgs(argv);
  if (parsed.kind === "help") {
    io.log(USAGE);
    return 0;
  }
  if (parsed.kind === "error") {
    io.error(`${parsed.message}\n\n${USAGE}`);
    return 1;
  }
  if (!OFFICER_SIGN_IN_RELEASE_ENABLED) {
    io.error("The officer sign-in release is off. Nothing was written.");
    return 1;
  }

  const email = normaliseSignInEmail(parsed.email.trim());
  const member = await prisma.member.findFirst({
    where: { email, canLogin: true },
    select: { id: true },
  });
  if (!member) {
    io.error("No member has that email address.");
    return 1;
  }

  const cleared = await clearMemberSecondFactors({
    memberId: member.id,
    actor: { kind: "system", actor: OFFICER_FACTOR_RESET_JOB_NAME },
  });
  if (!cleared.ok) {
    io.error(
      cleared.reason === "kiosk"
        ? "That account is the lodge kiosk and has no second factor to reset."
        : "No member has that email address.",
    );
    return 1;
  }

  try {
    await sendOfficerFactorResetEmail(cleared.email, cleared.firstName);
  } catch (error) {
    logger.error(
      { err: error, memberId: cleared.memberId },
      "Officer factor reset committed but the email was not queued",
    );
    io.error("The factors were reset, but the email could not be queued.");
  }

  const anotherFullAdmin = await prisma.member.findFirst({
    where: {
      id: { not: cleared.memberId },
      active: true,
      canLogin: true,
      accessRoles: { some: { role: "ADMIN" } },
    },
    select: { id: true },
  });
  io.log(`Reset the authenticator and passkeys for ${cleared.email}. Their sessions are ended.`);
  if (anotherFullAdmin) {
    io.log(
      "Another Full Admin can do this in the app: Admin → Login & Security, or the button on the member's account.",
    );
  }
  return 0;
}

async function main(): Promise<void> {
  try {
    process.exitCode = await runResetFactorsCommand(process.argv.slice(2));
  } finally {
    await prisma.$disconnect();
  }
}

if (isMainModule(import.meta.url)) {
  void main();
}
