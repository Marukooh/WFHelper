// Mirrors the codex enemy portraits (scripts/icon-mirror/enemy-images.json,
// written by the codex-scans generator) from the wiki into
// .icon-mirror/public/enemies/. Existing files are kept; failures reported.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const listPath = path.join(__dirname, "enemy-images.json");
const outDir = path.join(repoRoot, ".icon-mirror", "public", "enemies");

// Special:FilePath rate-limits hard; stay slow and back off on 429.
const concurrency = Math.max(1, Math.min(16, Number(process.env.ICON_MIRROR_CONCURRENCY) || 2));
const timeoutMs = Math.max(5000, Number(process.env.ICON_MIRROR_TIMEOUT_MS) || 30000);
const delayMs = Math.max(0, Number(process.env.ICON_MIRROR_DELAY_MS) || 250);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (!fs.existsSync(listPath)) {
  console.error(`missing ${listPath}; run scripts/codex-scans/build-codex-scan-data.mjs first`);
  process.exit(1);
}
const names = JSON.parse(fs.readFileSync(listPath, "utf-8"));
fs.mkdirSync(outDir, { recursive: true });

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "user-agent": "WFHelper icon mirror builder" },
    });
  } finally {
    clearTimeout(timer);
  }
}

let done = 0;
let skipped = 0;
const failures = [];

async function worker(queue) {
  for (;;) {
    const name = queue.pop();
    if (!name) return;
    const dest = path.join(outDir, name);
    if (path.basename(dest) !== name || fs.existsSync(dest)) {
      skipped++;
      continue;
    }
    try {
      const url = `https://wiki.warframe.com/w/Special:FilePath/${encodeURIComponent(name)}`;
      let res = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        await sleep(delayMs);
        res = await fetchWithTimeout(url);
        if (res.status !== 429) break;
        const retryAfter = Number(res.headers.get("retry-after")) || 0;
        await sleep(Math.max(retryAfter * 1000, 2000 * (attempt + 1)));
      }
      if (!res?.ok) throw new Error(`HTTP ${res?.status}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length < 100) throw new Error(`suspiciously small (${bytes.length}B)`);
      fs.writeFileSync(dest, bytes);
      done++;
      if (done % 100 === 0) console.log(`${done} downloaded...`);
    } catch (err) {
      failures.push({ name, reason: String(err?.message || err) });
    }
  }
}

const queue = [...names];
await Promise.all(Array.from({ length: concurrency }, () => worker(queue)));
console.log(
  `enemy images: ${done} downloaded, ${skipped} already present, ${failures.length} failed`,
);
for (const failure of failures.slice(0, 20)) console.warn(`  ${failure.name}: ${failure.reason}`);
if (failures.length > names.length / 4) {
  console.error("too many failures - not treating this run as complete");
  process.exit(1);
}
