import { createInterface } from "node:readline";

/**
 * Stream a child's stdout as parsed JSON lines. Partially-written lines are
 * handled by readline; oversized non-JSON lines (banners, progress spinners)
 * are yielded as raw text rather than throwing, because several of these CLIs
 * emit human-readable banners before their first JSON record.
 */
export async function* readJsonLines(
  stream: NodeJS.ReadableStream,
): AsyncGenerator<unknown, void, undefined> {
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        yield { __raw: trimmed };
        continue;
      }
      yield parsed;
    }
  } finally {
    rl.close();
  }
}

export function drain(stream: NodeJS.ReadableStream, sink: (s: string) => void) {
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => sink(chunk));
}

export function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}