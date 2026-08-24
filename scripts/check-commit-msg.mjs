#!/usr/bin/env node
// Commit-message gate: one "[tag] - lowercase phrase" line, no body.
// Modes: <path> (commit-msg hook), --range <a>..<b>, --ci (GitHub push/PR).

import { execFileSync } from "node:child_process";
import fs from "node:fs";

import { resolveRange } from "./commit-range.mjs";

const TAGS = [
  "build",
  "chore",
  "ci",
  "cleanup",
  "deps",
  "docs",
  "feat",
  "fix",
  "lint",
  "perf",
  "refactor",
  "release",
  "security",
  "style",
  "test",
  "tooling",
  "types",
  "ui",
  "worker",
];

const SUBJECT_RE = new RegExp(`^\\[(?:${TAGS.join("|")})\\] - ([a-z0-9].*)$`);
const MAX_SUBJECT = 72;
// git writes these itself; they are not ours to reformat.
const PASSTHROUGH_RE = /^(Merge |Revert |fixup!|squash!|amend!)/;

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function auditMessage(message, label, problems) {
  const lines = message.split(/\r?\n/).filter((line) => !line.startsWith("#"));
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();

  const subject = (lines[0] ?? "").trim();
  const body = lines.slice(1).join("\n").trim();
  if (PASSTHROUGH_RE.test(subject)) return;

  const errors = [];
  // SUBJECT_RE already forces a lowercase first character; proper nouns keep their case.
  const match = SUBJECT_RE.exec(subject);
  if (!match) {
    errors.push(`must read "[tag] - lowercase phrase" - tags: ${TAGS.join(", ")}`);
  }
  if (subject.length > MAX_SUBJECT) {
    errors.push(`subject is ${subject.length} chars, max ${MAX_SUBJECT}`);
  }
  if (body) {
    errors.push("no commit body - say it in the subject or not at all");
  }
  if (errors.length > 0) problems.push({ label, subject, errors });
}

function rangeMessages(range) {
  // Unit separator between sha and body, record separator between commits.
  const log = git(["log", "--no-merges", "--format=%h%x1f%B%x1e", range]);
  const commits = [];
  for (const chunk of log.split("\x1e")) {
    const [sha, message] = chunk.replace(/^\s+/, "").split("\x1f");
    if (sha && message !== undefined) commits.push({ sha, message });
  }
  return commits;
}

function headMessage(head) {
  const raw = git(["show", "-s", "--format=%h%x1f%B", head]);
  const [sha, message] = raw.split("\x1f");
  return sha && message !== undefined ? [{ sha: sha.trim(), message }] : [];
}

const mode = process.argv[2];
const problems = [];

if (!mode) {
  console.error("usage: check-commit-msg <path-to-message> | --range <a>..<b> | --ci");
  process.exit(2);
} else if (mode === "--range" || mode === "--ci") {
  let range = process.argv[3];
  if (mode === "--ci") {
    const resolved = resolveRange();
    let commits = [];
    if (resolved.base) {
      commits = rangeMessages(`${resolved.base}..${resolved.head}`);
    }
    if (commits.length === 0 && resolved.fallbackToHead) commits = headMessage(resolved.head);
    for (const { sha, message } of commits) auditMessage(message, sha, problems);
  } else {
    if (!range) throw new Error("--range needs <base>..<head>");
    for (const { sha, message } of rangeMessages(range)) auditMessage(message, sha, problems);
  }
} else {
  auditMessage(fs.readFileSync(mode, "utf8"), "", problems);
}

if (problems.length > 0) {
  console.error("\ncommit message rejected:\n");
  for (const { label, subject, errors } of problems) {
    console.error(`  ${label ? `${label} ` : ""}${subject}`);
    for (const error of errors) console.error(`    - ${error}`);
  }
  console.error("");
  process.exit(1);
}

console.log("check-commit-msg: OK");
