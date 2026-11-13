- **Sekreton's task sandbox now runs more of CI's checks before a pull request
  is opened.** Alongside lint, knip and the kept-change PostgreSQL suites, its
  gate now runs the production TypeScript check (`pnpm run typecheck:src`, on
  runners with enough memory; it is skipped on 4 GB compute), the
  fast tree-wide censuses with the file-size ratchet, and a migration check that
  runs drift and the data-migration verification suites on a disposable
  PostgreSQL whenever a change can affect them. Both PostgreSQL checks share one
  helper that starts the throwaway database.

  This is for contributors and operators of the agent pipeline only. Nothing
  changes for club members or administrators.
