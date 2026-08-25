/**
 * Server-side load of one recorded council session.
 *
 * Reads the Black Box's own JSONL on disk — no API, no database — because the
 * event log already IS the persistence format (`BlackBox.toJSONL()` on the
 * write side; see arena-core/blackbox.ts). A war room UI is a projection of
 * this file, nothing more.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RecordedEvent } from "@arena/core/blackbox.js";

export async function loadSession(file = "session.jsonl"): Promise<RecordedEvent[]> {
  const path = join(process.cwd(), "fixtures", file);
  const text = await readFile(path, "utf8");
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as RecordedEvent);
}
