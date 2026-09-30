import fs from "node:fs";
import path from "node:path";
import logger from "@/lib/logger";
import { clubConfigSchema, type ClubConfig } from "./schema";
import { SAFE_DEFAULT_CONFIG } from "./safe-default-config";

const PRIMARY_FILE = "club.json";
const EXAMPLE_FILE = "club.example.json";

// Re-export the single canonical boot-safe default (epic #1943, child C1) so
// consumers can `import { SAFE_DEFAULT_CONFIG } from "@/config/club"`.
export { SAFE_DEFAULT_CONFIG } from "./safe-default-config";

export interface LoadClubConfigOptions {
  /** Directory to read club.json / club.example.json from. Defaults to `<cwd>/config`. */
  configDir?: string;
}

/**
 * Provenance of the effective club config — which loader branch resolved it.
 *
 * - `"primary"`      — a valid `config/club.json` (the club's real config).
 * - `"example"`      — the `config/club.example.json` identity (primary absent).
 * - `"safe-default"` — the hard-coded `SAFE_DEFAULT_CONFIG` (primary/example
 *   absent or malformed/invalid).
 *
 * Only `"primary"` is a real, club-specific config. The boot-time config
 * self-heal (`src/lib/config-self-heal.ts`) uses this to REFUSE persisting a
 * fallback identity/defaults into the DB, where they would become DB-first
 * authoritative and never be overwritten (epic #1943, child C2 guard).
 */
export type ClubConfigSource = "primary" | "example" | "safe-default";

/** The effective config plus the loader branch (provenance) that produced it. */
export interface LoadedClubConfig {
  config: ClubConfig;
  source: ClubConfigSource;
}

function defaultConfigDir(): string {
  return path.join(process.cwd(), "config");
}

type FileReadResult =
  | { kind: "absent" }
  | { kind: "malformed"; reason: string }
  | { kind: "present"; data: unknown };

/**
 * Read + JSON-parse a config file, distinguishing "absent" (file does not
 * exist) from "malformed" (present but unreadable / not valid JSON). Never
 * throws — the boot path must not crash.
 */
function readJsonFile(filePath: string): FileReadResult {
  if (!fs.existsSync(filePath)) return { kind: "absent" };
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    return {
      kind: "malformed",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  try {
    return { kind: "present", data: JSON.parse(raw) };
  } catch (err) {
    return {
      kind: "malformed",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

function warnClubConfig(message: string, context: Record<string, unknown>): void {
  // Structured warning so a real misconfiguration is loud, never silently wrong.
  logger.warn({ scope: "club-config", ...context }, message);
}

// test seam
/**
 * Read and validate the club config. Boot-safe: this function NEVER throws, so
 * importing it (and the eager `clubConfig` singleton below) can never crash the
 * app at boot.
 *
 * Resolution rules (epic #1943 owner decision D3 — kept in lockstep with
 * `readClubConfig` in `src/lib/setup-readiness.ts`):
 * - Valid primary `club.json` → returned as-is (zero behaviour change for
 *   healthy installs).
 * - **Malformed** primary `club.json` (present but bad JSON or schema-invalid)
 *   → `SAFE_DEFAULT_CONFIG` + a logged warning. The `club.example.json`
 *   fallback is intentionally SKIPPED so a broken primary is not silently
 *   masked by the example's identity; setup-readiness reports this as *blocked*.
 * - **Absent** primary → fall back to a valid `club.example.json`; if the
 *   example is absent or itself malformed, resolve to `SAFE_DEFAULT_CONFIG` + a
 *   logged warning.
 */
export function loadClubConfig(options: LoadClubConfigOptions = {}): ClubConfig {
  return loadClubConfigWithSource(options).config;
}

/**
 * Like {@link loadClubConfig}, but also reports the provenance (which branch
 * resolved the config). Consumers that must NOT act on a fallback config —
 * notably the boot-time self-heal — key off the `source`. Behaviour is
 * identical to `loadClubConfig`; the only addition is the branch label, so the
 * healthy-install path is byte-for-byte unchanged.
 */
export function loadClubConfigWithSource(
  options: LoadClubConfigOptions = {},
): LoadedClubConfig {
  const dir = options.configDir ?? defaultConfigDir();
  const primaryPath = path.join(dir, PRIMARY_FILE);
  const examplePath = path.join(dir, EXAMPLE_FILE);

  const primary = readJsonFile(primaryPath);

  if (primary.kind === "present") {
    const result = clubConfigSchema.safeParse(primary.data);
    if (result.success) return { config: result.data, source: "primary" };
    warnClubConfig(
      `Invalid club config at ${primaryPath}; using SAFE_DEFAULT_CONFIG. ` +
        `Fix config/club.json — the example fallback is skipped for a broken ` +
        `primary so the misconfiguration is not masked. Issues:\n${formatZodError(result.error)}`,
      { path: primaryPath, cause: "schema" },
    );
    return { config: SAFE_DEFAULT_CONFIG, source: "safe-default" };
  }

  if (primary.kind === "malformed") {
    warnClubConfig(
      `Malformed club config at ${primaryPath} (${primary.reason}); using ` +
        `SAFE_DEFAULT_CONFIG. Fix config/club.json — the example fallback is ` +
        `skipped for a broken primary so the misconfiguration is not masked.`,
      { path: primaryPath, cause: "json", reason: primary.reason },
    );
    return { config: SAFE_DEFAULT_CONFIG, source: "safe-default" };
  }

  // Primary is absent — fall back to club.example.json when it is valid.
  const example = readJsonFile(examplePath);

  if (example.kind === "present") {
    const result = clubConfigSchema.safeParse(example.data);
    if (result.success) return { config: result.data, source: "example" };
    warnClubConfig(
      `Invalid club config at ${examplePath}; using SAFE_DEFAULT_CONFIG. ` +
        `Issues:\n${formatZodError(result.error)}`,
      { path: examplePath, cause: "schema" },
    );
    return { config: SAFE_DEFAULT_CONFIG, source: "safe-default" };
  }

  if (example.kind === "malformed") {
    warnClubConfig(
      `Malformed club config at ${examplePath} (${example.reason}); using ` +
        `SAFE_DEFAULT_CONFIG.`,
      { path: examplePath, cause: "json", reason: example.reason },
    );
    return { config: SAFE_DEFAULT_CONFIG, source: "safe-default" };
  }

  warnClubConfig(
    `No club config found (looked for ${primaryPath} and ${examplePath}); ` +
      `using SAFE_DEFAULT_CONFIG. Run \`pnpm run setup:wizard\` or configure via ` +
      `/admin/setup.`,
    { path: primaryPath, cause: "absent" },
  );
  return { config: SAFE_DEFAULT_CONFIG, source: "safe-default" };
}

function formatZodError(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues
    .map((issue) => {
      const pathStr = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `  - ${pathStr}: ${issue.message}`;
    })
    .join("\n");
}

/**
 * Eagerly loaded singleton for server-side config consumers.
 *
 * Boot-safe: `loadClubConfig` never throws, so this import can never crash the
 * app even with an absent/malformed `config/club.json`. See the bootstrap-layer
 * contract documented in `src/config/club-identity.ts`.
 */
const loadedClubConfig: LoadedClubConfig = loadClubConfigWithSource();

export const clubConfig: ClubConfig = loadedClubConfig.config;

/**
 * Provenance of the eager {@link clubConfig} singleton — which loader branch
 * resolved it at boot. The config self-heal reads this to skip persisting a
 * non-`"primary"` fallback into the DB (epic #1943, child C2 guard).
 */
export const clubConfigSource: ClubConfigSource = loadedClubConfig.source;
