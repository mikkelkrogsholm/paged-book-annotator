import { readdir } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const ignoredDirectories = new Set(["node_modules", ".git"]);
const transpiler = new Bun.Transpiler({ loader: "js", target: "bun" });

async function collectJavaScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    if (ignoredDirectories.has(entry.name)) return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectJavaScriptFiles(path);
    return [".js", ".mjs"].includes(extname(entry.name)) ? [path] : [];
  }));
  return nested.flat();
}

for (const filePath of await collectJavaScriptFiles(root)) {
  transpiler.transformSync(await Bun.file(filePath).text());
}
console.log("Bun syntax check passed.");
