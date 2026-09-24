import type { AccessRole, Prisma } from "@prisma/client";
import {
  getAdminPermissionMatrix,
  matrixFromAccessRoleDefinition,
  mergeAdminPermissionMatrices,
  type AdminPermissionMatrix,
} from "@/lib/admin-permissions";
import {
  ACCESS_ROLE_DESCRIPTIONS,
  ACCESS_ROLE_LABELS,
  isAccessRole,
  type AccessRoleDefinitionLevelFields,
  type AppAccessRole,
} from "@/lib/access-roles";

/**
 * Editable access-role definitions: database rows behind every role except
 * the protected system roles (ADMIN, LODGE, USER, ORG), which stay
 * code-defined. The six seeded defaults keep their legacy enum value in
 * `systemRole`; custom roles have `systemRole: null` and are referenced by
 * definition id.
 */

export const ACCESS_ROLE_DEFINITION_SELECT = {
  id: true,
  key: true,
  systemRole: true,
  label: true,
  description: true,
  overviewLevel: true,
  bookingsLevel: true,
  membershipLevel: true,
  financeLevel: true,
  lodgeLevel: true,
  contentLevel: true,
  supportLevel: true,
  sortOrder: true,
} as const;

export type AccessRoleDefinitionRecord = Prisma.AccessRoleDefinitionGetPayload<{
  select: typeof ACCESS_ROLE_DEFINITION_SELECT;
}>;

/**
 * Assignment-row select carrying the joined definition, so
 * getAdminPermissionMatrix can resolve definition-backed roles without a
 * second query. Use this (not a bare `{ role: true }`) wherever a member's
 * access roles feed permission checks.
 */
export const MEMBER_ACCESS_ROLE_SELECT = {
  role: true,
  roleDefinitionId: true,
  roleDefinition: { select: ACCESS_ROLE_DEFINITION_SELECT },
} as const;

/**
 * The member fields a privilege decision reads (#3603): `canLogin` together
 * with the joined access-role rows. Spread it into any member query whose
 * result feeds `requireAdmin`-style gates, the admin permission matrix,
 * `hasAdminAccess`, `isFullAdmin`, `hasPrivilegedAccess`, `hasLodgeAccess` or
 * `authorizationRoleFromAccessRoles`. Those take a `PrivilegeCheckInput`, which
 * requires `canLogin`, so a query that drops it no longer compiles into a
 * gate — the rows alone would resolve a login-disabled member's full stored
 * roles.
 */
export const MEMBER_PRIVILEGE_CHECK_SELECT = {
  canLogin: true,
  accessRoles: { select: MEMBER_ACCESS_ROLE_SELECT },
} as const;

/**
 * Candidate rows for any "which admins…" query (#2548): active, able to sign
 * in, and holding at least one access-role assignment beyond the plain
 * USER/ORG classification.
 *
 * The narrowing matters. Every ordinary member carries a `USER` assignment row
 * (the access-role backfill wrote one for each of them), so a bare
 * `accessRoles: { some: {} }` would load the entire club — with joined role
 * definitions — every time an alert fires. Definition-backed custom roles have
 * `role: null`, hence the second clause: they are matched on the definition
 * link instead. This is only a candidate filter; the real answer always comes
 * from resolving the permission matrix over the rows it returns.
 */
export const ADMIN_CAPABLE_MEMBER_WHERE = {
  active: true,
  canLogin: true,
  accessRoles: {
    some: {
      OR: [{ role: { notIn: ["USER", "ORG"] } }, { roleDefinitionId: { not: null } }],
    },
  },
} satisfies Prisma.MemberWhereInput;

/** JSON-safe shape for client components and API responses. */
export type AccessRoleDefinitionSummary = {
  id: string;
  key: string;
  systemRole: AccessRole | null;
  label: string;
  description: string;
  sortOrder: number;
  permissions: AdminPermissionMatrix;
};

