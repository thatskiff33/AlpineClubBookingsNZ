- **Bed-allocation writers now verify their database locks (#4929).** A caller
  missing a required lock is refused before it can change beds. Automated
  checks also catch new entrypoints that omit this protection.
