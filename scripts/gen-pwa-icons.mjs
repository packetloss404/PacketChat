// Regenerate PWA / Apple icons and favicon.ico from apps/web/src/app/icon.svg.
// Usage: node scripts/gen-pwa-icons.mjs
import sharp from "sharp";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const svgPath = join(root, "apps", "web", "src", "app", "icon.svg");
const outDir = join(root, "apps", "web", "public");

// Matches --bg in globals.css so the installed app blends with the workspace.
const BG = { r: 10, g: 11, b: 16, alpha: 1 }; // #0a0b10

async function transparent(size, file) {
  const svg = await readFile(svgPath);
  await sharp(svg, { density: 512 }).resize(size, size).png().toFile(join(outDir, file));
}

async function onBackground(size, file, padRatio) {
  const svg = await readFile(svgPath);
  const inner = Math.round(size * (1 - padRatio * 2));
  const logo = await sharp(svg, { density: 512 }).resize(inner, inner).png().toBuffer();
  await sharp({ create: { width: size, height: size, channels: 4, background: BG } })
    .composite([{ input: logo, gravity: "center" }])
    .png()
    .toFile(join(outDir, file));
}

// favicon.ico. sharp cannot encode ICO, but the format is a small directory
// header wrapping images that may themselves be PNGs, so the container is
// assembled by hand around sharp-rendered frames.
async function favicon(sizes, outPath) {
  const svg = await readFile(svgPath);
  const frames = [];
  for (const size of sizes) {
    frames.push({ size, png: await sharp(svg, { density: 512 }).resize(size, size).png().toBuffer() });
  }

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(frames.length, 4);

  let offset = 6 + frames.length * 16;
  const entries = [];
  for (const { size, png } of frames) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0); // 0 means 256
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2); // palette size
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += png.length;
  }

  await writeFile(outPath, Buffer.concat([header, ...entries, ...frames.map((f) => f.png)]));
}

await mkdir(outDir, { recursive: true });
await transparent(192, "icon-192.png");
await transparent(512, "icon-512.png");
await onBackground(512, "icon-maskable.png", 0.18); // maskable safe zone
await onBackground(180, "apple-touch-icon.png", 0.1); // iOS home-screen icon
await favicon([16, 32, 48], join(root, "apps", "web", "src", "app", "favicon.ico"));
console.log("Wrote PWA icons to apps/web/public/ and favicon.ico to apps/web/src/app/");
