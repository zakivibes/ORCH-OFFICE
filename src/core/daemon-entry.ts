process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (w.name !== "ExperimentalWarning") console.warn(w);
});
import { startDaemon } from "./daemon.js";
startDaemon();
