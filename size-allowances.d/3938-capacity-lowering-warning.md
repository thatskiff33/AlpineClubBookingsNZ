# File-size allowance for #3938: capacity lowering warning

file: src/app/(admin)/admin/lodges/[id]/page.tsx
lines: 636
reason: the page now names the guidance block once (`LODGE_CAPACITY_GUIDANCE_ID`) and derives the lowering warning's id from the component's exported helper. The review found the warning id duplicated between page and component, and this replaces that. The page also passes the saved capacity to the guidance, so a lodge with no saved figure still gets the warning. The warning itself lives in `lodge-capacity-guidance.tsx`. What is left here is the import, the one id constant and one prop, and splitting the page around them would not shorten anything.
