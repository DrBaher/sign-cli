# Release runbook

How to ship a new `sign-cli` version. Each step that requires authenticated GitHub or npm access is marked **(needs auth)** — Claude can do everything else.

## Pre-flight

1. **Bump the version** in `package.json` and `src/lib/help-catalog.ts` (`SIGN_CLI_VERSION`). Match SemVer rules.
2. **Update `CHANGELOG.md`** under a new `## [X.Y.Z] — YYYY-MM-DD` header. Group bullets by `Added` / `Changed` / `Deprecated` / `Removed` / `Fixed` / `Security` / `Migration`. Link each bullet to the merged PR for traceability.
3. **Run the suite** locally:
   ```bash
   npm run build && npm test
   ```
4. **Sanity-test the bin** in a fresh terminal:
   ```bash
   node dist/cli.js --version          # should print X.Y.Z
   node dist/cli.js --help              # grouped command index
   node dist/cli.js demo --out /tmp/sign-demo
   ```

## Tag and release

5. **Commit + push** the version bump + changelog as a single PR; merge to `main`.
6. **Tag** (annotated, signed if your workflow signs commits):
   ```bash
   git fetch origin main && git checkout main && git pull
   git tag -a vX.Y.Z -m "vX.Y.Z — <one-line summary>. See CHANGELOG.md."
   git push origin vX.Y.Z
   ```
7. **(needs auth)** Create the GitHub Release pointing at the tag:
   ```bash
   gh release create vX.Y.Z --title "vX.Y.Z" --notes-file CHANGELOG.md
   ```
   Or via the web UI at `https://github.com/<owner>/sign-cli/releases/new?tag=vX.Y.Z`.

## Discoverability

8. **(needs auth)** Set repo topic tags so `sign-cli` shows up in GitHub search:
   ```bash
   gh repo edit --add-topic esign,mcp,agent-friendly,pades,audit-chain,e-signature,signature,docusign,dropbox-sign,signwell,cli,typescript
   ```
   Or via the web UI on the repo's "About" gear.

## npm publish

9. **(needs auth)** Make sure `npm whoami` shows the publishing account.
10. **Dry-run** to confirm what's in the tarball:
    ```bash
    npm pack --dry-run
    ```
    Verify the `files` array in `package.json` includes `dist/cli.js`, `dist/lib`, fixtures, and the doc `.md` files — and **excludes** `data/`, `.env`, and any local-provider artifacts.
11. **Publish**:
    ```bash
    npm run prepublishOnly   # rebuild + retest (also runs automatically below)
    npm publish              # public packages only; add --access public if you've gated
    ```
12. Verify the published artifact resolves:
    ```bash
    npx @drbaher/sign-cli@X.Y.Z --version
    ```

## Rollback

If a release is broken:

```bash
npm deprecate sign-cli@X.Y.Z "see release notes for the regression"
gh release edit vX.Y.Z --prerelease   # mark the broken release as prerelease
```

For full unpublish (within 72 hours of publishing, no production dependents):

```bash
npm unpublish sign-cli@X.Y.Z
```

After unpublishing, you cannot re-publish the same version number for 24 hours — bump the patch version and ship a fresh release instead.
