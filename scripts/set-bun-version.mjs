const version = Bun.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  throw new TypeError("Angiv en stabil Bun-version som x.y.z.");
}

const root = new URL("../", import.meta.url);
const packageUrl = new URL("package.json", root);
const dockerfileUrl = new URL("Dockerfile", root);
const packageDocument = await Bun.file(packageUrl).json();
packageDocument.packageManager = `bun@${version}`;
packageDocument.engines = { ...packageDocument.engines, bun: version };

const dockerfile = await Bun.file(dockerfileUrl).text();
if (!/^ARG BUN_VERSION=.+$/m.test(dockerfile)) throw new Error("Dockerfiles BUN_VERSION kunne ikke findes.");
const updatedDockerfile = dockerfile.replace(/^ARG BUN_VERSION=.+$/m, `ARG BUN_VERSION=${version}`);

await Promise.all([
  Bun.write(new URL(".bun-version", root), `${version}\n`),
  Bun.write(packageUrl, `${JSON.stringify(packageDocument, null, 2)}\n`),
  Bun.write(dockerfileUrl, updatedDockerfile),
]);

console.log(`Bun er nu fastlåst til ${version}. Kør bun run check og byg Docker-imaget igen.`);
