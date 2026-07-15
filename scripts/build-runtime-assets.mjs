import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const runtimeRoot = resolve(repositoryRoot, "public/runtime");

const runtimeAssets = [
  {
    source: "node_modules/@fontsource/source-serif-4/files/source-serif-4-latin-ext-400-normal.woff2",
    target: "fonts/source-serif-4-latin-ext-400-normal.woff2",
  },
  {
    source: "node_modules/@fontsource/source-serif-4/files/source-serif-4-latin-ext-400-italic.woff2",
    target: "fonts/source-serif-4-latin-ext-400-italic.woff2",
  },
  {
    source: "node_modules/@fontsource/source-sans-3/files/source-sans-3-latin-ext-400-normal.woff2",
    target: "fonts/source-sans-3-latin-ext-400-normal.woff2",
  },
  {
    source: "node_modules/@fontsource/source-sans-3/files/source-sans-3-latin-ext-600-normal.woff2",
    target: "fonts/source-sans-3-latin-ext-600-normal.woff2",
  },
  {
    source: "node_modules/@fontsource/source-serif-4/LICENSE",
    target: "licenses/source-serif-4.txt",
  },
  {
    source: "node_modules/@fontsource/source-sans-3/LICENSE",
    target: "licenses/source-sans-3.txt",
  },
];

for (const asset of runtimeAssets) {
  const sourcePath = resolve(repositoryRoot, asset.source);
  const targetPath = resolve(runtimeRoot, asset.target);
  await mkdir(dirname(targetPath), { recursive: true });
  if (!(await Bun.file(sourcePath).exists())) {
    throw new Error(`Mangler runtime-asset efter bun install: ${asset.source}`);
  }
  await Bun.write(targetPath, Bun.file(sourcePath));
}

console.log(`Byggede ${runtimeAssets.length} selvhostede runtime-assets.`);
