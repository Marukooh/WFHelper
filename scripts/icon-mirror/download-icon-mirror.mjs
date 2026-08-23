import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const outputRoot = path.join(repoRoot, ".icon-mirror");
const publicRoot = path.join(outputRoot, "public");
const manifestPath = path.join(publicRoot, "manifest.json");
const failuresPath = path.join(outputRoot, "download-failures.json");

const concurrency = Math.max(1, Math.min(24, Number(process.env.ICON_MIRROR_CONCURRENCY) || 6));
const timeoutMs = Math.max(5000, Number(process.env.ICON_MIRROR_TIMEOUT_MS) || 30000);
const allowedSourceHosts = new Set(["browse.wf", "cdn.warframestat.us", "wiki.warframe.com"]);
const allowedFallbackHosts = new Set(["content.warframe.com"]);

function readManifest() {
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Missing ${manifestPath}. Run "npm run icons:manifest" first.`);
  }
  return JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
}

function contentTypeToExt(contentType) {
  const normalized = String(contentType || "").toLowerCase();
  if (normalized.includes("image/png")) return ".png";
  if (normalized.includes("image/jpeg")) return ".jpg";
  if (normalized.includes("image/webp")) return ".webp";
  if (normalized.includes("image/gif")) return ".gif";
  return null;
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": "WFHelper icon mirror builder" },
    });
  } finally {
    clearTimeout(timer);
  }
}

function validateSourceUrl(value, allowedHosts) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    return { ok: false, reason: "invalid source URL" };
  }

  if (parsed.protocol !== "https:") {
    return { ok: false, reason: `unsupported source protocol ${parsed.protocol || "(none)"}` };
  }
  if (!allowedHosts.has(parsed.hostname)) {
    return { ok: false, reason: `unapproved source host ${parsed.hostname || "(none)"}` };
  }
  return { ok: true, url: parsed.href };
}

function sniffImageExt(bytes) {
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  )
    return ".png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return ".jpg";
  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  )
    return ".webp";
  if (bytes.length >= 3 && bytes.toString("ascii", 0, 3) === "GIF") return ".gif";
  return null;
}

async function fetchImage(url, targetExt) {
  const response = await fetchWithTimeout(url);
  if (!response.ok) {
    return { ok: false, reason: `HTTP ${response.status}` };
  }

  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (contentType && !contentType.startsWith("image/")) {
    return { ok: false, reason: `unexpected content-type ${contentType}` };
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) {
    return { ok: false, reason: "empty response" };
  }

  // DE's CDN sends no content-type header; judge the payload instead
  const actualExt = contentType ? contentTypeToExt(contentType) : sniffImageExt(bytes);
  if (!contentType && !actualExt) {
    return { ok: false, reason: "unrecognized image payload" };
  }
  if (actualExt && targetExt !== actualExt) {
    return { ok: false, reason: `extension mismatch (${actualExt} for ${targetExt} target)` };
  }

  return { ok: true, bytes };
}

async function downloadEntry(entry) {
  // WFM thumbs are challenge-gated; download-wfm-thumbs.cjs handles them.
  if (entry.mirrorPath.startsWith("wfm/")) {
    return { status: "skipped" };
  }
  const targetPath = path.join(publicRoot, entry.mirrorPath);
  if (fs.existsSync(targetPath) && fs.statSync(targetPath).size > 0) {
    return { status: "skipped" };
  }
  const targetExt = path.extname(targetPath).toLowerCase();

  const source = validateSourceUrl(entry.sourceUrl, allowedSourceHosts);
  if (!source.ok) {
    return { status: "failed", reason: source.reason };
  }

  let result = await fetchImage(source.url, targetExt);
  if (!result.ok && entry.fallbackUrl) {
    const fallback = validateSourceUrl(entry.fallbackUrl, allowedFallbackHosts);
    if (fallback.ok) {
      const retry = await fetchImage(fallback.url, targetExt);
      if (retry.ok) result = retry;
      else result.reason += `; fallback: ${retry.reason}`;
    }
  }
  if (!result.ok) {
    return { status: "failed", reason: result.reason };
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, result.bytes);
  return { status: "downloaded", bytes: result.bytes.length };
}

async function runPool(entries) {
  const failures = [];
  let nextIndex = 0;
  let downloaded = 0;
  let skipped = 0;

  async function worker() {
    while (nextIndex < entries.length) {
      const index = nextIndex++;
      const entry = entries[index];
      try {
        const result = await downloadEntry(entry);
        if (result.status === "downloaded") downloaded++;
        if (result.status === "skipped") skipped++;
        if (result.status === "failed") {
          failures.push({ ...entry, reason: result.reason });
        }
      } catch (error) {
        failures.push({
          ...entry,
          reason: error instanceof Error ? error.message : String(error),
        });
      }

      const done = index + 1;
      if (done % 250 === 0 || done === entries.length) {
        console.log(
          `[icon-mirror] ${done}/${entries.length} processed (${downloaded} downloaded, ${skipped} skipped, ${failures.length} failed)`,
        );
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { downloaded, skipped, failures };
}

const manifest = readManifest();
const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
const { downloaded, skipped, failures } = await runPool(entries);

fs.writeFileSync(failuresPath, `${JSON.stringify(failures, null, 2)}\n`);
console.log(
  `[icon-mirror] complete: ${downloaded} downloaded, ${skipped} skipped, ${failures.length} failed`,
);

// A 404 means DE never published that texture, so no retry fixes it and one gap
// must not block the deploy. A fallback retry appends its own reason, so a texture
// missing from both hosts reads "HTTP 404; fallback: HTTP 404". Only an all-404
// chain is a permanent gap; a flood of them means the path scheme moved.
const isMissingUpstream = (entry) =>
  String(entry.reason || "")
    .split("; fallback: ")
    .every((reason) => reason === "HTTP 404");
const missing = failures.filter(isMissingUpstream);
const broken = failures.filter((entry) => !isMissingUpstream(entry));
const missingCap = Math.max(20, Math.ceil(entries.length * 0.01));
if (missing.length > 0) {
  console.warn(`[icon-mirror] ${missing.length} not published upstream (HTTP 404), skipped`);
}
if (
  (broken.length > 0 || missing.length > missingCap) &&
  process.env.ICON_MIRROR_ALLOW_FAILURES !== "1"
) {
  console.error(`[icon-mirror] failures written to ${failuresPath}`);
  process.exitCode = 1;
}
