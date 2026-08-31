// Writes assets/notification.wav. The sound is generated rather than sourced so
// the repo redistributes nothing it does not own; run this to change it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RATE = 44100;
// A rising perfect fifth, low enough that nothing lands in the 2-4kHz band ears
// are most sensitive to. A notification interrupts, so it must not startle.
const NOTES = [
  { freq: 523.25, start: 0.0, length: 0.3 },
  { freq: 783.99, start: 0.13, length: 0.32 },
];
// Only the octave above the fundamental, and quietly. Any inharmonic partial
// reads as metallic, and a loud one turns the clip piercing.
const PARTIALS = [
  { ratio: 1, gain: 1 },
  { ratio: 2, gain: 0.12 },
];
const TOTAL_SECONDS = 0.5;
const PEAK = 0.22;

function sampleAt(t) {
  let value = 0;
  for (const note of NOTES) {
    const age = t - note.start;
    if (age < 0 || age > note.length) continue;
    // 20ms swell rather than a strike, then a slow tail.
    const attack = Math.min(1, age / 0.02);
    const decay = Math.exp(-age / (note.length * 0.45));
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
let sumSquares = 0;
for (let i = 0; i < frames; i++) {
  // 60ms fade-out, so the clip settles instead of stopping.
  const toEnd = (frames - i) / RATE;
  const value = raw[i] * normalise * Math.min(1, toEnd / 0.06);
  sumSquares += value * value;
  samples.writeInt16LE(Math.round(value * 32767), i * 2);
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
const rms = Math.sqrt(sumSquares / frames);
console.log(
  `make-notification-sound: wrote ${out} (${header.length + samples.length} bytes, ` +
    `peak ${PEAK.toFixed(2)}, rms ${rms.toFixed(3)}, top partial ${Math.max(
      ...NOTES.map((n) => n.freq * Math.max(...PARTIALS.map((p) => p.ratio))),
    ).toFixed(0)}Hz)`,
);
