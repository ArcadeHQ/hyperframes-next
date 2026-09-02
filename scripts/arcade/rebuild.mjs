#!/usr/bin/env node
/**
 * Rebuild the disposable `arcade` integration branch:
 * reset to `base` (--base, else patches.json `base`, else `upstream`), then cherry-pick
 * each patch tip in patches.json order.
 *
 * Bootstrap (scripts may not be on current checkout):
 *   git fetch origin upstream
 *   git checkout patch/arcade-tooling
 *   node scripts/arcade/rebuild.mjs --yes
 *
 * On conflict: script aborts and names the failing patch — rebase that
 * patch/* onto the same base, then re-run.
 *
 * Usage:
 *   node scripts/arcade/rebuild.mjs --yes
 *   node scripts/arcade/rebuild.mjs --yes --base main
 *   node scripts/arcade/rebuild.mjs --yes --base upstream/main
 *   node scripts/arcade/rebuild.mjs --yes --push
 *   node scripts/arcade/rebuild.mjs --dry-run
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const MANIFEST_PATH = join(dirname(fileURLToPath(import.meta.url)), "patches.json");

const argv = process.argv.slice(2);
const args = new Set(argv);
const dryRun = args.has("--dry-run");
const push = args.has("--push");
const yes = args.has("--yes");

function takeArg(name) {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  const value = argv[i + 1];
  if (!value || value.startsWith("-")) die(`${name} requires a git ref`);
  return value;
}

function git(gitArgs, opts = {}) {
  return execFileSync("git", gitArgs, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: opts.stdio ?? ["ignore", "pipe", "pipe"],
    ...opts,
  }).trim();
}

function gitOk(gitArgs) {
  try {
    git(gitArgs);
    return true;
  } catch {
    return false;
  }
}

function die(message, code = 1) {
  console.error(message);
  process.exit(code);
}

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
const upstream = typeof manifest.upstream === "string" ? manifest.upstream : null;
const base = takeArg("--base") || (typeof manifest.base === "string" ? manifest.base : null) || upstream;
const branch = manifest.integrationBranch;
if (!base) die("patches.json: set base or upstream, or pass --base <ref>");
if (!Array.isArray(manifest.patches) || manifest.patches.length === 0) {
  die("patches.json: patches must be a non-empty array");
}
const patches = manifest.patches.map((p) => {
  if (typeof p === "string") return p;
  if (p && typeof p.branch === "string") return p.branch;
  die("patches.json: each patch must be a string or { branch }");
});

if (!yes && !dryRun) {
  die("Refusing to reset arcade without --yes (or pass --dry-run).");
}

const status = git(["status", "--porcelain"]);
if (status) {
  die(`Working tree dirty:\n${status}`);
}

if (!gitOk(["rev-parse", "--verify", base])) {
  die(`Missing ${base}. Run: git fetch origin upstream`);
}

for (const patch of patches) {
  if (!gitOk(["rev-parse", "--verify", patch])) {
    die(`Missing patch ref ${patch}. Fetch or create it before rebuilding.`);
  }
}

const baseSha = git(["rev-parse", base]);
console.log(`base:      ${base} @ ${baseSha.slice(0, 12)}`);
if (upstream && upstream !== base && gitOk(["rev-parse", "--verify", upstream])) {
  console.log(`upstream:  ${upstream} @ ${git(["rev-parse", upstream]).slice(0, 12)}`);
}
console.log(`branch:    ${branch}`);
console.log(`patches:   ${patches.length}`);
for (const patch of patches) {
  const tip = git(["rev-parse", patch]);
  const commits = git(["rev-list", "--reverse", `${base}..${patch}`])
    .split("\n")
    .filter(Boolean);
  console.log(
    `  - ${patch} (${commits.length} commit${commits.length === 1 ? "" : "s"} @ ${tip.slice(0, 12)})`,
  );
  if (commits.length === 0) {
    console.warn(
      `    warn: no commits in ${base}..${patch} — already in base or empty; will skip`,
    );
  }
}

if (dryRun) {
  console.log("dry-run: no refs updated");
  process.exit(0);
}

git(["checkout", "-B", branch, base]);
// -B from a remote-tracking start-point inherits that upstream.
// arcade is a fork integration branch — it should track origin/arcade.
if (gitOk(["rev-parse", "--verify", `origin/${branch}`])) {
  git(["branch", "--set-upstream-to", `origin/${branch}`]);
}
console.log(`reset ${branch} → ${base}`);

for (const patch of patches) {
  const commits = git(["rev-list", "--reverse", `${base}..${patch}`])
    .split("\n")
    .filter(Boolean);
  if (commits.length === 0) {
    console.log(`skip ${patch} (empty range)`);
    continue;
  }

  console.log(`cherry-pick ${patch} (${commits.length})`);
  try {
    execFileSync("git", ["cherry-pick", ...commits], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: "inherit",
    });
  } catch {
    console.error(`\nConflict while cherry-picking ${patch}.`);
    console.error(`Fix that patch branch onto ${base}, then re-run:`);
    console.error(`  git checkout ${patch}`);
    console.error(`  git rebase ${base}`);
    console.error(`  # resolve, then:`);
    console.error(`  git checkout patch/arcade-tooling`);
    console.error(`  node scripts/arcade/rebuild.mjs --yes`);
    console.error(`\nAborting cherry-pick and leaving ${branch} mid-rebuild.`);
    try {
      execFileSync("git", ["cherry-pick", "--abort"], { cwd: ROOT, stdio: "inherit" });
    } catch {
      // already aborted or nothing to abort
    }
    process.exit(1);
  }
}

const tip = git(["rev-parse", "HEAD"]);
console.log(`\n${branch} tip: ${tip}`);
console.log(`commits on ${branch} not in ${base}:`);
console.log(git(["log", "--oneline", `${base}..HEAD`]) || "(none)");

if (push) {
  execFileSync("git", ["push", "--force-with-lease", "origin", branch], {
    cwd: ROOT,
    stdio: "inherit",
  });
  git(["branch", "--set-upstream-to", `origin/${branch}`]);
  console.log(`pushed origin/${branch}`);
} else {
  console.log(`\nPush when ready:\n  git push --force-with-lease origin ${branch}`);
}
