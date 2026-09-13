- **The security scanner now has to prove what it actually read (#2842).** A
  Semgrep run could finish green while it had quietly failed to parse some
  files, or given up running rules on others, so nobody could tell scanned code
  from unscanned code. The scan now fails the build if its real coverage
  shrinks, and the suppressions that had built up were re-measured and cut to
  the three that still do anything. Members and administrators see no change;
  the figures and the maintenance steps are in `docs/MAINTENANCE.md`.
