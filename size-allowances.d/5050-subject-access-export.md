# File-size allowances for #5050 (subject access export, issue #4915)

file: src/app/(admin)/admin/membership/members/[id]/page.tsx
lines: 1360
reason: the page gains one import and a three-line mount of the new
  `SubjectAccessReport` card, gated on the Full Admin flag the page already
  holds. The card's logic, request and download live in its own component;
  what stays here is where the card sits among the member's records, which
  only reads right in the page's own layout. Splitting the member detail page
  is a refactor of its own, out of this issue's scope.

file: src/app/(authenticated)/profile/page.tsx
lines: 713
reason: the download card's copy now says what the file holds, that it
  lists exclusions, and who answers the rest (the issue's acceptance
  criterion for honest wording). The sentence is two lines longer than the
  old one; moving one paragraph of copy out of the page would hide it from
  the card it describes.

function: src/app/(admin)/admin/membership/members/[id]/page.tsx#MemberDetailPage
lines: 1249
reason: subject access export and Full Admin report; those lines sit inside
  the function `MemberDetailPage`, which was already over its limit before
  this change, and lifting it apart is a refactor of its own, not part of this
  fix.

function: src/app/(authenticated)/profile/page.tsx#ProfilePage
lines: 583
reason: subject access export and Full Admin report; those lines sit inside
  the function `ProfilePage`, which was already over its limit before this
  change, and lifting it apart is a refactor of its own, not part of this fix.
