# Releasing

This is a `@classytic/*` package — uses the shared classytic-bot release workflow.

## Steps

```bash
# 1. Commit as classytic-bot[bot] (env-var override; no global git config mutation)
GIT_AUTHOR_NAME="classytic-bot[bot]" \
GIT_AUTHOR_EMAIL="278929599+classytic-bot[bot]@users.noreply.github.com" \
GIT_COMMITTER_NAME="classytic-bot[bot]" \
GIT_COMMITTER_EMAIL="278929599+classytic-bot[bot]@users.noreply.github.com" \
git commit -m "release: <version>"

# 2. Annotated tag (bot committer)
GIT_COMMITTER_NAME="classytic-bot[bot]" \
GIT_COMMITTER_EMAIL="278929599+classytic-bot[bot]@users.noreply.github.com" \
git tag -a v<version> -m "v<version>"

# 3. Push branch + tag, then publish
npm run push -- main
npm run push -- v<version>
npm publish
```

`npm publish` automatically runs `prepublishOnly` (typecheck + lint + build + tests + smoke).

## Rules

- **Never** set global `git config user.*` — pollutes non-classytic commits.
- **Never** add `Co-Authored-By` trailers — single bot identity only.
- **Never** `npm publish --no-verify` — `prepublishOnly` is the gate. Fix what fails.
- **Always** tag `v<semver>` matching the published npm version. Push the branch first, then the tag.

## One-time machine setup

Required env vars (resolved via `D:/credentials/.env` + `CLASSYTIC_BOT_ENV_FILE` pointer):

| Var | Purpose |
|---|---|
| `CLASSYTIC_BOT_APP_ID=3487539` | GitHub App ID (public) |
| `CLASSYTIC_BOT_PEM_PATH=D:/credentials/classytic-bot.<date>.private-key.pem` | Path to App's `.pem` (never commit) |

Full setup: [`@classytic/dev-tools` README](https://github.com/classytic/dev-tools#readme).

## CI

Wire org secrets directly — no `.env` file on runners:

```yaml
env:
  CLASSYTIC_BOT_APP_ID: ${{ vars.CLASSYTIC_BOT_APP_ID }}
  CLASSYTIC_BOT_PEM:    ${{ secrets.CLASSYTIC_BOT_PRIVATE_KEY }}
run: npx classytic-push main
```
