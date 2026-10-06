# Arcade fork maintenance

Public fork of Heygen Hyperframes with Arcade keep-local / pending-contrib patches.

## Branches

| Branch                 | Role                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------ |
| `main`                 | Upstream mirror only — no Arcade commits                                             |
| `patch/<slug>`         | One patch; open upstream PRs from these                                              |
| `arcade`               | Disposable integration: `base` (`main`) + cherry-picks from `patches.json`           |
| `patch/arcade-tooling` | This tooling (first entry in the manifest; never upstreamed)                         |

## Rebuild `arcade`

```bash
git fetch origin upstream
git checkout patch/arcade-tooling
node scripts/arcade/rebuild.mjs --yes                       # onto patches.json `base` (main)
node scripts/arcade/rebuild.mjs --yes --base upstream/main  # onto latest upstream
node scripts/arcade/rebuild.mjs --yes --push                # force-with-lease origin/arcade
```

Conflict → abort names the patch. Do not resolve on `arcade`. If the patch itself is clean on `main`, two patches share a hunk: keep them both on `main` and split the file (one owner, the other a new module). `createHostWindowMapper` is `packages/producer/src/services/hostWindowMapper.ts` so it does not rewrite `renderMediaCollector.ts`. If both must edit the same function, add a keep-local join patch.

Rebase that `patch/*` onto the same `base` only when *that* patch failed on `main`, then re-run.

## Tags

Version the delta against `main`, not a merge of `main` into the patch. After a rebuild, tag this date (`YYYY-MM-DD`):

- `sync/<date>/base` → `main`
- `sync/<date>/<patch>` → each `patch/*` tip (`playback-start-nested`, not `patch/playback-start-nested`)
- `sync/<date>/arcade` → `arcade`

```
git range-diff sync/2026-09-09/base..sync/2026-09-09/playback-start-nested \
  sync/<date>/base..sync/<date>/playback-start-nested
```

Push `refs/tags/sync/<date>/*`. Do not move a tag already on origin. If `.tmp` is mid-rebase, tag last week's tips from a clean sibling checkout (`../hyperframes-next`), not from a dirty worktree.

When an upstream PR merges, delete its row from `patches.json` (and optionally the branch).

Each `patches` entry is `{ branch, issue?, pr?, upstreamPr?, keepLocal? }`:

| Field        | Meaning                                           |
| ------------ | ------------------------------------------------- |
| `issue`      | Upstream issue we filed                           |
| `pr`         | Our PR (usually from this `patch/*` branch)       |
| `upstreamPr` | Their PR fixing our issue (when not `pr`)         |
| `keepLocal`  | `true` — intentional Arcade-only; do not upstream |
