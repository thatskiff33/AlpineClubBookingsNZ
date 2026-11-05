# File-size allowance for #4742

file: src/app/api/admin/lodge/route.ts
lines: 505
reason: the four added lines are the passwordChangedAt stamp (and its
  comment) on the existing kiosk-password write in PUT, which is what signs
  out a tablet already signed in when an officer rotates the password. The
  stamp has to sit on the same update as the new passwordHash; splitting the
  route to make room for it would move one field of one write into another
  file and is worse than the four lines.
