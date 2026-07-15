import { fileURLToPath } from "node:url";

const minimumCoverage = 80;
const processResult = Bun.spawn(["bun", "test", "src/server", "--coverage"], {
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
if (functions < minimumCoverage || lines < minimumCoverage) {
  throw new Error(`Server-coverage kræver ${minimumCoverage}% samlet; resultatet var ${functions}% functions og ${lines}% lines.`);
}
console.log(`Server coverage gate passed: ${functions}% functions og ${lines}% lines.`);
