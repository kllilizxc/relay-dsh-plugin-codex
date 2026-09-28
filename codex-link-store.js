import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class CodexLinkStore {
  constructor(path) {
    this.path = path;
    this.records = loadRecords(path);
  }

  entries() {
    return [...this.records.entries()].map(([sessionId, record]) => [sessionId, structuredClone(record)]);
  }

  set(sessionId, record) {
    this.records.set(String(sessionId), structuredClone(record));
    this.persist();
  }

  delete(sessionId) {
    if (!this.records.delete(String(sessionId))) return;
    this.persist();
  }

  replace(oldSessionId, newSessionId, record) {
    const oldKey = String(oldSessionId);
    const newKey = String(newSessionId);
    const previousOld = this.records.get(oldKey);
    const previousNew = this.records.get(newKey);
    this.records.delete(oldKey);
    this.records.set(newKey, structuredClone(record));
    try {
      this.persist();
    } catch (error) {
      this.records.delete(newKey);
      if (previousOld !== undefined) this.records.set(oldKey, previousOld);
      if (previousNew !== undefined) this.records.set(newKey, previousNew);
      throw error;
    }
  }

  persist() {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    const value = Object.fromEntries([...this.records.entries()].sort(([left], [right]) => left.localeCompare(right)));
    writeFileSync(temporary, `${JSON.stringify({ version: 1, sessions: value }, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
  }
}

function loadRecords(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed?.version !== 1 || !isObject(parsed.sessions)) return new Map();
    return new Map(Object.entries(parsed.sessions).filter(([, record]) => validRecord(record)));
  } catch (error) {
    if (error?.code === "ENOENT") return new Map();
    throw new Error(`Unable to read Codex DSH links from ${path}: ${error.message}`, { cause: error });
  }
}

function validRecord(record) {
  return isObject(record)
    && (record.threadId === null || typeof record.threadId === "string")
    && isObject(record.config)
    && (record.dshTurnIds === undefined || validStringArray(record.dshTurnIds));
}

function validStringArray(value) {
  return Array.isArray(value)
    && value.every(item => typeof item === "string" && item.length > 0)
    && new Set(value).size === value.length;
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
