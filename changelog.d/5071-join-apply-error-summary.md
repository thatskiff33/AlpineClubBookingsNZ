- **A membership application that cannot be submitted now always says why,
  next to the Submit button (#4947).** Pressing **Submit membership
  application** with a field missing used to change nothing near the button:
  the red message appeared beside the field, often several screens up, and
  some refusals from the server (a phone number that is too long, a problem
  with a household member) were not shown anywhere at all, so the applicant
  could not find out what was wrong.

  A failed submit now shows one message above the button that says how many
  fields need attention and lists each problem, with a link that jumps to the
  field. The page moves to that message and screen readers read it out. Every
  problem the server reports is listed there, including ones that cannot be
  matched to a single box, and the phone row now shows its own error.
