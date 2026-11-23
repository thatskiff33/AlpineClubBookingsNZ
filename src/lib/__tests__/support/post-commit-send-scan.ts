import ts from "typescript";

import { TRANSACTION_OPENERS } from "@/lib/__tests__/support/lock1-transaction-scan";

/**
 * The reader behind `post-commit-send-census.test.ts` (#5433, `INV-INT-004`):
 * every place, in the scoped files, where a function sends a notice after it
 * has run a transaction. Each one is a notice a committed change may owe, and
 * the census asks whether it goes through the owed-notice mechanism or has a
 * recorded reason.
 *
 * Per module, by syntax tree:
 *
 * - a UNIT is a top-level named function: a function declaration, a `const`
 *   holding a function, or a class method. Everything nested inside a unit
 *   (closures, callbacks) is read as part of it, in source order;
 * - a unit COMMITS when it calls a transaction opener (the
 *   `TRANSACTION_OPENERS` the lock(1) census reads, plus
 *   `runSavedCardClaimRelease`, which commits a release of its own), another
 *   unit of the same module that commits, or an IMPORTED function that commits;
 * - a unit SENDS when it calls a function named `send`, `alert` or `notify`
 *   followed by a capital letter (which covers `sendEmail`, `sendToAdmins` and
 *   `sendUnmuteableAdminAlert`), another unit of the same module that sends
 *   (how it finds a reaper's `finishReap`), or an imported function
 *   `SENDS_THROUGH` names, with a reason;
 * - an IMPORTED function's COMMIT role is read one level deep: the census
 *   resolves each named import of a scoped file to its module and reads the
 *   exported unit there with the same rule (`importedRoles`). That is how it
 *   finds a cron that commits through `resolvePolicyExceptionRequestTerminal`,
 *   `expireMemberGuestConsent` or `markBookingPaymentSucceeded`. Its SEND role
 *   is not derived: read that way, every orchestration helper that alerts
 *   somewhere inside would count as a send, and the list would drown in its
 *   own wrappers. A helper named by a non-sender name that sends is listed in
 *   `SENDS_THROUGH` instead;
 * - a COMMIT POINT is the end of a call that commits. A send INSIDE a
 *   transaction's callback ends before the point and is not counted;
 * - a SITE is a send that starts after a commit point in its unit, keyed
 *   `file#unit#callee`, with, for each call in source order, the names of the
 *   commit points before it (so an entry can name the commit each call is
 *   about);
 * - an imported helper OUTSIDE the scope that both commits and sends, by its
 *   own module's reading, is a site of its own wherever it is called (its
 *   module is not scanned, so nothing else would see the send after its
 *   commit), recorded as `after` `OWN_COMMIT`. A helper inside the scope is
 *   not: its module's own sites are listed already. A helper whose commit this
 *   reader cannot see (single-statement writes, no transaction) is a site of
 *   its own only when `COMMITS_THEN_SENDS` names it, with a reason.
 *
 * It reads the syntax tree, so a comment naming a sender or an opener is never
 * a site; the census's cheap first pass over the tree strips comments first
 * (`stripComments`) for the same reason (`INV-SSOT-004`).
 */

/** The files the census reads (the paths #5433's plan traced). */
export const POST_COMMIT_SEND_SCOPE: readonly RegExp[] = [
  /^src\/lib\/cron-[^/]+\.ts$/,
  /^src\/lib\/[^/]+-payment-cron\.ts$/,
  /^src\/lib\/xero-inbound\/.+\.ts$/,
  /^src\/lib\/stripe-webhook-service\.ts$/,
  /^src\/lib\/group-settlement\.ts$/,
  /^src\/lib\/group-late-joiner\.ts$/,
  /^src\/lib\/waitlist\.ts$/,
  /^src\/app\/api\/webhooks\/.+\.ts$/,
];

/** Calls that commit a transaction of their own. */
export const COMMITTING_CALLS: ReadonlySet<string> = new Set([...Object.keys(TRANSACTION_OPENERS), "runSavedCardClaimRelease"]);

