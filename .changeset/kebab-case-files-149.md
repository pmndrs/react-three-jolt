---
'@react-three/jolt': patch
---

#149: renamed the remaining camelCase/PascalCase source files to kebab-case, and `.tsx` files
with no JSX to `.ts`:

- `utils/meshTools.ts` -> `utils/mesh-tools.ts`
- `heightField/` -> `heightfield/` (including `Generators.ts` -> `generators.ts`)
- `hooks/use-constraint.tsx` -> `hooks/use-constraint.ts` (no JSX - the only `<...>` in the file
  is a generic type parameter)
- `hooks/use-raycasters.tsx` -> `hooks/use-raycasters.ts` (same)

Every import was updated in place (`git mv` + path fixes); every symbol is re-exported by the same
name from the same package entry points, so this has no effect on consumers importing from
`@react-three/jolt` or `@react-three/jolt/*`'s public exports.
