# File-size allowances for #5006

A passkey is another way the member is enrolled. The session flag and the
profile card already live in these two files, beside the authenticator-app
facts they now include.

file: src/lib/auth.ts
lines: 919
reason: hasPasskey is copied onto the token and the session in the same jwt
  and session callbacks that already set twoFactorEnrolled, and that flag is
  now derived from the passkey as well. Splitting the callback would separate
  the enrolment bit from the flag it feeds.

file: src/app/(authenticated)/profile/page.tsx
lines: 709
reason: the passkey list is read for the security card on this page and
  passed into that card. Moving the read out would put the list and the card
  that shows it in different files.
