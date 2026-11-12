# File-size allowance for #4811

The role-menu branch has to sit in the sidebar next to the off-state catalogue,
so the hub list and the existing section menu cannot render together.

file: src/components/admin-sidebar.tsx
lines: 1142
reason: the choice between the role's hub list and today's section menu has to
  sit beside SidebarLinks, which is the catalogue this file exists to hold.
  The hub links and the switcher already live in admin-sidebar-controls.tsx;
  lifting the branch out would pass that catalogue through a new seam.
