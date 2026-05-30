// Regenerate PWA / Apple icons from apps/web/src/app/icon.svg.
// Usage: node scripts/gen-pwa-icons.mjs
import sharp from "sharp";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const svgPath = join(root, "apps", "web", "src", "app", "icon.svg");
const outDir = join(root, "apps", "web", "public");

// Matches --bg in globals.css so the installed app blends with the workspace.
const BG = { r: 15, g: 15, b: 16, alpha: 1 };

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

await mkdir(outDir, { recursive: true });
await transparent(192, "icon-192.png");
await transparent(512, "icon-512.png");
await onBackground(512, "icon-maskable.png", 0.18); // maskable safe zone
await onBackground(180, "apple-touch-icon.png", 0.1); // iOS home-screen icon
console.log("Wrote PWA icons to apps/web/public/");
