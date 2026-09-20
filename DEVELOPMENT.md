# Development

The `@react-three/jolt` repository is structured as a yarn monorepo.

You will find published packages inside `./packages`, and deployed applications in `./apps`.

## Node

**This project uses node 22.**

If you don't already use a node version manager. Give nvm a try:

https://github.com/nvm-sh/nvm

## Yarn

**This project uses yarn 4.**

If you have Corepack enabled, you should be able to use this project's yarn version without doing anything special. If you don't have Corepack enabled, you can enable it by running the following:

```sh
> corepack enable
```

## Building

Once you have the above installed, run the following to install dependencies and build the project:

```sh
> yarn install
> yarn build
```

## Examples

To run the examples, you can run the following:

```sh
> cd apps/examples
> yarn dev
```

_Sidenote: to get HMR to work while running examples, open a seperate terminal to the react-three-jolt package and run:_

```sh
yarn build -w
```

## Documentation

The user-facing documentation lives in [`docs/`](./docs) as MDX and is built by
[`pmndrs/docs`](https://github.com/pmndrs/docs), the shared documentation generator behind
[docs.pmnd.rs](https://docs.pmnd.rs) (the same one react-three-fiber and drei use).

Layout and conventions:

- One folder per section (`getting-started/`, `api/`, `advanced/`), one `.mdx` file per page.
  The published URL mirrors the path: `docs/api/physics.mdx` → `/api/physics`.
- Every page starts with front matter:

  ```md
  ---
  title: Physics
  description: The <Physics> component and its props.
  nav: 3
  ---
  ```

  `nav` is a single ordering number shared across **all** pages — it drives the sidebar order,
  so inserting a page means renumbering the ones after it.
- GitHub-flavoured callouts (`> [!NOTE]`, `> [!WARNING]`, …) and standard MDX are supported.
- Images are relative to the page and inlined at build time (`MDX_BASEURL`), so put them next
  to the `.mdx` that uses them.

Preview locally:

```sh
> yarn docs        # builds the site and serves it on http://localhost:3000
> yarn docs:build  # static build only, into docs/out (gitignored)
```

`yarn docs` runs the preview script published by `pmndrs/docs`; it needs `curl` and network
access and serves the MDX folder alongside the site so relative assets resolve while editing.

### Publishing (one-time repo setup — owner only)

[`.github/workflows/docs.yml`](./.github/workflows/docs.yml) builds `docs/` on every push to
`main` that touches it (and on manual dispatch) and deploys it to GitHub Pages. It calls the
reusable workflow `pmndrs/docs/.github/workflows/build.yml@v4` and needs **no secrets** — it
authenticates with the automatic `GITHUB_TOKEN`.

Two things a repo admin has to do once before the first deploy succeeds:

1. **Settings → Pages → Build and deployment → Source: “GitHub Actions”.** The workflow calls
   `actions/configure-pages` with `enablement: true`, which can turn Pages on by itself when
   the token has `pages: write` (granted in the workflow), but a repo whose Pages is
   administratively disabled still has to be switched on by hand.
2. **Settings → Actions → General → Workflow permissions**: the `github-pages` environment
   must allow deployments from `main`.

Once enabled, the site publishes to `https://pmndrs.github.io/react-three-jolt/`, with pages
at e.g. `https://pmndrs.github.io/react-three-jolt/getting-started/introduction` (the
workflow reads the base path from the Pages API, so the `/react-three-jolt` prefix needs no
configuration). That is exactly where `pmndrs.github.io/react-three-fiber` and
`pmndrs.github.io/drei` live.

To also get listed on [docs.pmnd.rs](https://docs.pmnd.rs) — the shared index and MCP server
for pmndrs documentation — open a PR against `pmndrs/docs` adding an entry to
[`src/libs.ts`](https://github.com/pmndrs/docs/blob/main/src/libs.ts) pointing `docs_url` at
the Pages URL above (`llms_full: true` once the first build has shipped its
`llms-full.txt`). That is a change in *that* repository, not this one.

## Versioning

This project uses `@changesets/cli` to manage versioning and releases.

As changes are made, changesets should be added with `yarn change`. This will open an interactive prompt to help you describe the changes you've made.

A github action will create a PR for bumping the version based on changesets.

## Linting and formatting

This project uses [Biome](https://biomejs.dev/) for both linting and formatting (it replaced
ESLint + Prettier).

```sh
> yarn lint    # biome check .
> yarn format  # biome format --write .
```

`yarn lint` runs in CI and must exit 0. A handful of rules are currently downgraded to
`warn` rather than fixed outright - see [`LINTING.md`](./LINTING.md) for the list and
the plan to re-enable them one by one.

## Continuous Integration

Every pull request and push to `main` runs [`.github/workflows/ci.yml`](./.github/workflows/ci.yml)
on Node 22: `yarn install --immutable`, `yarn lint`, `yarn build`, then `yarn test`. Make
sure all three pass locally before opening a PR.

Dependency updates are handled by Dependabot ([`.github/dependabot.yml`](./.github/dependabot.yml)):
weekly, grouped minor/patch bumps for both npm and GitHub Actions, with major bumps of
`three`, `react`/`react-dom`, and `@react-three/*` excluded since those are tracked as
deliberate, hand-verified upgrades (see the toolchain notes in this repo's changesets).