export function serializeAccessRoleDefinition(
  definition: AccessRoleDefinitionRecord,
): AccessRoleDefinitionSummary {
  return {
    id: definition.id,
    key: definition.key,
    systemRole: definition.systemRole,
    label: definition.label,
    description: definition.description,
    sortOrder: definition.sortOrder,
    permissions: matrixFromAccessRoleDefinition(definition),
  };
}

type AccessRoleDefinitionReader = {
  accessRoleDefinition: Pick<
    Prisma.TransactionClient["accessRoleDefinition"],
    "findMany"
  >;
};

export async function loadAccessRoleDefinitions(
  db: AccessRoleDefinitionReader,
): Promise<AccessRoleDefinitionRecord[]> {
  return db.accessRoleDefinition.findMany({
    orderBy: [{ sortOrder: "asc" }, { key: "asc" }],
    select: ACCESS_ROLE_DEFINITION_SELECT,
  });
}

/**
 * The six seeded editable defaults. Matrices are identical to the legacy
 * hardcoded ADMIN_ROLE_BUNDLES at seed time; the club may edit or delete any
 * of them afterwards, so ensureAccessRoleDefinitions never updates an
 * existing row. Ids and keys are fixed so the migration INSERT and this
 * helper always agree.
 */
export const DEFAULT_ACCESS_ROLE_DEFINITIONS: ReadonlyArray<
  {
    id: string;
    key: string;
    systemRole: AppAccessRole;
    label: string;
    description: string;
    sortOrder: number;
  } & AccessRoleDefinitionLevelFields
> = [
  {
    id: "ardef_admin_readonly",
    key: "read-only-admin",
    systemRole: "ADMIN_READONLY",
    label: ACCESS_ROLE_LABELS.ADMIN_READONLY,
    description: ACCESS_ROLE_DESCRIPTIONS.ADMIN_READONLY,
    overviewLevel: "VIEW",
    bookingsLevel: "VIEW",
    membershipLevel: "VIEW",
    financeLevel: "VIEW",
    lodgeLevel: "VIEW",
    contentLevel: "VIEW",
    supportLevel: "VIEW",
    sortOrder: 10,
  },
  {
    id: "ardef_admin_bookings",
    key: "booking-officer",
    systemRole: "ADMIN_BOOKINGS",
    label: ACCESS_ROLE_LABELS.ADMIN_BOOKINGS,
    description: ACCESS_ROLE_DESCRIPTIONS.ADMIN_BOOKINGS,
    overviewLevel: "VIEW",
    bookingsLevel: "EDIT",
    membershipLevel: "VIEW",
    financeLevel: "VIEW",
    lodgeLevel: "EDIT",
    contentLevel: "NONE",
    supportLevel: "VIEW",
    sortOrder: 20,
  },
  {
    id: "ardef_admin_membership",
    key: "membership-officer",
    systemRole: "ADMIN_MEMBERSHIP",
    label: ACCESS_ROLE_LABELS.ADMIN_MEMBERSHIP,
    description: ACCESS_ROLE_DESCRIPTIONS.ADMIN_MEMBERSHIP,
    overviewLevel: "VIEW",
    bookingsLevel: "VIEW",
    membershipLevel: "EDIT",
    financeLevel: "VIEW",
    lodgeLevel: "NONE",
    contentLevel: "NONE",
    supportLevel: "VIEW",
    sortOrder: 30,
  },
  {
    id: "ardef_admin_content",
    key: "content-manager",
    systemRole: "ADMIN_CONTENT",
    label: ACCESS_ROLE_LABELS.ADMIN_CONTENT,
    description: ACCESS_ROLE_DESCRIPTIONS.ADMIN_CONTENT,
    overviewLevel: "VIEW",
    bookingsLevel: "NONE",
    membershipLevel: "NONE",
    financeLevel: "NONE",
    lodgeLevel: "NONE",
    contentLevel: "EDIT",
    supportLevel: "NONE",
    sortOrder: 40,
  },
  {
    id: "ardef_finance_user",
    key: "finance-viewer",
    systemRole: "FINANCE_USER",
    label: ACCESS_ROLE_LABELS.FINANCE_USER,
    description: ACCESS_ROLE_DESCRIPTIONS.FINANCE_USER,
    overviewLevel: "NONE",
    bookingsLevel: "NONE",
    membershipLevel: "NONE",
    financeLevel: "VIEW",
    lodgeLevel: "NONE",
    contentLevel: "NONE",
    supportLevel: "NONE",
    sortOrder: 50,
  },
  {
    id: "ardef_finance_admin",
    key: "treasurer",
    systemRole: "FINANCE_ADMIN",
    label: ACCESS_ROLE_LABELS.FINANCE_ADMIN,
    description: ACCESS_ROLE_DESCRIPTIONS.FINANCE_ADMIN,
    overviewLevel: "VIEW",
    bookingsLevel: "VIEW",
    membershipLevel: "VIEW",
    financeLevel: "EDIT",
    lodgeLevel: "NONE",
    contentLevel: "NONE",
    supportLevel: "VIEW",
    sortOrder: 60,
  },
];

