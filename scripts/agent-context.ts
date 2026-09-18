#!/usr/bin/env tsx

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { must } from "../src/lib/indexed-access";

const DEFAULT_MAX_CHARS = 32_000;
const DEFAULT_DEPTH = 1;
const TYPESCRIPT_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"] as const;
const OUTPUT_FILES = ["manifest.json", "overview.md", "typescript.md", "prisma.md"] as const;

export type AgentContextOptions = {
  base: string;
  entries: string[];
  models?: string[];
  depth?: 1 | 2;
  maxChars?: number;
  repoRoot?: string;
  outputRoot?: string;
};

export type AgentContextResult = {
  outputDirectory: string;
  outputRelative: string;
  fingerprint: string;
  sectionChars: Record<(typeof OUTPUT_FILES)[number], number>;
  combinedChars: number;
};

export class AgentContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentContextError";
  }
}

type TrackedFileMap = Map<string, string | null>;

type TypeScriptGraph = {
  imports: Map<string, Set<string>>;
  importers: Map<string, Set<string>>;
  specifiers: Map<string, Set<string>>;
  internalSpecifiers: Map<string, Set<string>>;
  nearbyTests: Map<string, Set<string>>;
};

type PrismaModel = {
  name: string;
  block: string;
  fieldCount: number;
  relations: Set<string>;
};

function runGit(repoRoot: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 1 << 28,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const detail =
      error && typeof error === "object" && "stderr" in error
        ? String(error.stderr).trim()
        : String(error);
    throw new AgentContextError(`git ${args[0] ?? "command"} failed: ${detail}`);
  }
}

function sha256(parts: Iterable<string>): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function toPosix(value: string): string {
  return value.replace(/\\/g, "/");
}

export function normalizeTrackedPath(rawPath: string): string {
  const value = toPosix(rawPath.trim());
  if (!value) throw new AgentContextError("--entry values cannot be empty.");
  if (/^[A-Za-z]:\//.test(value) || value.startsWith("/") || value.startsWith("//")) {
    throw new AgentContextError(`Entry path must be repository-relative: ${rawPath}`);
  }
  const segments = value.split("/");
  if (segments.includes("..")) {
    throw new AgentContextError(`Entry path escapes the repository: ${rawPath}`);
  }
  const normalized = path.posix.normalize(value.replace(/^\.\//, ""));
  if (normalized === "." || normalized.startsWith("../")) {
    throw new AgentContextError(`Entry path must name a tracked file: ${rawPath}`);
  }
  return normalized;
}

function resolveRepoRoot(explicitRoot?: string): string {
  if (explicitRoot) return path.resolve(explicitRoot);
  return path.resolve(runGit(process.cwd(), ["rev-parse", "--show-toplevel"]).trim());
}

function assertInsideRoot(repoRoot: string, relativePath: string): string {
  const absolute = path.resolve(repoRoot, ...relativePath.split("/"));
  const relative = path.relative(repoRoot, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new AgentContextError(`Path escapes the repository: ${relativePath}`);
  }
  return absolute;
}

function readTrackedContent(repoRoot: string, relativePath: string): string | null {
  const absolute = assertInsideRoot(repoRoot, relativePath);
  if (!existsSync(absolute)) return null;
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink()) return `symlink:${toPosix(readlinkSync(absolute))}`;
  if (!stat.isFile()) return null;
  return readFileSync(absolute, "utf8");
}

function loadTrackedFiles(repoRoot: string): TrackedFileMap {
  const paths = runGit(repoRoot, ["ls-files", "-z"])
    .split("\0")
    .filter(Boolean)
    .map(toPosix)
    .sort((left, right) => left.localeCompare(right));
  return new Map(paths.map((relativePath) => [relativePath, readTrackedContent(repoRoot, relativePath)]));
}

function resolveCommit(repoRoot: string, ref: string): string {
  if (!ref.trim()) throw new AgentContextError("--base is required.");
  return runGit(repoRoot, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]).trim();
}

