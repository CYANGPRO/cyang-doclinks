import { createCanvas, loadImage } from "@napi-rs/canvas";
import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const iconSource = path.join(appRoot, "public", "icons", "local801-icon.svg");
const maskableSource = path.join(appRoot, "public", "icons", "local801-maskable.svg");
const publicIcons = path.join(appRoot, "public", "icons");
const nativeResources = path.join(appRoot, "resources");

async function renderSquare(source, size, destination) {
  const image = await loadImage(source);
  const canvas = createCanvas(size, size);
  const context = canvas.getContext("2d");
  context.fillStyle = "#134D8C";
  context.fillRect(0, 0, size, size);
  context.drawImage(image, 0, 0, size, size);
  await writeFile(destination, await canvas.encode("png"));
}

async function renderSplash(destination) {
  return renderSplashSize(2732, 2732, destination);
}

async function renderSplashSize(width, height, destination) {
  const imageSize = Math.round(Math.min(width, height) * 0.33);
  const image = await loadImage(maskableSource);
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#134D8C";
  context.fillRect(0, 0, width, height);
  context.drawImage(image, (width - imageSize) / 2, (height - imageSize) / 2, imageSize, imageSize);
  await writeFile(destination, await canvas.encode("png"));
}

async function pngFiles(directory) {
  if (!existsSync(directory)) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const resolved = path.join(directory, entry.name);
    return entry.isDirectory() ? pngFiles(resolved) : entry.name.endsWith(".png") ? [resolved] : [];
  }));
  return nested.flat();
}

async function replaceNativeAssets() {
  const androidRes = path.join(appRoot, "android", "app", "src", "main", "res");
  const densitySizes = new Map([
    ["mipmap-mdpi", 48],
    ["mipmap-hdpi", 72],
    ["mipmap-xhdpi", 96],
    ["mipmap-xxhdpi", 144],
    ["mipmap-xxxhdpi", 192],
  ]);

  for (const [directory, size] of densitySizes) {
    for (const name of ["ic_launcher.png", "ic_launcher_round.png"]) {
      const destination = path.join(androidRes, directory, name);
      if (existsSync(destination)) await renderSquare(iconSource, size, destination);
    }
    const foreground = path.join(androidRes, directory, "ic_launcher_foreground.png");
    if (existsSync(foreground)) await renderSquare(maskableSource, Math.round(size * 2.25), foreground);
  }

  for (const destination of (await pngFiles(androidRes)).filter((file) => path.basename(file) === "splash.png")) {
    const existing = await loadImage(destination);
    await renderSplashSize(existing.width, existing.height, destination);
  }

  const iosApp = path.join(appRoot, "ios", "App", "App");
  const iosIcon = path.join(iosApp, "Assets.xcassets", "AppIcon.appiconset", "AppIcon-512@2x.png");
  if (existsSync(iosIcon)) await renderSquare(iconSource, 1024, iosIcon);

  const iosSplashes = path.join(iosApp, "Assets.xcassets", "Splash.imageset");
  for (const destination of await pngFiles(iosSplashes)) {
    const existing = await loadImage(destination);
    await renderSplashSize(existing.width, existing.height, destination);
  }
}

await Promise.all([
  mkdir(publicIcons, { recursive: true }),
  mkdir(nativeResources, { recursive: true }),
]);

await Promise.all([
  renderSquare(iconSource, 192, path.join(publicIcons, "local801-192.png")),
  renderSquare(iconSource, 512, path.join(publicIcons, "local801-512.png")),
  renderSquare(maskableSource, 512, path.join(publicIcons, "local801-maskable-512.png")),
  renderSquare(iconSource, 180, path.join(publicIcons, "apple-touch-icon.png")),
  renderSquare(iconSource, 1024, path.join(nativeResources, "icon.png")),
  renderSplash(path.join(nativeResources, "splash.png")),
]);

await replaceNativeAssets();

console.log("Generated Local 801 PWA and native source assets.");
