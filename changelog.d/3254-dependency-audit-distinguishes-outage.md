- **A failed dependency check now says whether npm was down or a real problem
  was found (#3254).** The `Dependency audit` check asks npmjs.org for the list
  of known security problems in the software this site depends on. When that
  service had a bad hour on 4 September the check went red three times in a row
  with nothing actually wrong — and it looked exactly the same as it would have
  if a genuine security problem had been found. The only way to tell was to open
  the log and find a warning line in it.

  The check now retries a few times when npmjs.org does not answer, and if it
  still cannot get through it says so in plain words on the first line: the
  advisory service was unreachable, this is not a vulnerability, try again once
  npm has recovered. A real security finding says the opposite just as plainly,
  and lists the packages.

  Nothing about what counts as a problem changed — a high or critical advisory
  still stops a release, exactly as before. The deliberate trade is that if
  npmjs.org is down for a long stretch, releases wait: a security check that
  could not do its job is not allowed to report success.
