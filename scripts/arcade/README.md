# Arcade fork maintenance

Public fork of Heygen Hyperframes with Arcade keep-local / pending-contrib patches.

## Branches

| Branch                 | Role                                                                       |
| ---------------------- | -------------------------------------------------------------------------- |
| `main`                 | Upstream mirror only — no Arcade commits                                   |
| `patch/<slug>`         | One patch; open upstream PRs from these                                    |
| `arcade`               | Disposable integration: `upstream/main` + cherry-picks from `patches.json` |
| `patch/arcade-tooling` | This tooling (first entry in the manifest; never upstreamed)               |

## Rebuild `arcade`

```bash
git fetch origin upstream
git checkout patch/arcade-tooling
node scripts/arcade/rebuild.mjs --yes          # local only
node scripts/arcade/rebuild.mjs --yes --push   # force-with-lease origin/arcade
```

Conflict → abort names the patch. Rebase that `patch/*` onto `upstream/main`, then re-run.

When an upstream PR merges, delete its row from `patches.json` (and optionally the branch).

Each `patches` entry is `{ branch, issue?, pr?, upstreamPr?, keepLocal? }`:

| Field        | Meaning                                           |
| ------------ | ------------------------------------------------- |
| `issue`      | Upstream issue we filed                           |
| `pr`         | Our PR (usually from this `patch/*` branch)       |
| `upstreamPr` | Their PR fixing our issue (when not `pr`)         |
| `keepLocal`  | `true` — intentional Arcade-only; do not upstream |