const SENDER = /^(?:send|alert|notify)[A-Z]/;

/** The `after` of a call to a helper that commits and sends inside itself. */
export const OWN_COMMIT = "(its own commit)";

/**
 * Helpers outside the scope that commit a change and then send about it inside
 * themselves, by writes this reader does not read as a commit (single
 * statements, no transaction), so the derivation cannot find them: a call to
 * one is a site, `after` `OWN_COMMIT`. The census checks each against its own
 * module: it must send by this reader's rules, and its module must write.
 */
export const COMMITS_THEN_SENDS: Readonly<Record<string, { module: string; reason: string }>> = {
  retireAndEscalateUnusableSavedCard: {
    module: "src/lib/saved-card-charge-failure.ts",
    reason:
      "commits the clear of an unusable saved card (two single-statement writes, no transaction), then emails the member and alerts officers (#3268)",
  },
};

/**
 * Imported helpers outside the `send`/`alert`/`notify` naming that send a
 * notice: a call to one counts as a send. Each is checked against its own
 * module by `moduleUnitRoles` (it must send).
 */
export const SENDS_THROUGH: Readonly<Record<string, { module: string; reason: string }>> = {
  finaliseMemberGuestConsentTransition: {
    module: "src/lib/member-guest-consent-service.ts",
    reason: "sends the consent outcome email (notifyMemberGuestConsentOutcome) after the expiry or acceptance commits",
  },
};

/** What an imported function does, read from its own module. */
export interface ImportedRole {
  commits: boolean;
  sends: boolean;
  /** The imported module is itself in `POST_COMMIT_SEND_SCOPE`, so its own sites are listed. */
  inScope?: boolean;
}

function calleeName(call: ts.CallExpression): string | null {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

function parse(rel: string, code: string): ts.SourceFile {
  return ts.createSourceFile(rel, code, ts.ScriptTarget.Latest, true, rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

/** The module's top-level named functions, each with every call inside it. */
function units(source: ts.SourceFile): Map<string, ts.CallExpression[]> {
  const found = new Map<string, ts.CallExpression[]>();
  const collect = (name: string, body: ts.Node) => {
    const calls: ts.CallExpression[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) calls.push(node);
      ts.forEachChild(node, visit);
    };
    visit(body);
    found.set(name, calls);
  };
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.body) {
      collect(statement.name?.text ?? "default", statement.body);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const init = declaration.initializer;
        if (ts.isIdentifier(declaration.name) && init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
          collect(declaration.name.text, init.body);
        }
      }
    } else if (ts.isClassDeclaration(statement)) {
      for (const member of statement.members) {
        if (ts.isMethodDeclaration(member) && member.body && ts.isIdentifier(member.name)) {
          collect(`${statement.name?.text ?? "default"}.${member.name.text}`, member.body);
        }
      }
    }
  }
  return found;
}

/** The units whose calls reach `direct` names, directly or through other units (a fixpoint). */
function reaching(all: Map<string, ts.CallExpression[]>, direct: (name: string) => boolean): Set<string> {
  const reached = new Set<string>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const [unit, calls] of all) {
      if (reached.has(unit)) continue;
      if (calls.some((call) => {
        const name = calleeName(call);
        return name !== null && name !== unit && (direct(name) || reached.has(name));
      })) {
        reached.add(unit);
        grew = true;
      }
    }
  }
  return reached;
}

type Roles = { committing: Set<string>; sending: Set<string> };

function rolesOf(all: Map<string, ts.CallExpression[]>, imported: ReadonlyMap<string, ImportedRole>): Roles {
  return {
    committing: reaching(all, (name) => COMMITTING_CALLS.has(name) || imported.get(name)?.commits === true),
    sending: reaching(all, (name) => SENDER.test(name) || Object.hasOwn(SENDS_THROUGH, name)),
  };
}

