// node:sqlite is still flagged experimental; keep its warning out of our output.
process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (w.name !== "ExperimentalWarning") console.warn(w);
});

import { startMcpServer } from "./server.js";
startMcpServer().catch((e) => {
  process.stderr.write(`orchestrator mcp failed: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(1);
});
