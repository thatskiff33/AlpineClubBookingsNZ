- **CI now stops the app's top-level functions growing past 300 lines
  (#4927).** The file-size check only measured whole files, so one very long
  function could grow inside a file that was already allowed to be long. The
  same check now also measures top-level functions, functions assigned to
  top-level constants, and class methods. Functions that are already over 300
  lines may stay as they are, but may not get longer, and a new function may
  not start out over the limit. A contributor who really has to grow one
  explains why in the same per-change allowance file used for long files.

  Nothing a club or member sees has changed. This is a development safeguard.
