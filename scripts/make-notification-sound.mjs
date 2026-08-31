// Writes assets/notification.wav. The sound is generated rather than sourced so
// the repo redistributes nothing it does not own; run this to change it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RATE = 44100;
const NOTES = [
  { freq: 987.77, start: 0.0, length: 0.26 },
  { freq: 1318.51, start: 0.11, length: 0.34 },
];
// Relative levels of the fundamental and the two partials above it, which is
// what keeps a pure sine from sounding like a test tone.
const PARTIALS = [
  { ratio: 1, gain: 1 },
  { ratio: 2, gain: 0.28 },
  { ratio: 3.01, gain: 0.11 },
];
const TOTAL_SECONDS = 0.48;
const PEAK = 0.62;

function sampleAt(t) {
  let value = 0;
  for (const note of NOTES) {
    const age = t - note.start;
    if (age < 0 || age > note.length) continue;
    // 4ms attack so the onset has no click, then an exponential tail.
    const attack = Math.min(1, age / 0.004);
    const decay = Math.exp(-age / (note.length * 0.32));
    for (const partial of PARTIALS) {
      value +=
        attack * decay * partial.gain * Math.sin(2 * Math.PI * note.freq * partial.ratio * age);
    }
  }
  return value;
}

const frames = Math.round(RATE * TOTAL_SECONDS);
const raw = new Float64Array(frames);
let loudest = 0;
for (let i = 0; i < frames; i++) {
  raw[i] = sampleAt(i / RATE);
  loudest = Math.max(loudest, Math.abs(raw[i]));
}
const normalise = loudest > 0 ? PEAK / loudest : 0;

const samples = Buffer.alloc(frames * 2);
for (let i = 0; i < frames; i++) {
  // 6ms fade-out, so the file cannot end on a step.
  const toEnd = (frames - i) / RATE;
  const fade = Math.min(1, toEnd / 0.006);
  samples.writeInt16LE(Math.round(raw[i] * normalise * fade * 32767), i * 2);
}

const header = Buffer.alloc(44);
header.write("RIFF", 0, "ascii");
header.writeUInt32LE(36 + samples.length, 4);
header.write("WAVE", 8, "ascii");
header.write("fmt ", 12, "ascii");
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(1, 22);
header.writeUInt32LE(RATE, 24);
header.writeUInt32LE(RATE * 2, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write("data", 36, "ascii");
header.writeUInt32LE(samples.length, 40);

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "assets", "notification.wav");
fs.writeFileSync(out, Buffer.concat([header, samples]));
console.log(`make-notification-sound: wrote ${out} (${header.length + samples.length} bytes)`);
