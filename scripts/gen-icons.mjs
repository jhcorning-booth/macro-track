// Generates the PWA icon set from one SVG source so the mark stays consistent
// across the browser tab, the Home Screen, and the splash.
import sharp from "sharp";
import { mkdir, writeFile } from "node:fs/promises";

const ACCENT = "#d1703f";
const CREAM = "#faf7f3";

/** The tank, filled — the app's own metaphor. `pad` keeps the mark inside the
 *  maskable safe zone (the outer 20% can be cropped to a circle). */
const svg = (size, pad) => {
  const s = size;
  const w = s * (1 - pad * 2);
  const tankW = w * 0.52;
  const tankH = w * 0.78;
  const x = (s - tankW) / 2;
  const y = (s - tankH) / 2;
  const r = tankW * 0.3;
  const fillTop = y + tankH * 0.36;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
  <rect width="${s}" height="${s}" fill="${ACCENT}"/>
  <defs>
    <clipPath id="tank">
      <rect x="${x}" y="${y}" width="${tankW}" height="${tankH}" rx="${r}"/>
    </clipPath>
  </defs>
  <rect x="${x}" y="${y}" width="${tankW}" height="${tankH}" rx="${r}"
        fill="none" stroke="${CREAM}" stroke-width="${s * 0.045}"/>
  <g clip-path="url(#tank)">
    <rect x="${x}" y="${fillTop}" width="${tankW}" height="${tankH}" fill="${CREAM}"/>
  </g>
</svg>`;
};

await mkdir("public/icons", { recursive: true });

const targets = [
  { file: "public/icons/icon-192.png", size: 192, pad: 0.08 },
  { file: "public/icons/icon-512.png", size: 512, pad: 0.08 },
  { file: "public/icons/maskable-512.png", size: 512, pad: 0.2 },
  { file: "public/icons/apple-touch-icon.png", size: 180, pad: 0.06 },
];

for (const t of targets) {
  await sharp(Buffer.from(svg(t.size, t.pad))).png().toFile(t.file);
  console.log("wrote", t.file);
}

await writeFile("public/icons/icon.svg", svg(512, 0.08));
console.log("wrote public/icons/icon.svg");
