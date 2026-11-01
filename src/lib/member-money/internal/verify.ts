import type { Client } from "pg";
import { z } from "zod";
import { APPEND_ONLY_FORBIDDEN_PRIVILEGE_TYPES, APPEND_ONLY_FORBIDDEN_TABLE_PRIVILEGES } from "../../database-roles";
import { MEMBER_MONEY_RELATIONS } from "../../member-money-tables";
import { MEMBER_MONEY_DATABASE_SHAPE, type MemberMoneyFunctionShape } from "./database-shape";

const Finding = z.object({ identity: z.string(), problem: z.string(), found: z.string().optional() });
export type MemberMoneyFinding = z.infer<typeof Finding>;

/**
 * The per-role part of the grant check. `checked`: the role's effective table
 * rights were compared with INSERT/SELECT. `not_applicable`: the role is a
 * superuser or owns every journal relation, as on a single-role install, where
 * no grant can narrow it (`INV-OPS-016`). The role-agnostic part, that no
 * grantee but the owner holds a right that changes a row, runs either way.
 */
export type MemberMoneyGrantCheck = "checked" | "not_applicable";

/** The catalog-defined parts of `MEMBER_MONEY_DATABASE_SHAPE`, and what each finding is called. */
const DEFINITION_PROBLEMS = {
  constraints: { unusable: "missing_or_unvalidated_constraint", changed: "changed_constraint" },
  triggers: { unusable: "missing_or_disabled_trigger", changed: "changed_trigger" },
  uniqueIndexes: { unusable: "missing_or_invalid_unique_index", changed: "changed_unique_index" },
} as const;

const Definition = z.object({
  kind: z.enum(["constraints", "triggers", "uniqueIndexes"]),
  relation: z.string(),
  name: z.string(),
  /** The catalog's text for it: `pg_get_constraintdef`, `pg_get_triggerdef` or `pg_get_indexdef`. */
  definition: z.string(),
  /** Validated; enabled for ordinary sessions (Origin or Always); or valid, ready and live. */
  usable: z.boolean(),
});
export type MemberMoneyDefinition = z.infer<typeof Definition>;

const ReadFunction = z.object({
  name: z.string(),
  source: z.string(),
  volatility: z.enum(["immutable", "stable", "volatile"]),
  securityDefiner: z.boolean(),
  config: z.array(z.string()),
});

/** The settings `pg_get_*def` text depends on, fixed while the definitions are read. */
const DEPARSE_SETTINGS = { searchPath: "pg_catalog, public", quoteAllIdentifiers: "off" };
const SAVEPOINT = "member_money_definitions";

/**
 * Every constraint, trigger and unique index on the journal relations, each
 * with the catalog's text for its definition. It must run inside the caller's
 * transaction: it fixes the deparse settings transaction-locally under a
 * savepoint and rolls back to it, so the caller's own settings, `SET LOCAL`
 * included, come back exactly as they were.
 */
export async function readMemberMoneyDefinitions(client: Client): Promise<MemberMoneyDefinition[]> {
  try {
    await client.query(`SAVEPOINT ${SAVEPOINT}`);
  } catch (error) {
    if ((error as { code?: string }).code === "25P01") {
      throw new Error("The member-money verifier must run inside a transaction (BEGIN ... READ ONLY).");
    }
    throw error;
  }
  let failed = false;
  try {
    await client.query(`SELECT set_config('search_path', $1, true), set_config('quote_all_identifiers', $2, true)`,
      [DEPARSE_SETTINGS.searchPath, DEPARSE_SETTINGS.quoteAllIdentifiers]);
    const { rows } = await client.query(`
      SELECT 'constraints' AS kind, c.relname AS relation, k.conname AS name,
        pg_catalog.pg_get_constraintdef(k.oid) AS definition, k.convalidated AS usable
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_constraint k ON k.conrelid = c.oid AND k.contype <> 't'
      WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY($1::text[])
      UNION ALL
      SELECT 'triggers', c.relname, t.tgname, pg_catalog.pg_get_triggerdef(t.oid), t.tgenabled IN ('O', 'A')
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_trigger t ON t.tgrelid = c.oid AND NOT t.tgisinternal
      WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY($1::text[])
      UNION ALL
      SELECT 'uniqueIndexes', c.relname, ic.relname, pg_catalog.pg_get_indexdef(i.indexrelid),
        i.indisvalid AND i.indisready AND i.indislive
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_index i ON i.indrelid = c.oid AND i.indisunique
        JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
      WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY($1::text[])
    `, [[...MEMBER_MONEY_RELATIONS]]);
    return z.array(Definition).parse(rows);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    // Also recovers a transaction the read aborted. If that cleanup fails too,
    // the read's own error is the one the caller sees.
    try {
      await client.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
      await client.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
    } catch (cleanup) {
      if (!failed) throw cleanup;
    }
  }
}