type AccessRoleDefinitionWriter = {
  accessRoleDefinition: Pick<
    Prisma.TransactionClient["accessRoleDefinition"],
    "upsert"
  >;
  memberAccessRole: Pick<
    Prisma.TransactionClient["memberAccessRole"],
    "updateMany"
  >;
};

/**
 * Idempotently create any missing seeded default definitions and re-link
 * enum-only assignment rows to them. Existing rows are never updated
 * (upsert with an empty update), so club edits survive re-seeding. Note
 * that a seeded default the club deleted outright is re-created by the next
 * seed run — deletion of a default is expected to be "delete or repurpose",
 * and seeds only run at install/restore time.
 */
export async function ensureAccessRoleDefinitions(
  db: AccessRoleDefinitionWriter & AccessRoleDefinitionReader,
) {
  for (const definition of DEFAULT_ACCESS_ROLE_DEFINITIONS) {
    await db.accessRoleDefinition.upsert({
      where: { key: definition.key },
      update: {},
      create: definition,
    });
  }

  // Re-link enum rows written while a definition link was missing (e.g. by
  // old code during a deploy window). Only rows whose systemRole definition
  // exists are touched; rows for deleted defaults keep resolving via the
  // legacy fallback bundle.
  const definitions = await loadAccessRoleDefinitions(db);
  for (const definition of definitions) {
    if (!definition.systemRole) continue;
    await db.memberAccessRole.updateMany({
      where: { role: definition.systemRole, roleDefinitionId: null },
      data: { roleDefinitionId: definition.id },
    });
  }

  return definitions;
}

function buildAccessRoleKey(label: string) {
  const key = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return key || "role";
}

export async function buildUniqueAccessRoleKey(
  db: {
    accessRoleDefinition: Pick<
      Prisma.TransactionClient["accessRoleDefinition"],
      "findUnique"
    >;
  },
  label: string,
) {
  const baseKey = buildAccessRoleKey(label);
  let key = baseKey;
  let suffix = 2;

  while (
    await db.accessRoleDefinition.findUnique({
      where: { key },
      select: { id: true },
    })
  ) {
    key = `${baseKey}-${suffix}`;
    suffix += 1;
  }

  return key;
}

/**
 * A selectable role in the member editor: protected system roles plus every
 * definition. `token` is what gets submitted — the enum value for system
 * roles and seeded defaults, the definition id for custom roles.
 */
export type AccessRoleOption = {
  token: string;
  label: string;
  description: string;
  permissions: AdminPermissionMatrix;
  privileged: boolean;
  system: boolean;
  definitionId: string | null;
};

const SYSTEM_ROLE_ORDER_HEAD: readonly AppAccessRole[] = ["USER", "ADMIN"];
const SYSTEM_ROLE_ORDER_TAIL: readonly AppAccessRole[] = ["LODGE", "ORG"];

function systemRoleOption(role: AppAccessRole): AccessRoleOption {
  return {
    token: role,
    label: ACCESS_ROLE_LABELS[role],
    description: ACCESS_ROLE_DESCRIPTIONS[role],
    permissions: getAdminPermissionMatrix({
      accessRoles: [role],
      canLogin: true,
    }),
    privileged: role !== "USER" && role !== "ORG",
    system: true,
    definitionId: null,
  };
}

