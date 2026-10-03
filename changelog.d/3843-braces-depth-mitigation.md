- **The dependency audit can pass a reviewed, patched advisory as "MITIGATED",
  never as clean (#3843).** A high-severity advisory against `braces@3.0.3`, a
  development-only file-matching library with no fixed release, had turned the
  required dependency audit red for every change. The repository now applies
  the reviewed upstream fix as a patch at install time, including in the Docker
  image build, and the audit reports **MITIGATED — NOT CLEAN** while an
  owner-approved record matches that exact patch and the exact dependency files
  it was reviewed against.

  The advisory stays visible in the audit output. Any further advisory, any
  dependency change, or the record's expiry on 10 October 2026 turns the check
  red again. The mitigation covers only the copy the audit can see; nine copies
  bundled inside build and developer tools (rollup, the prisma CLI and helpers,
  vite, tsx) are listed as known and out of reach, after a trace found none of
  them can receive input from outside the club's own developers and build.
  Operators need do nothing.
