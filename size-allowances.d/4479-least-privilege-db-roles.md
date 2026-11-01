# File-size allowances for #4479 — least-privilege database roles (#4453)

Three already-oversized modules grow because this change keeps one source for
something that would otherwise be copied, or wires a guard where it applies.

file: src/lib/audit-retention.ts
lines: 893
reason: the optional `AUDIT_RETENTION_DATABASE_URL` client, built by the one
  `createStandaloneClient` helper that the archive client already used, and the
  job's selection between it and the app client, and the one reader of the
  archive URL that the backup guard now shares (`configuredAuditArchiveDatabaseUrl`). Moving retention's connection
  handling to another module would split the job from the client it must run
  on, which is the pairing the realdb test proves.

file: src/lib/diagnostics/tools/provision-role.ts
lines: 1185
reason: `buildCreateLoginRoleIfAbsentSql`, `buildStripAllRoleMembershipsSql` and
  `LEAST_PRIVILEGE_ROLE_ATTRIBUTES` became shared exports so the new role
  builder reuses the AI Diagnostics builder's role-creation, membership-strip
  and attribute SQL instead of copying it (INV-SSOT), and `quoteLiteral` now
  refuses a backslash for both builders (review S-F7). The diagnostics
  builder's statement list is byte-identical.

file: src/lib/backup.ts
lines: 746
reason: the restore-validation step's two call sites for the #4453 review fixes
  (S-F2, N2, N5, R4): the guard now asks `isSameDatabaseTarget` against the live
  and the audit archive databases, with a refusal message for each, and the
  validation restore is one call to the streamed, owner-and-grant-stripping
  `restoreDumpWithoutOwnershipOrPrivileges`. Both helpers live in
  `src/lib/backup-restore-validation.ts`; only the import and the two calls,
  with a line of reason each, are here, beside the psql steps around them. A
  refused target skips only the validation (R4): the dump is still taken and
  stored, so the refusal returns the stored backup's result, which needs the
  run's own locals and so stays beside them.
