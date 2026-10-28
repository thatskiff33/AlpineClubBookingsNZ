- **Migration guidance explains why applied files must stay unchanged (#4486).**
  The documentation now records the behavior measured on Prisma 7.10.1:
  production deploys overlook edited migrations, while development databases
  demand a destructive reset. Editing also loses the record of what ran;
  corrections still require a new migration.
