# File-size allowance for #2934 (pull request #3475)

One file, and the growth is the fix itself.

file: src/app/(admin)/admin/committee/page.tsx
lines: 819
reason: eighteen lines on a 800-line route shell, and they are the change this
  issue exists to make. The committee screen was the last admin surface deciding
  its attention TWICE — `closeRoleForm(); await fetchCommitteeData();
  scrollToTop(pageRef);` in the save handler, and a separate `if (error)
  scrollToError(errorRef)` effect. `fetchCommitteeData` sets an error of its
  own, so a role that POSTed successfully and then failed its refresh ran both:
  two smooth scrolls raced and the admin was left at the top of the page with
  the failure off-screen below it. Routing it through the shared
  `useActionAttention` makes "failure wins" structural rather than policed, and
  costs a state hook and a six-line call — plus the comment recording the defect
  that shape produced, which is the part a future reader needs and the part that
  would be lost if the lines were trimmed to satisfy this gate.
  Splitting is not the answer available here. The seam in this file is between
  the roles editor and the assignments editor, which is a piece of work in its
  own right; carving one out to make room for an attention hook would move the
  hook away from the two save handlers whose outcomes it decides, which is the
  drift this issue removes everywhere else. The file was already 301 lines over
  its route-shell ceiling before this change and is not made materially worse by
  it.
