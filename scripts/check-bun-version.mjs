const root = new URL("../", import.meta.url);
const expectedVersion = (await Bun.file(new URL(".bun-version", root)).text()).trim();
const packageDocument = await Bun.file(new URL("package.json", root)).json();
const dockerfile = await Bun.file(new URL("Dockerfile", root)).text();
const packageVersion = String(packageDocument.packageManager ?? "").replace(/^bun@/, "");
const dockerVersion = dockerfile.match(/^ARG BUN_VERSION=(.+)$/m)?.[1]?.trim();

const pins = new Map([
  ["package.json#packageManager", packageVersion],
  ["package.json#engines.bun", packageDocument.engines?.bun],
  ["Dockerfile#BUN_VERSION", dockerVersion],
]);

const mismatches = [...pins].filter(([, version]) => version !== expectedVersion);
if (mismatches.length > 0) {
  const details = mismatches.map(([location, version]) => `${location}=${version || "mangler"}`).join(", ");
  throw new Error(`Bun-versionerne matcher ikke .bun-version (${expectedVersion}): ${details}`);
}

console.log(`Bun version pins agree on ${expectedVersion}.`);