/** Which of a module's units commit and which send, by this reader's rules, with no import followed. */
export function moduleUnitRoles(rel: string, code: string): Map<string, ImportedRole> {
  const all = units(parse(rel, code));
  const { committing, sending } = rolesOf(all, new Map());
  return new Map([...all.keys()].map((unit) => [unit, { commits: committing.has(unit), sends: sending.has(unit) }]));
}

/** A module path a specifier names, as candidate files to try, or none for a package. */
function candidateFiles(fromRel: string, specifier: string): string[] {
  let base: string;
  if (specifier.startsWith("@/")) base = `src/${specifier.slice(2)}`;
  else if (specifier.startsWith(".")) {
    const parts = fromRel.split("/").slice(0, -1);
    for (const part of specifier.split("/")) {
      if (part === "..") parts.pop();
      else if (part !== ".") parts.push(part);
    }
    base = parts.join("/");
  } else return [];
  return [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`];
}

/**
 * Each named import of a module, by its local name, with the role its own
 * module gives it (`moduleUnitRoles`). `read` returns a module's code, or null
 * when the file does not exist. Only names that commit or send are returned.
 */
export function importedRoles(rel: string, code: string, read: (rel: string) => string | null): Map<string, ImportedRole> {
  const roles = new Map<string, ImportedRole>();
  for (const statement of parse(rel, code).statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings) || statement.importClause?.isTypeOnly) continue;
    const target = candidateFiles(rel, statement.moduleSpecifier.text)
      .map((file) => ({ file, text: read(file) }))
      .find((candidate) => candidate.text !== null);
    if (!target) continue;
    const unitRoles = moduleUnitRoles(target.file, target.text!);
    const inScope = POST_COMMIT_SEND_SCOPE.some((pattern) => pattern.test(target.file));
    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue;
      const role = unitRoles.get((element.propertyName ?? element.name).text);
      if (role && (role.commits || role.sends)) roles.set(element.name.text, { ...role, inScope });
    }
  }
  return roles;
}

/** One site: for each call, in source order, the commit points before it (`OWN_COMMIT` for a helper that commits and sends itself). */
export interface PostCommitSite {
  calls: number;
  afterEach: Set<string>[];
}

/** One module's sites, keyed `file#unit#callee`. */
export function scanPostCommitSends(
  rel: string,
  code: string,
  imported: ReadonlyMap<string, ImportedRole> = new Map(),
): Map<string, PostCommitSite> {
  const all = units(parse(rel, code));
  const { committing, sending } = rolesOf(all, imported);
  const commits = (name: string) => COMMITTING_CALLS.has(name) || committing.has(name) || imported.get(name)?.commits === true;
  const sends = (name: string) => SENDER.test(name) || sending.has(name) || Object.hasOwn(SENDS_THROUGH, name);
  const commitsAndSendsItself = (name: string) => {
    const role = imported.get(name);
    return Object.hasOwn(COMMITS_THEN_SENDS, name) || (role !== undefined && role.commits && role.sends && !role.inScope);
  };
  const sites = new Map<string, PostCommitSite>();
  const count = (key: string, after: readonly string[]) => {
    const site = sites.get(key) ?? { calls: 0, afterEach: [] };
    site.calls += 1;
    site.afterEach.push(new Set(after));
    sites.set(key, site);
  };
  for (const [unit, calls] of all) {
    const named = calls.flatMap((call) => {
      const name = calleeName(call);
      return name === null || name === unit ? [] : [{ call, name }];
    });
    const points = named.filter(({ name }) => commits(name)).map(({ call, name }) => ({ end: call.getEnd(), name }));
    for (const { call, name } of named) {
      const key = `${rel}#${unit}#${name}`;
      if (commitsAndSendsItself(name)) {
        count(key, [OWN_COMMIT]);
        continue;
      }
      if (!sends(name)) continue;
      const before = points.filter((point) => point.end <= call.getStart());
      if (before.length > 0) count(key, before.map((point) => point.name));
    }
  }
  return sites;
}
