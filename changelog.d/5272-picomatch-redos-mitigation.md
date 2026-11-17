- **The dependency audit passes again, as MITIGATED, while picomatch has no fix
  for a pattern-matching slowdown (#5252).** A high-severity advisory against
  `picomatch`, a file-pattern library used by the build and test tools, has no
  fixed release, so the required audit had failed on every change. Both
  installed copies now carry a reviewed patch, taken from a fix an outside
  contributor proposed upstream, that stops the reported patterns from
  stalling. The audit reports this as MITIGATED, never CLEAN, until 1 Dec 2026,
  and goes red again sooner if anything about the dependencies changes.

  Nothing a club or member does reaches this library: the patterns it matches
  come from this project's configuration or the tools' own defaults, never
  from a visitor. Two
  libraries that only development tools use, `qs` and `minimatch`, were also
  moved to fixed versions to clear five lesser advisories.
