# File-size allowance for #3541

file: src/app/api/admin/deletion-requests/[id]/route.ts
lines: 1298
reason: the three-line `deletedAt` assignment belongs in the existing atomic
  member-anonymisation update; extracting that field would obscure the
  transaction boundary without reducing the route's responsibilities.
