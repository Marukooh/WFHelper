import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../..");
const COMMIT_CHECK = path.join(REPO_ROOT, "scripts", "check-commit-msg.mjs");
const EMPTY_GIT_CONFIG = path.join(os.tmpdir(), "wfh-policy-empty.gitconfig");
const EMPTY_XDG_CONFIG = path.join(os.tmpdir(), "wfh-policy-xdg");
fs.writeFileSync(EMPTY_GIT_CONFIG, "");
fs.mkdirSync(EMPTY_XDG_CONFIG, { recursive: true });
const CLEAN_GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: EMPTY_GIT_CONFIG,
  GIT_CONFIG_NOSYSTEM: "1",
  XDG_CONFIG_HOME: EMPTY_XDG_CONFIG,
};

const tempDirs: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: CLEAN_GIT_ENV }).trim();
}

function initRepo(subject = "[test] - seed repository", source = "export const seed = 1;\n") {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "wfh-policy-"));
  tempDirs.push(cwd);
  git(cwd, ["init", "--initial-branch=main"]);
  git(cwd, ["config", "user.name", "Policy Test"]);
  git(cwd, ["config", "user.email", "policy@example.invalid"]);
  fs.writeFileSync(path.join(cwd, "sample.ts"), source);
  git(cwd, ["add", "sample.ts"]);
  git(cwd, ["commit", "--no-verify", "-m", subject]);
  git(cwd, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  return cwd;
}

function runCheck(script: string, args: string[], cwd: string, env = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...CLEAN_GIT_ENV, ...env },
  });
  if (result.error) throw result.error;
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function checkMessage(message: string) {
  const cwd = initRepo();
  const messagePath = path.join(cwd, "COMMIT_EDITMSG");
  fs.writeFileSync(messagePath, message);
  return runCheck(COMMIT_CHECK, [messagePath], cwd);
}

function stageSource(cwd: string, source: string): void {
  fs.writeFileSync(path.join(cwd, "sample.ts"), source);
  git(cwd, ["add", "sample.ts"]);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("commit subject policy", () => {
  it("accepts a documented tag and fully lowercase phrase", () => {
    expect(checkMessage("[fix] - itemdb: name and icon blueprints\n").status).toBe(0);
    expect(checkMessage("[ui] - remember last sub-tab\n").status).toBe(0);
    expect(checkMessage("[release] - publish build\n").status).toBe(0);
  });

  it("rejects undocumented tags", () => {
    const result = checkMessage("[bogus] - publish build\n");
    expect(result.status).toBe(1);
    expect(result.output).toContain("commit message rejected");
  });

  it("accepts proper nouns after a lowercase start", () => {
    expect(checkMessage("[docs] - note SteamOS support status\n").status).toBe(0);
  });

  it("rejects an uppercase first character", () => {
    const result = checkMessage("[fix] - Valid but uppercase start\n");
    expect(result.status).toBe(1);
    expect(result.output).toContain("lowercase phrase");
  });

  it("rejects commit bodies", () => {
    const result = checkMessage("[fix] - concise subject\n\nrestates the diff\n");
    expect(result.status).toBe(1);
    expect(result.output).toContain("no commit body");
  });
});

describe("CI range fallback", () => {
  it("checks a new branch against the default branch when before is zero", () => {
    const cwd = initRepo();
    git(cwd, ["checkout", "-b", "feature"]);
    stageSource(cwd, "export const feature = true;\n");
    git(cwd, ["commit", "--no-verify", "-m", "[fix] - Invalid uppercase start"]);

    const result = runCheck(COMMIT_CHECK, ["--ci"], cwd, {
      BASE_REF: "",
      BEFORE_SHA: "0000000000000000000000000000000000000000",
      DEFAULT_BRANCH: "main",
    });
    expect(result.status).toBe(1);
    expect(result.output).toContain("Invalid uppercase start");
  });

  it("retains the normal push and pull-request ranges", () => {
    const cwd = initRepo();
    const before = git(cwd, ["rev-parse", "HEAD"]);
    git(cwd, ["checkout", "-b", "feature"]);
    stageSource(cwd, "export const feature = true;\n");
    git(cwd, ["commit", "--no-verify", "-m", "[fix] - Invalid uppercase start"]);

    const push = runCheck(COMMIT_CHECK, ["--ci"], cwd, {
      BASE_REF: "",
      BEFORE_SHA: before,
      DEFAULT_BRANCH: "main",
    });
    const pullRequest = runCheck(COMMIT_CHECK, ["--ci"], cwd, {
      BASE_REF: "main",
      BEFORE_SHA: "",
      DEFAULT_BRANCH: "main",
    });
    expect(push.status).toBe(1);
    expect(pullRequest.status).toBe(1);
  });

  it("checks HEAD when the default-branch range is empty", () => {
    const cwd = initRepo("[fix] - Invalid uppercase start");
    const env = {
      BASE_REF: "",
      BEFORE_SHA: "0000000000000000000000000000000000000000",
      DEFAULT_BRANCH: "main",
    };

    expect(runCheck(COMMIT_CHECK, ["--ci"], cwd, env).status).toBe(1);
  });
});
