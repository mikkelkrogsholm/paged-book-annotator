import { runBundleCli } from "./pba-bundle.mjs";

process.exitCode = await runBundleCli(["validate", Bun.argv[2] ?? "example/book", ...Bun.argv.slice(3)]);
