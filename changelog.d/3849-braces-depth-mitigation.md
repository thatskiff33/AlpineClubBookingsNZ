- **The dependency audit can pass a reviewed, patched advisory as "MITIGATED",
  never as clean (#3843).** A high-severity advisory against `braces@3.0.3`, a
  file-matching library with no fixed release, had turned the required
  dependency audit red for every change. The copy the audit sees is reached only
  through a development tool (the lint configuration). Further copies are
  compiled inside build, test and developer tools, two of them production
  dependencies (the prisma CLI, and rollup through the Sentry build plugin); a
  trace found none of them reachable by input from outside the club's own
  developers and build. The repository now applies the reviewed
  upstream fix as a patch at install time, including in the Docker image build,
  and the audit reports **MITIGATED — NOT CLEAN**, with a warning on the run,
  while an owner-approved record matches that exact patch and the exact
  dependency files it was reviewed against.

  The advisory stays visible in the audit output. Any further advisory, any
  dependency change, or the record's expiry on 10 October 2026 turns the check
  red again; a record can never run for more than 14 days ahead. Mitigation
  records, patches and the audit scripts now need the owner's code-owner
  approval. The record covers only the copy the audit can see, and lists the
  others; retiring it is tracked on #3851. Operators need do nothing.