export function buildAccessRoleOptions(
  definitions: ReadonlyArray<AccessRoleDefinitionRecord>,
): AccessRoleOption[] {
  return [
    ...SYSTEM_ROLE_ORDER_HEAD.map(systemRoleOption),
    ...definitions.map((definition) => ({
      token: definition.systemRole ?? definition.id,
      label: definition.label,
      description: definition.description,
      permissions: matrixFromAccessRoleDefinition(definition),
      privileged: true,
      system: false,
      definitionId: definition.id,
    })),
    ...SYSTEM_ROLE_ORDER_TAIL.map(systemRoleOption),
  ];
}

/**
 * Static options from the legacy constants and bundles, used by client
 * components as a placeholder until the database-backed options load.
 * Toggling submits enum tokens, which stay valid regardless.
 */
export function buildFallbackAccessRoleOptions(): AccessRoleOption[] {
  return [
    ...SYSTEM_ROLE_ORDER_HEAD.map(systemRoleOption),
    ...DEFAULT_ACCESS_ROLE_DEFINITIONS.map((definition) => ({
      token: definition.systemRole,
      label: definition.label,
      description: definition.description,
      permissions: matrixFromAccessRoleDefinition(definition),
      privileged: true,
      system: false,
      definitionId: null,
    })),
    ...SYSTEM_ROLE_ORDER_TAIL.map(systemRoleOption),
  ];
}

/** Display label for a role token: option label, enum label, or the token. */
export function accessRoleLabelForToken(
  token: string,
  options?: ReadonlyArray<AccessRoleOption>,
): string {
  const option = options?.find((candidate) => candidate.token === token);
  if (option) return option.label;
  if (isAccessRole(token)) return ACCESS_ROLE_LABELS[token];
  return token;
}

/**
 * Merged preview matrix for a set of selected option tokens — pure, so the
 * client-side picker can show live previews without database access.
 */
export function previewMatrixForTokens(
  tokens: ReadonlyArray<string>,
  options: ReadonlyArray<AccessRoleOption>,
): AdminPermissionMatrix {
  return mergeAdminPermissionMatrices(
    options
      .filter((option) => tokens.includes(option.token))
      .map((option) => option.permissions),
  );
}

/**
 * Resolve submitted tokens to assignment-row shapes: enum value for system
 * roles (linked to their seeded definition when present), definition id for
 * custom roles. Unknown tokens are dropped — callers validate and reject
 * before persisting.
 */
export function accessRoleAssignmentRowsFromTokens(
  tokens: ReadonlyArray<string>,
  definitions: ReadonlyArray<AccessRoleDefinitionRecord>,
): Array<{
  role: AppAccessRole | null;
  roleDefinitionId: string | null;
  roleDefinition: AccessRoleDefinitionRecord | null;
}> {
  const rows: Array<{
    role: AppAccessRole | null;
    roleDefinitionId: string | null;
    roleDefinition: AccessRoleDefinitionRecord | null;
  }> = [];
  const seen = new Set<string>();

  for (const token of tokens) {
    if (!token || seen.has(token)) continue;
    seen.add(token);

    if (isAccessRole(token)) {
      const definition =
        definitions.find((candidate) => candidate.systemRole === token) ?? null;
      rows.push({
        role: token,
        roleDefinitionId: definition?.id ?? null,
        roleDefinition: definition,
      });
      continue;
    }

    const definition = definitions.find((candidate) => candidate.id === token);
    if (definition) {
      rows.push({
        role: null,
        roleDefinitionId: definition.id,
        roleDefinition: definition,
      });
    }
  }

  return rows;
}

/** True when every submitted token is a known enum value or definition id. */
export function findUnknownAccessRoleTokens(
  tokens: ReadonlyArray<string>,
  definitions: ReadonlyArray<AccessRoleDefinitionRecord>,
): string[] {
  return tokens.filter(
    (token) =>
      !isAccessRole(token) &&
      !definitions.some((candidate) => candidate.id === token),
  );
}
