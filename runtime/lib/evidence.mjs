import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const TOKEN_PATTERN = /(?:api[_-]?key|token|secret|password|authorization)\s*(?:=|:|\s)\s*(?:Bearer\s+)?[^\s'"`]{8,}/gi;
const MAX_LOG_BYTES = 64 * 1024;

export function redactAndCap(value) {
  const text = String(value ?? "").replace(TOKEN_PATTERN, "[REDACTED]");
  const bytes = Buffer.from(text);
  if (bytes.length <= MAX_LOG_BYTES) return { text, truncated: false };
  return {
    text: bytes.subarray(0, MAX_LOG_BYTES).toString("utf8") + "\n[TRUNCATED]",
    truncated: true,
  };
}

export async function writeLog(logDirectory, gateId, stream, value) {
  await mkdir(logDirectory, { recursive: true });
  const safeId = gateId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const relative = path.join("logs", `${safeId}.${stream}.log`);
  const result = redactAndCap(value);
  await writeFile(path.join(path.dirname(logDirectory), relative), result.text, "utf8");
  return { ref: relative, truncated: result.truncated };
}

export async function writeAtomicJson(targetPath, value) {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, targetPath);
}

/**
 * Persist a derived human-readable artifact without exposing a partially
 * written report to the owner or to a resumed Orchestrator.
 */
export async function writeAtomicText(targetPath, value) {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.tmp`;
  await writeFile(temporaryPath, String(value), "utf8");
  await rename(temporaryPath, targetPath);
}
