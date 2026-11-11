# File-size allowances for the Fees & booking rules hub move (#4803)

Each of these files links a Fees & booking rules page, and now takes that link
from the hub registry (`adminHref`) instead of writing the URL by hand, so the
link follows the page when the switch goes on. The only growth in each is the
one line that imports `adminHref`; the links themselves stay the same length.

file: src/app/(admin)/admin/lodges/[id]/page.tsx
lines: 665
reason: one import line, so the Seasons & Rates card and its fees and seasons
  permission checks come from the hub registry. The cards belong with the rest
  of the lodge hub.

file: src/app/(admin)/admin/lodges/[id]/setup/page.tsx
lines: 965
reason: one import line, so the seasons link comes from the hub registry. The
  link sits inside the setup step it explains.

file: src/app/(admin)/admin/membership/membership-types/page.tsx
lines: 1904
reason: one import line, so the age tier settings link comes from the hub
  registry. Splitting the membership-types editor to absorb an import would
  move code for no gain.

file: src/app/(admin)/admin/rules/fees/_components/hut-fees-section.tsx
lines: 1271
reason: one import line, so the Seasons link comes from the hub registry. The
  link sits in the section header it explains.
