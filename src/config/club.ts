import fs from "node:fs";
import path from "node:path";
import { clubConfigSchema, type ClubConfig } from "./schema";

const PRIMARY_FILE = "club.json";
const EXAMPLE_FILE = "club.example.json";

export interface LoadClubConfigOptions {
  /** Directory to read club.json / club.example.json from. Defaults to `<cwd>/config`. */
  configDir?: string;
}

function defaultConfigDir(): string {
  return path.join(process.cwd(), "config");
}

function readJsonIfExists(filePath: string): unknown | null {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, "utf8");
  try {
    return JSON.parse(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid JSON in ${filePath}: ${reason}`);
  }
}

/**
 * Read and validate a club config. Tries `<configDir>/club.json` first, then falls back
 * to `<configDir>/club.example.json`. Throws if neither exists or the chosen file fails
 * schema validation.
 */
export function loadClubConfig(options: LoadClubConfigOptions = {}): ClubConfig {
  const dir = options.configDir ?? defaultConfigDir();
  const primaryPath = path.join(dir, PRIMARY_FILE);
  const examplePath = path.join(dir, EXAMPLE_FILE);

  const primary = readJsonIfExists(primaryPath);
  const sourcePath = primary !== null ? primaryPath : examplePath;
  const data = primary !== null ? primary : readJsonIfExists(examplePath);

  if (data === null) {
    throw new Error(
      `No club config found. Looked for ${primaryPath} and ${examplePath}.`,
    );
  }

  const result = clubConfigSchema.safeParse(data);
  if (!result.success) {
    throw new Error(
      `Invalid club config at ${sourcePath}:\n${formatZodError(result.error)}`,
    );
  }
  return result.data;
}

function formatZodError(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues
    .map((issue) => {
      const pathStr = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `  - ${pathStr}: ${issue.message}`;
    })
    .join("\n");
}

/** Eagerly loaded singleton — Phase 2 will wire call sites to this. */
export const clubConfig: ClubConfig = loadClubConfig();