function changedTrackedPaths(
  repoRoot: string,
  baseSha: string,
  tracked: TrackedFileMap,
): string[] {
  return runGit(repoRoot, ["diff", "--name-only", "-z", baseSha, "--"])
    .split("\0")
    .filter(Boolean)
    .map(toPosix)
    .filter((relativePath) => tracked.has(relativePath))
    .sort((left, right) => left.localeCompare(right));
}

function addCount(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function renderOverview(
  trackedPaths: string[],
  entries: string[],
  changedPaths: string[],
  baseRef: string,
  baseSha: string,
): string {
  const topLevel = new Map<string, number>();
  const secondLevel = new Map<string, Map<string, number>>();
  for (const relativePath of trackedPaths) {
    const parts = relativePath.split("/");
    const top = parts.length === 1 ? "(repository root)" : `${parts[0]}/`;
    const second =
      parts.length <= 2 ? "(files at this level)" : `${parts[0]}/${parts[1]}/`;
    addCount(topLevel, top);
    const children = secondLevel.get(top) ?? new Map<string, number>();
    addCount(children, second);
    secondLevel.set(top, children);
  }

  const lines = [
    "# Scoped tracked-tree overview",
    "",
    `Base: \`${baseRef}\` (\`${baseSha.slice(0, 12)}\`)`,
    "",
    "Only paths returned by `git ls-files` are inventoried.",
    "",
    "## Two-level inventory",
    "",
  ];
  for (const top of [...topLevel.keys()].sort()) {
    lines.push(`- \`${top}\` — ${topLevel.get(top)} file(s)`);
    for (const child of [...secondLevel.get(top)!.keys()].sort()) {
      lines.push(`  - \`${child}\` — ${secondLevel.get(top)!.get(child)} file(s)`);
    }
  }
  lines.push("", "## Selected tracked paths", "");
  for (const entry of entries) lines.push(`- \`${entry}\``);
  lines.push("", "## Changed tracked paths since base", "");
  if (changedPaths.length === 0) lines.push("- None.");
  else for (const changed of changedPaths) lines.push(`- \`${changed}\``);
  return `${lines.join("\n")}\n`;
}

function isTypeScriptPath(relativePath: string): boolean {
  return TYPESCRIPT_EXTENSIONS.some((extension) => relativePath.endsWith(extension));
}

function isTestPath(relativePath: string): boolean {
  return (
    relativePath.includes("/__tests__/") ||
    /\.(?:test|spec)\.(?:ts|tsx|mts|cts)$/.test(relativePath)
  );
}

function scriptKind(relativePath: string): ts.ScriptKind {
  if (relativePath.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (relativePath.endsWith(".mts")) return ts.ScriptKind.TS;
  if (relativePath.endsWith(".cts")) return ts.ScriptKind.TS;
  return ts.ScriptKind.TS;
}

function collectStaticSpecifiers(relativePath: string, source: string): Set<string> {
  const parsed = ts.createSourceFile(
    relativePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(relativePath),
  );
  const specifiers = new Set<string>();
  const addLiteral = (node: ts.Expression | undefined): void => {
    if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) {
      specifiers.add(node.text);
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addLiteral(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      addLiteral(node.moduleReference.expression);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      addLiteral(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return specifiers;
}

function candidatePaths(basePath: string): string[] {
  const candidates = [basePath];
  const currentExtension = path.posix.extname(basePath);
  if (currentExtension === ".js" || currentExtension === ".jsx" || currentExtension === ".mjs" || currentExtension === ".cjs") {
    const withoutExtension = basePath.slice(0, -currentExtension.length);
    candidates.push(...TYPESCRIPT_EXTENSIONS.map((extension) => `${withoutExtension}${extension}`));
  } else if (!TYPESCRIPT_EXTENSIONS.includes(currentExtension as (typeof TYPESCRIPT_EXTENSIONS)[number])) {
    candidates.push(...TYPESCRIPT_EXTENSIONS.map((extension) => `${basePath}${extension}`));
    candidates.push(...TYPESCRIPT_EXTENSIONS.map((extension) => `${basePath}/index${extension}`));
  }
  return [...new Set(candidates)];
}

function resolveInternalSpecifier(
  importer: string,
  specifier: string,
  tracked: TrackedFileMap,
): string | null {
  let basePath: string;
  if (specifier.startsWith("@/")) {
    basePath = path.posix.join("src", specifier.slice(2));
  } else if (specifier.startsWith("./") || specifier.startsWith("../")) {
    basePath = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
  } else {
    return null;
  }
  for (const candidate of candidatePaths(basePath)) {
    if (tracked.has(candidate) && tracked.get(candidate) !== null && isTypeScriptPath(candidate)) {
      return candidate;
    }
  }
  return null;
}

// A test is "nearby" only when it names this module. Matching every test in the
// sibling `__tests__` directory instead listed all 1,108 files of
// `src/lib/__tests__/` under each node, which pushed a single ordinary `src/lib`
// entry past two million characters and failed the cap for most of the repo.
function nearbyTestsFor(relativePath: string, typeScriptPaths: string[]): Set<string> {
  const directory = path.posix.dirname(relativePath);
  const baseName = path.posix.basename(relativePath).replace(/\.(?:ts|tsx|mts|cts)$/, "");
  return new Set(
    typeScriptPaths.filter((candidate) => {
      if (!isTestPath(candidate)) return false;
      const candidateDirectory = path.posix.dirname(candidate);
      if (candidateDirectory !== directory && candidateDirectory !== `${directory}/__tests__`) {
        return false;
      }
      const candidateName = path.posix
        .basename(candidate)
        .replace(/\.(?:test|spec)\.(?:ts|tsx|mts|cts)$/, "");
      return candidateName === baseName;
    }),
  );
}

function buildTypeScriptGraph(tracked: TrackedFileMap): TypeScriptGraph {
  const typeScriptPaths = [...tracked.keys()].filter(
    (relativePath) => isTypeScriptPath(relativePath) && tracked.get(relativePath) !== null,
  );
  const imports = new Map<string, Set<string>>();
  const importers = new Map<string, Set<string>>();
  const specifiers = new Map<string, Set<string>>();
  const internalSpecifiers = new Map<string, Set<string>>();
  const nearbyTests = new Map<string, Set<string>>();
  for (const relativePath of typeScriptPaths) {
    const source = tracked.get(relativePath);
    if (source === null || source === undefined) continue;
    const fileSpecifiers = collectStaticSpecifiers(relativePath, source);
    specifiers.set(relativePath, fileSpecifiers);
    const resolved = new Set<string>();
    const resolvedSpecifiers = new Set<string>();
    for (const specifier of fileSpecifiers) {
      const dependency = resolveInternalSpecifier(relativePath, specifier, tracked);
      if (!dependency) continue;
      resolvedSpecifiers.add(specifier);
      resolved.add(dependency);
      const reverse = importers.get(dependency) ?? new Set<string>();
      reverse.add(relativePath);
      importers.set(dependency, reverse);
    }
    imports.set(relativePath, resolved);
    internalSpecifiers.set(relativePath, resolvedSpecifiers);
    nearbyTests.set(relativePath, nearbyTestsFor(relativePath, typeScriptPaths));
  }
  return { imports, importers, specifiers, internalSpecifiers, nearbyTests };
}

function selectGraphNodes(
  graph: TypeScriptGraph,
  entries: string[],
  depth: number,
): Map<string, number> {
  const selected = new Map<string, number>();
  let frontier = entries.filter(isTypeScriptPath);
  for (const entry of frontier) selected.set(entry, 0);
  for (let hop = 1; hop <= depth; hop += 1) {
    const next = new Set<string>();
    for (const node of frontier) {
      for (const neighbour of [
        ...(graph.imports.get(node) ?? []),
        ...(graph.importers.get(node) ?? []),
      ]) {
        if (!selected.has(neighbour)) {
          selected.set(neighbour, hop);
          next.add(neighbour);
        }
      }
    }
    frontier = [...next];
  }
  return selected;
}

function renderPathList(values: Iterable<string>, emptyLabel = "None"): string[] {
  const sorted = [...new Set(values)].sort((left, right) => left.localeCompare(right));
  if (sorted.length === 0) return [`- ${emptyLabel}.`];
  return sorted.map((value) => `- \`${value}\``);
}

function renderTypeScript(
  graph: TypeScriptGraph,
  selectedNodes: Map<string, number>,
  entries: string[],
  depth: number,
): string {
  const lines = [
    "# Bounded TypeScript neighbourhood",
    "",
    `Depth: ${depth} hop(s).`,
    "",
    "The graph follows static relative imports, the repository `@/` alias, static dynamic imports, and reverse importers. Bare package imports are listed but not traversed.",
    "",
  ];
  const ignoredEntries = entries.filter((entry) => !isTypeScriptPath(entry));
  if (ignoredEntries.length > 0) {
    lines.push("## Non-TypeScript selected paths", "", ...renderPathList(ignoredEntries), "");
  }
  if (selectedNodes.size === 0) {
    lines.push("No TypeScript entrypoints were selected.");
    return `${lines.join("\n")}\n`;
  }
  for (const [relativePath, hop] of [...selectedNodes].sort(([left], [right]) => left.localeCompare(right))) {
    const allSpecifiers = graph.specifiers.get(relativePath) ?? new Set<string>();
    const internalSpecifiers = graph.internalSpecifiers.get(relativePath) ?? new Set<string>();
    const unresolvedOrExternal = [...allSpecifiers].filter(
      (specifier) => !internalSpecifiers.has(specifier),
    );
    lines.push(
      `## \`${relativePath}\``,
      "",
      `Hop: ${hop}`,
      "",
      "### Imports",
      "",
      ...renderPathList(graph.imports.get(relativePath) ?? []),
      "",
      "### Importers",
      "",
      ...renderPathList(graph.importers.get(relativePath) ?? []),
      "",
      "### Nearby tests",
      "",
      ...renderPathList(graph.nearbyTests.get(relativePath) ?? []),
      "",
      "### External or unresolved static specifiers",
      "",
      ...renderPathList(unresolvedOrExternal),
      "",
    );
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function parsePrismaModels(schema: string): Map<string, PrismaModel> {
  const models = new Map<string, PrismaModel>();
  const pattern = /^model\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/gm;
  for (const match of schema.matchAll(pattern)) {
    // The pattern's own capture group is mandatory, so its absence means the
    // pattern itself did not really match; that is the rejection, not a
    // fallback name.
    const [, modelName] = match;
    if (!modelName) continue;
    const start = match.index!;
    let cursor = start;
    let depth = 0;
    let seenOpening = false;
    for (; cursor < schema.length; cursor += 1) {
      if (schema[cursor] === "{") {
        depth += 1;
        seenOpening = true;
      } else if (schema[cursor] === "}") {
        depth -= 1;
        if (seenOpening && depth === 0) {
          cursor += 1;
          break;
        }
      }
    }
    if (depth !== 0) throw new AgentContextError(`Unclosed Prisma model block: ${modelName}`);
    const block = schema.slice(start, cursor).trim();
    const fields = block
      .split(/\r?\n/)
      .slice(1, -1)
      .map((line) => line.trim())
      .filter((line) => /^[A-Za-z_][A-Za-z0-9_]*\s+/.test(line));
    models.set(modelName, {
      name: modelName,
      block,
      fieldCount: fields.length,
      relations: new Set<string>(),
    });
  }
  for (const model of models.values()) {
    for (const line of model.block.split(/\r?\n/).slice(1, -1)) {
      const field = line.trim().match(/^[A-Za-z_][A-Za-z0-9_]*\s+([A-Za-z_][A-Za-z0-9_]*)/);
      const typeName = field?.[1];
      if (typeName && typeName !== model.name && models.has(typeName)) model.relations.add(typeName);
    }
  }
  return models;
}

function renderPrisma(models: Map<string, PrismaModel>, requestedModels: string[]): string {
  const unknown = requestedModels.filter((model) => !models.has(model));
  if (unknown.length > 0) {
    throw new AgentContextError(
      `Unknown Prisma model(s): ${unknown.join(", ")}. Choose a name from the model index.`,
    );
  }
  const detailed = new Set(requestedModels);
  for (const requested of requestedModels) {
    for (const relation of models.get(requested)!.relations) detailed.add(relation);
  }
  const lines = ["# Prisma model context", "", "## Model index", ""];
  for (const model of [...models.values()].sort((left, right) => left.name.localeCompare(right.name))) {
    lines.push(`- \`${model.name}\` — ${model.fieldCount} field(s)`);
  }
  lines.push("", "## Requested models and direct relation neighbours", "");
  if (detailed.size === 0) {
    lines.push("No model detail requested.");
  } else {
    for (const name of [...detailed].sort((left, right) => left.localeCompare(right))) {
      const model = models.get(name)!;
      const role = requestedModels.includes(name) ? "requested" : "direct relation neighbour";
      lines.push(`### \`${name}\` (${role})`, "", "```prisma", model.block, "```", "");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function buildManifest(
  values: Omit<AgentContextResult, "outputDirectory" | "sectionChars" | "combinedChars"> & {
    baseRef: string;
    baseSha: string;
    headSha: string;
    entries: string[];
    models: string[];
    depth: number;
    maxChars: number;
    outputRelative: string;
  },
  documentSizes: Record<"overview.md" | "typescript.md" | "prisma.md", number>,
): { text: string; combinedChars: number } {
  let manifestChars = 0;
  let combinedChars = Object.values(documentSizes).reduce((sum, size) => sum + size, 0);
  let text = "";
  for (let attempt = 0; attempt < 10; attempt += 1) {
    text = `${JSON.stringify(
      {
        version: 1,
        base: { ref: values.baseRef, sha: values.baseSha },
        headSha: values.headSha,
        scope: {
          entries: values.entries,
          models: values.models,
          depth: values.depth,
          maxChars: values.maxChars,
        },
        fingerprint: values.fingerprint,
        outputDirectory: values.outputRelative,
        sectionChars: { "manifest.json": manifestChars, ...documentSizes },
        combinedChars,
      },
      null,
      2,
    )}\n`;
    const nextManifestChars = text.length;
    const nextCombinedChars =
      nextManifestChars + Object.values(documentSizes).reduce((sum, size) => sum + size, 0);
    if (nextManifestChars === manifestChars && nextCombinedChars === combinedChars) break;
    manifestChars = nextManifestChars;
    combinedChars = nextCombinedChars;
  }
  return { text, combinedChars };
}

function publishAtomically(
  outputRoot: string,
  outputDirectory: string,
  files: Record<(typeof OUTPUT_FILES)[number], string>,
): void {
  mkdirSync(outputRoot, { recursive: true });
  const temporary = mkdtempSync(path.join(outputRoot, ".tmp-"));
  try {
    for (const fileName of OUTPUT_FILES) {
      writeFileSync(path.join(temporary, fileName), files[fileName], "utf8");
    }
    if (existsSync(outputDirectory)) {
      for (const fileName of OUTPUT_FILES) {
        const existing = readFileSync(path.join(outputDirectory, fileName), "utf8");
        if (existing !== files[fileName]) {
          throw new AgentContextError(
            `Existing artifact differs at ${toPosix(path.relative(process.cwd(), outputDirectory))}. Remove it and rerun.`,
          );
        }
      }
      rmSync(temporary, { recursive: true, force: true });
      return;
    }
    renameSync(temporary, outputDirectory);
  } catch (error) {
    if (existsSync(temporary)) rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

export function generateAgentContext(options: AgentContextOptions): AgentContextResult {
  const repoRoot = resolveRepoRoot(options.repoRoot);
  const depth = options.depth ?? DEFAULT_DEPTH;
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  if (depth !== 1 && depth !== 2) throw new AgentContextError("--depth must be 1 or 2.");
  if (!Number.isSafeInteger(maxChars) || maxChars <= 0) {
    throw new AgentContextError("--max-chars must be a positive integer.");
  }
  const tracked = loadTrackedFiles(repoRoot);
  const entries = [...new Set(options.entries.map(normalizeTrackedPath))].sort();
  if (entries.length === 0) throw new AgentContextError("At least one --entry is required.");
  for (const entry of entries) {
    assertInsideRoot(repoRoot, entry);
    if (!tracked.has(entry)) throw new AgentContextError(`Entry is not a Git-tracked file: ${entry}`);
    if (tracked.get(entry) === null) throw new AgentContextError(`Tracked entry is missing: ${entry}`);
  }
  const requestedModels = [...new Set(options.models ?? [])].sort();
  const baseSha = resolveCommit(repoRoot, options.base);
  const headSha = resolveCommit(repoRoot, "HEAD");
  const changedPaths = changedTrackedPaths(repoRoot, baseSha, tracked);
  const overview = renderOverview([...tracked.keys()], entries, changedPaths, options.base, baseSha);

  const graph = buildTypeScriptGraph(tracked);
  const selectedNodes = selectGraphNodes(graph, entries, depth);
  const typeScriptContext = renderTypeScript(graph, selectedNodes, entries, depth);

  const prismaSchema = tracked.get("prisma/schema.prisma");
  if (prismaSchema === null || prismaSchema === undefined) {
    throw new AgentContextError("Tracked prisma/schema.prisma is missing.");
  }
  const prismaContext = renderPrisma(parsePrismaModels(prismaSchema), requestedModels);

  const relevantPaths = [...new Set([...entries, ...changedPaths, ...selectedNodes.keys(), "prisma/schema.prisma"])].sort();
  const contentFingerprintParts = relevantPaths.flatMap((relativePath) => [
    relativePath,
    tracked.get(relativePath) ?? "<deleted>",
  ]);
  const fingerprint = sha256([
    "agent-context-v1",
    options.base,
    baseSha,
    ...entries,
    ...requestedModels,
    String(depth),
    String(maxChars),
    ...contentFingerprintParts,
  ]);
  const outputRelative = `.artifacts/agent-context/${headSha.slice(0, 12)}-${fingerprint.slice(0, 12)}`;
  const outputRoot = options.outputRoot
    ? path.resolve(options.outputRoot)
    : path.join(repoRoot, ".artifacts", "agent-context");
  const outputDirectory = path.join(outputRoot, `${headSha.slice(0, 12)}-${fingerprint.slice(0, 12)}`);
  const documentSizes = {
    "overview.md": overview.length,
    "typescript.md": typeScriptContext.length,
    "prisma.md": prismaContext.length,
  };
  const manifest = buildManifest(
    {
      fingerprint,
      baseRef: options.base,
      baseSha,
      headSha,
      entries,
      models: requestedModels,
      depth,
      maxChars,
      outputRelative,
    },
    documentSizes,
  );
  const files = {
    "manifest.json": manifest.text,
    "overview.md": overview,
    "typescript.md": typeScriptContext,
    "prisma.md": prismaContext,
  };
  const sectionChars = Object.fromEntries(
    OUTPUT_FILES.map((fileName) => [fileName, files[fileName].length]),
  ) as AgentContextResult["sectionChars"];
  if (manifest.combinedChars > maxChars) {
    // Name the dominant section and the widest node so "narrow it" is
    // actionable: a hub entrypoint can pull in hundreds of importers, and the
    // caller cannot see which one without this breakdown.
    const bySize = OUTPUT_FILES.map((fileName) => `${fileName} ${sectionChars[fileName]}`).join(", ");
    const widest = [...selectedNodes.keys()]
      .map((node) => ({
        node,
        fanOut: (graph.imports.get(node)?.size ?? 0) + (graph.importers.get(node)?.size ?? 0),
      }))
      .sort((left, right) => right.fanOut - left.fanOut || left.node.localeCompare(right.node))
      .slice(0, 3)
      .map(({ node, fanOut }) => `${node} (${fanOut})`)
      .join(", ");
    throw new AgentContextError(
      `Scoped context is ${manifest.combinedChars} characters, exceeding --max-chars ${maxChars} by ${manifest.combinedChars - maxChars}. Sections: ${bySize}. ${selectedNodes.size} TypeScript node(s) selected at depth ${depth}; widest fan-out: ${widest || "none"}. Narrow --entry/--model, reduce --depth, or raise the explicit cap. No artifact was written.`,
    );
  }
  publishAtomically(outputRoot, outputDirectory, files);
  return {
    outputDirectory,
    outputRelative,
    fingerprint,
    sectionChars,
    combinedChars: manifest.combinedChars,
  };
}

type CliOptions = Omit<AgentContextOptions, "repoRoot" | "outputRoot">;

const USAGE =
  "Usage: npm run agent:context -- -- --base <ref> --entry <tracked-path> [--entry <tracked-path> ...] [--model <PrismaModel> ...] [--depth 1|2] [--max-chars 32000]";

// PowerShell removes the first `--` before `npm` sees it, so npm then swallows
// `--base`/`--entry` as its own config flags and the script receives bare
// values. Documenting `-- --` fixes PowerShell, and tolerating the literal `--`
// that a POSIX shell forwards keeps that one command correct in every shell.
export function parseAgentContextArgs(args: string[]): CliOptions {
  const parsed: CliOptions = { base: "", entries: [], models: [] };
  for (let index = 0; index < args.length; index += 1) {
    // The loop condition just above is exactly what makes this in range.
    const flag = must(args[index], `parseAgentContextArgs: index ${index} out of range`);
    if (flag === "--") continue;
    if (flag === "--help") {
      throw new AgentContextError(USAGE);
    }
    if (!["--base", "--entry", "--model", "--depth", "--max-chars"].includes(flag)) {
      if (!flag.startsWith("-")) {
        throw new AgentContextError(
          `Unexpected bare value: ${flag}. The option flags did not reach this script — the shell or npm consumed them. ${USAGE}`,
        );
      }
      throw new AgentContextError(`Unknown argument: ${flag}`);
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new AgentContextError(`${flag} requires a value.`);
    }
    index += 1;
    if (flag === "--base") parsed.base = value;
    else if (flag === "--entry") parsed.entries.push(value);
    else if (flag === "--model") parsed.models!.push(value);
    else if (flag === "--depth") parsed.depth = Number(value) as 1 | 2;
    else parsed.maxChars = Number(value);
  }
  if (!parsed.base) throw new AgentContextError("--base is required.");
  if (parsed.entries.length === 0) throw new AgentContextError("At least one --entry is required.");
  return parsed;
}

function runCli(): void {
  try {
    const result = generateAgentContext(parseAgentContextArgs(process.argv.slice(2)));
    console.log(result.outputRelative);
    console.log(
      OUTPUT_FILES.map((fileName) => `${fileName}: ${result.sectionChars[fileName]} chars`).join(" | "),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) runCli();
