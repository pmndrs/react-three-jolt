import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    {
        ignores: [
            '**/dist',
            '**/node_modules',
            '**/coverage',
            '.yarn',
            'apps/examples/public',
            'docs/out'
        ]
    },

    js.configs.recommended,
    tseslint.configs.recommended,
    react.configs.flat.recommended,
    jsxA11y.flatConfigs.recommended,

    // `apps/examples` compiles with the automatic JSX runtime (`"jsx": "react-jsx"` in its
    // tsconfig) and never imports React as a value. `packages/react-three-jolt` compiles with
    // the classic runtime (`"jsx": "react"`) and every JSX file there has a real, load-bearing
    // `import React from 'react'` - see the "React stays a *value* import" comments in
    // Floor.tsx/CommanderContext.tsx/Heightfield.tsx/CameraRig.tsx/Vehicle.tsx. Applying the
    // `jsx-runtime` config globally silences `react/jsx-uses-react`, which is what tells
    // `@typescript-eslint/no-unused-vars` that a `React` import is "used" by the JSX in that
    // file - without this scoping, ESLint flags those load-bearing imports as unused, and
    // eslint-plugin-react's own "detect installed React version and turn the rule off above
    // 19" fallback (its usual alternative to `jsx-runtime`) does not fire under React 19.2.8
    // here, so `react/react-in-jsx-scope` also has to be turned off explicitly rather than
    // relied upon to disable itself.
    {
        files: ['apps/examples/**/*.{ts,tsx}'],
        rules: react.configs.flat['jsx-runtime'].rules
    },

    {
        languageOptions: {
            globals: {
                ...globals.browser,
                ...globals.node,
                ...globals.es2021
            }
        },
        settings: {
            react: {
                version: 'detect'
            }
        },
        plugins: {
            'react-hooks': reactHooks
        },
        rules: {
            // --- Ported one-for-one from biome.json's `linter.rules` overrides ---

            // suspicious/noExplicitAny: off
            '@typescript-eslint/no-explicit-any': 'off',
            // style/noNonNullAssertion: off
            '@typescript-eslint/no-non-null-assertion': 'off',
            // style/useImportType: off
            '@typescript-eslint/consistent-type-imports': 'off',
            // complexity/noForEach: off - no ESLint equivalent, nothing to add.

            // suspicious/noDoubleEquals: error
            eqeqeq: ['error', 'always'],

            // suspicious/noTsIgnore: error
            '@typescript-eslint/ban-ts-comment': [
                'error',
                {
                    'ts-ignore': true,
                    'ts-expect-error': false,
                    'ts-nocheck': true,
                    'ts-check': false
                }
            ],

            // complexity/noBannedTypes: error - typescript-eslint 8 split this rule in three.
            '@typescript-eslint/no-unsafe-function-type': 'error',
            '@typescript-eslint/no-empty-object-type': 'error',
            '@typescript-eslint/no-wrapper-object-types': 'error',

            // suspicious/useIterableCallbackReturn: error
            'array-callback-return': 'error',

            // suspicious/noRedeclare: warn (base rule is already off for .ts/.tsx via
            // typescript-eslint/eslint-recommended, which typescript-eslint.configs.recommended
            // includes)
            '@typescript-eslint/no-redeclare': 'warn',

            // a11y/noStaticElementInteractions: warn (jsx-a11y's flat recommended config ships
            // this at "error"; Biome had it at "warn")
            'jsx-a11y/no-static-element-interactions': 'warn',

            // a11y/useButtonType: warn - not part of eslint-plugin-react's recommended config,
            // added explicitly.
            'react/button-has-type': 'warn',

            // Biome's default noUnusedImports/noUnusedVariables (warn). typescript-eslint's
            // recommended config turns the base `no-unused-vars` off and turns on
            // `@typescript-eslint/no-unused-vars` at "error"; Biome had this at "warn". Biome
            // also treats a leading underscore as "intentionally unused" and never reports it;
            // this codebase relies on that convention throughout (`_pid`, `_inSettings`, ...),
            // so the ignore patterns are carried over to avoid ~20 warnings Biome never raised.
            '@typescript-eslint/no-unused-vars': [
                'warn',
                {
                    argsIgnorePattern: '^_',
                    varsIgnorePattern: '^_',
                    caughtErrorsIgnorePattern: '^_'
                }
            ],

            // Biome's useExhaustiveDependencies. eslint-plugin-react-hooks 7 ships a much bigger
            // "React Compiler" rule set in every one of its preset configs (static-components,
            // purity, immutability, set-state-in-render, etc.) - none of that is part of what
            // Biome enforced, so those presets are intentionally not used here. Only the two
            // rules Biome's coverage maps to are wired up:
            'react-hooks/rules-of-hooks': 'error',
            'react-hooks/exhaustive-deps': 'warn',

            // suspicious/noImplicitAnyLet: error - no ESLint equivalent. tsconfig's
            // `noImplicitAny` covers this at build time instead; see LINTING.md.

            // --- Not in biome.json - required to get a clean baseline from eslint-plugin-react's
            // "recommended" preset, which was written for a plain-DOM, PropTypes-era React app ---

            // eslint-plugin-react has no idea about @react-three/fiber's Three.js-backed
            // intrinsics (<mesh position=.../>, <bufferGeometry args=.../>, etc.) - it only knows
            // the DOM's attribute list, so this fired 365 false positives across the example app
            // and every component test. Biome never had an equivalent check (it doesn't type
            // JSX elements at all), so this isn't a loss of coverage, just noise this plugin
            // cannot avoid for a react-three-fiber codebase.
            'react/no-unknown-property': 'off',

            // Every prop here is typed with a TS interface/type, never React.PropTypes - the
            // rule cannot see those and reported 9 false "missing in props validation" errors.
            // tsc is the actual prop checker for this codebase.
            'react/prop-types': 'off',

            // Flags anonymous components passed straight to `memo(...)`/`forwardRef(...)` or
            // exported as an inline arrow function, both idiomatic here and irrelevant to
            // debugging (React DevTools infers a name from the assignment in all these cases).
            'react/display-name': 'off',

            // `(a.x = 1), (b.y = 2);` comma-operator assignment chains (mesh-tools.ts's
            // triangle-vertex setup, a couple of test probes) trip this at "error" by default.
            // Biome's closest equivalent, noCommaOperator, was already only a "warn" that never
            // blocked `yarn lint`; keep the same non-blocking severity rather than rewrite the
            // chains or silence them file-by-file.
            '@typescript-eslint/no-unused-expressions': 'warn'
        }
    },

    // Must be last: turns off stylistic rules (from the configs above) that would otherwise
    // fight Prettier. This repo does not use eslint-plugin-prettier - formatting stays a
    // separate `prettier` command, matching drei/react-three-fiber.
    eslintConfigPrettier
);
