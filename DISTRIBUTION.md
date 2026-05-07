# Distribution

Three ways to install and use the CLI.

## 1. `npx` (no install)

```bash
npx sign-cli demo
npx sign-cli doctor providers
```

Pulls the published tarball, runs the bundled CLI, exits. Good for one-off agent demos.

## 2. Global npm install

```bash
npm install -g sign-cli
sign demo
sign doctor providers
```

The `bin` entry exposes `sign` on your `$PATH`. Useful for repeated local use.

## 3. Standalone binary (no Node install required)

The release workflow builds Single Executable Application (SEA) binaries for Linux, macOS, and Windows on every `v*` tag. Download the matching binary from the GitHub Release and run it:

```bash
chmod +x sign-linux-x64
./sign-linux-x64 demo
```

### Build the binary locally

```bash
npm install
npm run build:sea
./dist/sign-<platform>-<arch>
```

`build:sea` does:
1. `npm run bundle` — esbuild rolls `src/cli.ts` into a single CommonJS bundle (~190 KB).
2. `node --experimental-sea-config scripts/sea.config.json` — Node serializes the bundle into a SEA blob with code cache enabled.
3. Copies `process.execPath` (your Node binary) into `dist/sign-<platform>-<arch>` and uses [postject](https://github.com/nodejs/postject) to inject the blob.

The resulting binary is roughly the size of the Node runtime (~80 MiB on Linux). It bundles the entire CLI, including the local provider, PAdES signer, and audit verifier.

> Building SEA requires an official Node 22+ binary that includes the postject sentinel (default for nodejs.org releases). Custom builds may not.

## Release flow

Pushing a `v*` git tag triggers `.github/workflows/release.yml`:
- `publish-npm` job builds, tests, then publishes to npm if `secrets.NPM_TOKEN` is set (with provenance).
- `build-sea` matrix builds binaries for `ubuntu-latest`, `macos-latest`, `windows-latest`.
- `attach-binaries-to-release` downloads the artifacts and attaches them to the GitHub Release.

To cut a release:
```bash
npm version 0.4.0  # bumps package.json + creates v0.4.0 tag
git push --follow-tags
```

If you don't want to publish to npm, leave `NPM_TOKEN` unset; the workflow will skip the publish step but still attach binaries to the GitHub Release.
