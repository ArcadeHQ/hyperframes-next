#!/usr/bin/env node
/**
 * Pack @hyperframes packages and attach .tgz assets to a GitHub Release.
 * Does NOT npm publish (public npm or GitHub Packages).
 *
 * Usage:
 *   node scripts/arcade/publish-release.mjs --yes
 *   node scripts/arcade/publish-release.mjs --tag v0.7.107-arcade.1 --yes
 *   node scripts/arcade/publish-release.mjs --dry-run
 *
 * Run on `arcade` (or pass --ref). Requires: bun, gh, clean tree.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const MANIFEST_PATH = join(dirname(fileURLToPath(import.meta.url)), "patches.json");

function parseArgs(argv) {
  const out = { yes: false, dryRun: false, tag: null, ref: "arcade", repo: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--yes") out.yes = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--tag") out.tag = argv[++i];
    else if (a === "--ref") out.ref = argv[++i];
    else if (a === "--repo") out.repo = argv[++i];
    else throw new Error(`Unknown arg: ${a}`);
  }
  return out;
}

function run(cmd, cmdArgs, opts = {}) {
  const result = execFileSync(cmd, cmdArgs, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: opts.stdio ?? ["ignore", "pipe", "pipe"],
    ...opts,
  });
  return (result ?? "").toString().trim();
}

function die(message, code = 1) {
  console.error(message);
  process.exit(code);
}

const args = parseArgs(process.argv.slice(2));
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
const packPackages = manifest.packPackages;
if (!Array.isArray(packPackages) || packPackages.length === 0) {
  die("patches.json: packPackages must be a non-empty array");
}

if (!args.yes && !args.dryRun) {
  die("Refusing to publish without --yes (or pass --dry-run).");
}

const status = run("git", ["status", "--porcelain"]);
if (status) die(`Working tree dirty:\n${status}`);

const headBranch = run("git", ["branch", "--show-current"]);
if (headBranch !== args.ref && !args.dryRun) {
  die(`Check out ${args.ref} first (on ${headBranch || "detached"}). Or pass --ref.`);
}

const version = JSON.parse(readFileSync(join(ROOT, "packages/core/package.json"), "utf8")).version;
if (!version) die("packages/core/package.json missing version");

let tag = args.tag;
if (!tag) {
  let n = 1;
  while (true) {
    const candidate = `v${version}-arcade.${n}`;
    try {
      run("gh", ["release", "view", candidate], { stdio: ["ignore", "ignore", "ignore"] });
      n += 1;
    } catch {
      tag = candidate;
      break;
    }
  }
}

if (!/^v\d+\.\d+\.\d+.*-arcade\.\d+$/.test(tag)) {
  die(`Tag must look like v${version}-arcade.N (got ${tag})`);
}

const repo =
  args.repo ||
  run("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]);

console.log(`ref:      ${args.ref}`);
console.log(`version:  ${version}`);
console.log(`tag:      ${tag}`);
console.log(`repo:     ${repo}`);
console.log(`packages: ${packPackages.join(", ")}`);

if (args.dryRun) {
  console.log("dry-run: would build, pack, and gh release create");
  process.exit(0);
}

console.log("\ninstall + build…");
run("bun", ["install", "--frozen-lockfile"], { stdio: "inherit" });
run("bun", ["run", "build"], { stdio: "inherit" });
run("bun", ["run", "verify:packed-manifests"], { stdio: "inherit" });

const packDir = mkdtempSync(join(tmpdir(), "hf-arcade-pack-"));
mkdirSync(packDir, { recursive: true });

try {
  for (const name of packPackages) {
    const pkgDir = join(ROOT, "packages", name);
    console.log(`npm pack @hyperframes/${name}`);
    run("npm", ["pack", "--pack-destination", packDir], { cwd: pkgDir, stdio: "inherit" });
  }

  const tarballs = readdirSync(packDir)
    .filter((f) => f.endsWith(".tgz"))
    .map((f) => join(packDir, f))
    .sort();
  if (tarballs.length === 0) die("No .tgz produced");

  console.log(`\ngh release create ${tag} (${tarballs.length} assets)`);
  run(
    "gh",
    [
      "release",
      "create",
      tag,
      "--repo",
      repo,
      "--title",
      tag,
      "--prerelease",
      "--generate-notes",
      "--target",
      run("git", ["rev-parse", "HEAD"]),
      ...tarballs,
    ],
    { stdio: "inherit" },
  );

  const base = `https://github.com/${repo}/releases/download/${tag}`;
  console.log("\nArcade package.json pins:");
  for (const file of tarballs.map((p) => p.split(/[/\\]/).pop())) {
    const npmName = file
      .replace(/-\d+\.\d+\.\d+.*\.tgz$/, "")
      .replace(/^hyperframes-/, "@hyperframes/");
    console.log(`  "${npmName}": "${base}/${file}",`);
  }
} finally {
  rmSync(packDir, { recursive: true, force: true });
}