/** What differs between a routine as found and as pinned, or nothing. */
function functionDrift(found: z.infer<typeof ReadFunction>, pinned: MemberMoneyFunctionShape): string | null {
  const differs = [
    found.volatility !== pinned.volatility && `volatility=${found.volatility}`,
    found.securityDefiner !== pinned.securityDefiner && `securityDefiner=${found.securityDefiner}`,
    found.config.join("\n") !== pinned.config.join("\n") && `config=${JSON.stringify(found.config)}`,
  ].filter((part): part is string => typeof part === "string");
  return differs.length ? differs.join(" ") : null;
}

/** Operator-only evidence query. Run inside a read-only repeatable-read transaction. */
export async function verifyMemberMoneyJournal(
  client: Client,
  appRole: string,
): Promise<{ findings: MemberMoneyFinding[]; grantCheck: MemberMoneyGrantCheck }> {
  const read = await readMemberMoneyDefinitions(client);

  const batches = await client.query(`
    SELECT j.id AS identity, unnest(public.member_money_batch_errors(j.id)) AS problem
    FROM public."MemberMoneyJournal" j
    UNION ALL
    SELECT e.id, 'missing_journal' FROM public."MemberMoneyEvent" e
    LEFT JOIN public."MemberMoneyJournal" j ON j."eventId" = e.id WHERE j.id IS NULL
  `);
  const findings = z.array(Finding).parse(batches.rows);

  const pinnedFunctions: Record<string, MemberMoneyFunctionShape> = MEMBER_MONEY_DATABASE_SHAPE.functions;
  const routines = z.array(ReadFunction).parse((await client.query(`
    SELECT p.proname AS name, md5(p.prosrc) AS source,
      CASE p.provolatile WHEN 'i' THEN 'immutable' WHEN 's' THEN 'stable' ELSE 'volatile' END AS volatility,
      p.prosecdef AS "securityDefiner", coalesce(p.proconfig, ARRAY[]::text[]) AS config
    FROM pg_catalog.pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY($1::text[])
  `, [Object.keys(pinnedFunctions)])).rows);
  for (const [name, pinned] of Object.entries(pinnedFunctions)) {
    const found = routines.filter((routine) => routine.name === name);
    if (found.length === 0) findings.push({ identity: name, problem: "missing_function" });
    else if (found.length > 1 || found[0]!.source !== pinned.source) findings.push({ identity: name, problem: "changed_function" });
    else {
      const drift = functionDrift(found[0]!, pinned);
      if (drift) findings.push({ identity: name, problem: "changed_function_settings", found: drift });
    }
  }

  const definitions = new Map(read.map((found) => [`${found.kind}:${found.relation}.${found.name}`, found]));
  // A trigger the shape does not name can rewrite or swallow a row before any
  // pinned check sees it, so every extra one is a finding, enabled or not. An
  // extra constraint or unique index can only refuse rows, so none is reported.
  const pinnedTriggers: Record<string, Record<string, string>> = MEMBER_MONEY_DATABASE_SHAPE.triggers;
  for (const found of read) {
    if (found.kind === "triggers" && !Object.hasOwn(pinnedTriggers[found.relation] ?? {}, found.name)) {
      findings.push({ identity: `${found.relation}.${found.name}`, problem: "unexpected_trigger", found: found.definition });
    }
  }
  for (const [kind, problems] of Object.entries(DEFINITION_PROBLEMS)) {
    const pinned: Record<string, Record<string, string>> = MEMBER_MONEY_DATABASE_SHAPE[kind as keyof typeof DEFINITION_PROBLEMS];
    for (const [relation, expected] of Object.entries(pinned)) {
      for (const [name, definition] of Object.entries(expected)) {
        const found = definitions.get(`${kind}:${relation}.${name}`);
        if (!found?.usable) findings.push({ identity: `${relation}.${name}`, problem: problems.unusable });
        else if (found.definition !== definition) {
          findings.push({ identity: `${relation}.${name}`, problem: problems.changed, found: found.definition });
        }
      }
    }
  }

  // A journal foreign key is enforced by internal triggers on both its own table
  // and its parent's (a booking, say), and a superuser can disable either, or
  // set it to fire only under replication, while the constraint still reads as
  // validated. Like the pinned triggers, it must fire for ordinary sessions.
  const foreignKeys = await client.query(`
    SELECT DISTINCT kc.relname || '.' || k.conname AS identity, 'disabled_foreign_key_trigger' AS problem
    FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_constraint k ON k.oid = t.tgconstraint
    JOIN pg_catalog.pg_class kc ON kc.oid = k.conrelid
    WHERE t.tgisinternal AND t.tgenabled NOT IN ('O', 'A')
      AND kc.relnamespace = 'public'::regnamespace AND kc.relname = ANY($1::text[])
    ORDER BY identity
  `, [[...MEMBER_MONEY_RELATIONS]]);
  findings.push(...z.array(Finding).parse(foreignKeys.rows));

  const privilege = z.object({ exempt: z.boolean() }).parse((await client.query(`
    SELECT coalesce((SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = $1), false)
      OR NOT EXISTS (SELECT 1 FROM unnest($2::text[]) AS t(name)
        WHERE pg_catalog.pg_get_userbyid((SELECT relowner FROM pg_catalog.pg_class
          WHERE oid = to_regclass(format('public.%I', t.name)))) IS DISTINCT FROM $1) AS exempt
  `, [appRole, [...MEMBER_MONEY_RELATIONS]])).rows[0]);
  const grantCheck: MemberMoneyGrantCheck = privilege.exempt ? "not_applicable" : "checked";

  if (grantCheck === "checked") {
    const grants = await client.query(`
      SELECT t.name AS identity, 'unsafe_application_grants' AS problem
      FROM unnest($2::text[]) AS t(name)
      WHERE NOT has_table_privilege($1, to_regclass(format('public.%I', t.name)), 'SELECT')
         OR NOT has_table_privilege($1, to_regclass(format('public.%I', t.name)), 'INSERT')
         OR has_table_privilege($1, to_regclass(format('public.%I', t.name)), '${APPEND_ONLY_FORBIDDEN_TABLE_PRIVILEGES}')
         OR has_any_column_privilege($1, to_regclass(format('public.%I', t.name)), 'UPDATE')
    `, [appRole, [...MEMBER_MONEY_RELATIONS]]);
    findings.push(...z.array(Finding).parse(grants.rows));
  }
  // Role-agnostic, as the migration's narrowing block is: no grantee but the
  // owner, PUBLIC included, may hold a right that changes a row, on the table or
  // on any of its columns.
  const changeRights = await client.query(`
    SELECT DISTINCT c.relname || ':' || CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
        ELSE pg_catalog.pg_get_userbyid(acl.grantee) END AS identity,
      'change_granted_beyond_owner' AS problem
    FROM pg_catalog.pg_class c
    CROSS JOIN LATERAL (
      SELECT e.grantee, e.privilege_type FROM pg_catalog.aclexplode(c.relacl) AS e
      UNION ALL
      SELECT e.grantee, e.privilege_type FROM pg_catalog.pg_attribute a
      CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) AS e
      WHERE a.attrelid = c.oid AND NOT a.attisdropped
    ) AS acl
    WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY($1::text[])
      AND acl.grantee <> c.relowner AND acl.privilege_type = ANY($2::text[])
    ORDER BY identity
  `, [[...MEMBER_MONEY_RELATIONS], [...APPEND_ONLY_FORBIDDEN_PRIVILEGE_TYPES]]);
  findings.push(...z.array(Finding).parse(changeRights.rows));
  return { findings, grantCheck };
}
