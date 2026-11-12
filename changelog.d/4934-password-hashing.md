- **Member imports no longer hash hundreds of throwaway passwords (#4934).**
  Imported and placeholder accounts now share an unusable password hash until
  the member sets a password. Sign-ins and hut-leader PIN checks run bcrypt on
  background threads, so the server keeps answering other requests.
  The password work factor stays 13 and existing passwords keep working.
