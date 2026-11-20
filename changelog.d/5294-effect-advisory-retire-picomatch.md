- **The dependency audit is clean again (#5293).** A new high-severity
  advisory against `effect`, a library Prisma's configuration tooling uses,
  had turned the required audit red. Prisma's newest release still asks for
  the affected version, so this project now takes the fixed `effect` release
  itself; Prisma's generate, migrate and drift checks were re-run against it.

  The temporary picomatch patches added in #5272 are removed: GitHub withdrew
  that advisory on 18 Nov 2026, so the audit no longer needs them. Nothing
  changes for clubs or members.
