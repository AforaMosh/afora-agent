#!/usr/bin/env node
// afora rebrand codemod. Case-preserving, idempotent, allowlist-aware.
//
// Usage:
//   node scripts/afora/rebrand.mjs --dry-run       report what would change, no writes
//   node scripts/afora/rebrand.mjs --apply         rewrite file contents in place
//   node scripts/afora/rebrand.mjs --rename-paths  git mv files and dirs whose names match
//   node scripts/afora/rebrand.mjs --census [--top N]  count survivors, bucketed
//
// Scope: git-tracked files only. Binary files skipped. Files under allowlist
// path globs skipped. Spans matching allowlist patterns and lines carrying the
// "afora-compat" marker are preserved everywhere.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const ALLOWLIST_FILE = path.join(ROOT, "docs/afora/REBRAND-ALLOWLIST.txt");
const MARKER = "afora-compat";
const BRAND_RE = /open[ _-]?claw/i;
const BRAND_RE_G = /open[ _-]?claw/gi;

// Ordered special rules. Applied before the generic case map so that compound
// targets (repo slugs, the root package specifier, dead domains) land whole.
const SPECIAL_RULES = [
  // repo slug, incl. URLs and docker image refs
  [/openclaw\/openclaw/gi, "AforaMosh/afora-agent"],
  // dead upstream org domain, map to the one real domain
  [/openclaw\.org/gi, "afora.ai"],
  // root package as a dependency key
  [/"openclaw": "workspace:/g, '"afora-agent": "workspace:'],
  // root package as an import/require specifier: "openclaw/x" or "openclaw"
  // (not @openclaw/x scoped names, those fall through to the case map)
  [/(?<!@)(["'])openclaw\//g, "$1afora-agent/"],
  [/(from |require\()(["'])openclaw\2/g, "$1$2afora-agent$2"],
];

function caseMap(m) {
  const compact = m.replace(/[ _-]/g, "");
  if (compact === compact.toUpperCase()) return "AFORA";
  if (/^[A-Z]/.test(compact)) return "Afora";
  return "afora";
}

function loadAllowlist() {
  const globs = [];
  const patterns = [];
  const text = readFileSync(ALLOWLIST_FILE, "utf8");
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+# .*$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("path:")) globs.push(globToRegExp(line.slice(5).trim()));
    else if (line.startsWith("pattern:")) patterns.push(new RegExp(line.slice(8).trim(), "g"));
  }
  return { globs, patterns };
}

function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}(/|$)`);
}

const { globs, patterns } = loadAllowlist();
const isAllowlistedPath = (p) => globs.some((g) => g.test(p));

function trackedFiles() {
  return execFileSync("git", ["ls-files", "-z"], {
    encoding: "utf8",
    cwd: ROOT,
    maxBuffer: 1 << 26,
  })
    .split("\0")
    .filter(Boolean);
}

// Replace protected spans with placeholders; return [text, restore].
function protect(text) {
  const saved = [];
  let out = text;
  for (const re of patterns) {
    out = out.replace(re, (m) => {
      saved.push(m);
      return `\x01${saved.length - 1}\x01`;
    });
  }
  const restore = (s) => s.replace(/\x01(\d+)\x01/g, (_, i) => saved[Number(i)]);
  return [out, restore];
}

function transformLine(line) {
  if (line.includes(MARKER)) return line;
  let out = line;
  for (const [re, rep] of SPECIAL_RULES) out = out.replace(re, rep);
  return out.replace(BRAND_RE_G, caseMap);
}

function transform(text) {
  const [prot, restore] = protect(text);
  const lines = prot.split("\n").map(transformLine);
  return restore(lines.join("\n"));
}

// --- census bucketing ---
function bucketOf(line, match) {
  if (
    /https?:\/\/|\.ai\b|\.org\b|github\.com|ghcr\.io/.test(line) &&
    /openclaw\.(ai|org)|openclaw\/openclaw|github\.com|ghcr\.io/i.test(line)
  )
    return "url";
  if (/@openclaw\//.test(line)) return "npm-specifier";
  if (/OPENCLAW_[A-Z0-9_]/.test(line)) return "env-var";
  if (/~\/\.openclaw|\.openclaw\/|"\.openclaw"|'\.openclaw'/.test(line)) return "fs-path";
  if (/openclaw\.(json|mjs|plugin\.json|db)/i.test(line)) return "file-name";
  if (/"openclaw"\s*:/.test(line)) return "config-key";
  if (match === "OPENCLAW") return "screaming";
  if (/^Open[ -]?[Cc]law$/.test(match)) return "titlecase";
  if (
    /[A-Za-z]/.test(line[line.indexOf(match) + match.length] || "") ||
    /openClaw|OpenClaw[A-Z a-z]/.test(line)
  )
    return "compound";
  return "plain";
}

const mode = process.argv.includes("--apply")
  ? "apply"
  : process.argv.includes("--rename-paths")
    ? "rename"
    : process.argv.includes("--census")
      ? "census"
      : "dry-run";
const topN = Number(process.argv[process.argv.indexOf("--top") + 1]) || 15;

if (mode === "rename") {
  const files = trackedFiles().filter((f) => BRAND_RE.test(f) && !isAllowlistedPath(f));
  let moved = 0;
  for (const f of files) {
    const dest = f
      .split("/")
      .map((seg) => seg.replace(BRAND_RE_G, caseMap))
      .join("/");
    if (dest === f) continue;
    mkdirSync(path.join(ROOT, path.dirname(dest)), { recursive: true });
    execFileSync("git", ["mv", f, dest], { cwd: ROOT });
    moved++;
  }
  console.log(`renamed ${moved} tracked paths`);
  process.exit(0);
}

let raw = 0;
let allowPath = 0;
let protectedSpans = 0;
let markerLines = 0;
let actionable = 0;
let changedFiles = 0;
const perFile = [];
const buckets = {};

for (const f of trackedFiles()) {
  const abs = path.join(ROOT, f);
  let text;
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    continue;
  }
  if (text.includes("\0")) continue;
  const matches = text.match(BRAND_RE_G);
  if (!matches) continue;
  raw += matches.length;
  if (isAllowlistedPath(f)) {
    allowPath += matches.length;
    continue;
  }
  const [prot] = protect(text);
  let fileActionable = 0;
  for (const line of prot.split("\n")) {
    const lineMatches = line.match(BRAND_RE_G);
    if (!lineMatches) continue;
    if (line.includes(MARKER)) {
      markerLines += lineMatches.length;
      continue;
    }
    fileActionable += lineMatches.length;
    if (mode === "census") {
      for (const m of lineMatches)
        buckets[bucketOf(line, m)] = (buckets[bucketOf(line, m)] || 0) + 1;
    }
  }
  protectedSpans += matches.length - fileActionable - markerLines;
  if (fileActionable === 0) continue;
  actionable += fileActionable;
  perFile.push([f, fileActionable]);
  if (mode === "apply") {
    const next = transform(text);
    if (next !== text) {
      writeFileSync(abs, next);
      changedFiles++;
    }
  }
}

perFile.sort((a, b) => b[1] - a[1]);
console.log(`raw ${raw}`);
console.log(`allowlisted-by-path ${allowPath}`);
console.log(`protected-spans-or-marker ${raw - allowPath - actionable}`);
console.log(`post-allowlist ${actionable}`);
if (mode === "census") {
  console.log("buckets:");
  for (const [k, v] of Object.entries(buckets).sort((a, b) => b[1] - a[1]))
    console.log(`  ${k} ${v}`);
  console.log(`top ${topN} files:`);
  for (const [f, n] of perFile.slice(0, topN)) console.log(`  ${n}\t${f}`);
}
if (mode === "apply") console.log(`rewrote ${changedFiles} files`);
if (mode === "dry-run") console.log(`would rewrite ${perFile.length} files`);
