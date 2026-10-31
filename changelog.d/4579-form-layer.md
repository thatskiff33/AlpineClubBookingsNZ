- **The committee role form now points at what needs fixing (#4467).** When a
  role cannot be saved because a field is wrong, such as a missing role name
  or a role email that is not an address, the form says so next to that
  field, and a list at the top of the form names every problem and links to
  each field. The list takes the keyboard and screen-reader focus, so it is
  read out straight away. Before, the browser's own pop-up caught some of
  these, and the rest came back as a bare "Invalid input" at the top of the
  page.

  Saving a correct role works exactly as before. This form is the first on a
  shared form layer that other forms will move to.
