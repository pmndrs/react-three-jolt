# Development

The `@react-three/jolt` repository is structured as a yarn monorepo.

You will find published packages inside `./packages`, and deployed applications in `./apps`.

## Node

**This project uses node 20.**

If you don't already use a node version manager. Give nvm a try:

https://github.com/nvm-sh/nvm

## Yarn

**This project uses yarn 4.**

If you have Corepack enabled, you should be able to use this project's yarn version without doing anything special. If you don't have Corepack enabled, you can enable it by running the following:

```sh
> corepack enable
```

## Building

Once you have the above installed, run the following to install dependencies and build all packages:

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
