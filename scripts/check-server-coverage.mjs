import { fileURLToPath } from "node:url";

const minimumFunctions = 85;
const minimumLines = 90;
const processResult = Bun.spawn(["bun", "test", "src/server", "scripts/pba-bundle.test.mjs", "--coverage"], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  env: process.env,
  stdout: "pipe",
  stderr: "pipe",
});

const [stdout, stderr, exitCode] = await Promise.all([
  new Response(processResult.stdout).text(),
  new Response(processResult.stderr).text(),
  processResult.exited,
]);
process.stdout.write(stdout);
process.stderr.write(stderr);
if (exitCode !== 0) process.exit(exitCode);

const report = `${stdout}\n${stderr}`.replaceAll(/\u001b\[[0-9;]*m/g, "");
const aggregate = report.match(/^All files\s+\|\s+([0-9.]+)\s+\|\s+([0-9.]+)\s+\|/m);
if (!aggregate) throw new Error("Buns samlede coverage-række kunne ikke læses.");
const functions = Number(aggregate[1]);
const lines = Number(aggregate[2]);
if (functions < minimumFunctions || lines < minimumLines) {
  throw new Error(`Server-coverage kræver ${minimumFunctions}% functions og ${minimumLines}% lines; resultatet var ${functions}% functions og ${lines}% lines.`);
}
console.log(`Server coverage gate passed: ${functions}% functions og ${lines}% lines.`);
