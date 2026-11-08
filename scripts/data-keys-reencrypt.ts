/**
 * `pnpm run data-keys:reencrypt` — move stored data to the current
 * data-encryption key (#4456). The steps around it, and when to run it, are in
 * DEPLOYMENT.md → "Moving stored data to the current key".
 *
 *   pnpm run data-keys:reencrypt --dry-run                     # count only
 *   pnpm run data-keys:reencrypt --expect-fingerprint <fp>     # move
 *   pnpm run data-keys:reencrypt --expect-fingerprint <fp> --retire-legacy-recovery-codes
 *
 * It writes to the database named by DATABASE_URL, one row per short
 * transaction, through the same compare-and-set writers the app uses, so it is
 * safe to run while the app serves traffic. It calls no provider and prints no
 * key or stored value. Exit status: 0 when no credential or authenticator
 * secret is left on an old key, 2 when some are (run again, or see the
 * report), 1 when refused or failed.
 */
import process from "node:process";

import { DataKeyRingError } from "../src/lib/data-encryption-key-material";
import {
  formatReencryptReport,
  reencryptLeftRows,
  reencryptStoredData,
  ReencryptRefusedError,
  type ReencryptOptions,
  type ReencryptReport,
} from "../src/lib/data-encryption-reencrypt";
import { prisma } from "../src/lib/prisma";
import { isMainModule } from "./lib/is-main-module.mjs";

export const USAGE = `Usage:
  pnpm run data-keys:reencrypt --dry-run [--retire-legacy-recovery-codes]
  pnpm run data-keys:reencrypt --expect-fingerprint <fp> [--retire-legacy-recovery-codes]

  Re-encrypts every stored provider credential and authenticator-app secret
  not already under the first key of DATA_ENCRYPTION_KEYS, one row at a time,
  and reports what remains on old keys. Refuses when DATA_ENCRYPTION_KEYS is
  unset or invalid.

  --dry-run                       Count what would move; write nothing.
  --expect-fingerprint <fp>       Required unless --dry-run: the fingerprint
                                  Admin → Setup → "Data Encryption Key" shows
                                  for the app's current key. Refuses unless
                                  this command's key has it.
  --retire-legacy-recovery-codes  Also retire the unused recovery codes hashed
                                  under AUTH_SECRET, so they stop working on
                                  every instance, ring or not. Their members are
                                  told to generate a new set.
  --help, -h                      Show this help.

  Exit 0: nothing left on an old key. Exit 2: something is; run again.
  Exit 1: refused or failed.`;

export type ParsedArgs =
  | { kind: "run"; options: Pick<ReencryptOptions, "dryRun" | "retireLegacyRecoveryCodes" | "expectFingerprint"> }
  | { kind: "help" }
  | { kind: "error"; message: string };

export function parseReencryptArgs(argv: readonly string[]): ParsedArgs {
  let dryRun = false;
  let retireLegacyRecoveryCodes = false;
  let expectFingerprint: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--help" || arg === "-h") return { kind: "help" };
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--retire-legacy-recovery-codes") retireLegacyRecoveryCodes = true;
    else if (arg === "--expect-fingerprint" || arg.startsWith("--expect-fingerprint=")) {
      const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[++index];
      if (!value || value.startsWith("--")) {
        return { kind: "error", message: "--expect-fingerprint needs the fingerprint Admin → Setup shows" };
      }
      expectFingerprint = value;
    }
    // pnpm forwards a lone "--" separator; it carries no option.
    else if (arg !== "--") return { kind: "error", message: `Unknown argument: ${arg}` };
  }
  return {
    kind: "run",
    options: { dryRun, retireLegacyRecoveryCodes, ...(expectFingerprint === undefined ? {} : { expectFingerprint }) },
  };
}

/**
 * An error as one line that cannot carry a stored value: its own message only
 * for the errors whose messages are built from fixed text and key ids, and
 * otherwise its class and code alone — a database error's message can echo the
 * query, and that can hold ciphertext.
 */
export function safeErrorLine(error: unknown): string {
  if (error instanceof ReencryptRefusedError || error instanceof DataKeyRingError) {
    return error.message;
  }
  const name = error instanceof Error ? error.name : typeof error;
  const code = (error as { code?: unknown } | null)?.code;
  return `The re-encrypt failed (${name}${typeof code === "string" ? ` ${code}` : ""}). Rows already moved stay moved; run it again.`;
}

export interface CommandIo {
  log: (line: string) => void;
  error: (line: string) => void;
  run: (options: ReencryptOptions) => Promise<ReencryptReport>;
}

/** Parse, run and print; resolves the exit status. */
export async function runReencryptCommand(argv: readonly string[], io: CommandIo): Promise<number> {
  const parsed = parseReencryptArgs(argv);
  if (parsed.kind === "help") {
    io.log(USAGE);
    return 0;
  }
  if (parsed.kind === "error") {
    io.error(`${parsed.message}\n\n${USAGE}`);
    return 1;
  }
  try {
    const report = await io.run(parsed.options);
    for (const line of formatReencryptReport(report)) io.log(line);
    return reencryptLeftRows(report) ? 2 : 0;
  } catch (error) {
    io.error(safeErrorLine(error));
    return 1;
  }
}

async function main(): Promise<void> {
  try {
    process.exitCode = await runReencryptCommand(process.argv.slice(2), {
      log: (line) => console.log(line),
      error: (line) => console.error(line),
      run: reencryptStoredData,
    });
  } finally {
    await prisma.$disconnect();
  }
}

if (isMainModule(import.meta.url)) {
  void main();
}
