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
