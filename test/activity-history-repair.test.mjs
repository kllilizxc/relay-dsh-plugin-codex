import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import SessionStore, { Session, SessionId } from "@deepseek-ai/dsh-session";
import JsonlSessionPersistence from "@deepseek-ai/dsh-session-persistence-jsonl";
import { zstdCompressSync } from "node:zlib";
import { repairActivityHistory, scanActivityHistories } from "../scripts/repair-activity-history.mjs";
import { loadPersistedSession, sessionEvents, writePersistedSession } from "../dsh-compat.mjs";

const payload = {
  version: 1, threadId: "thread-test", turnId: "turn-test", itemId: "item-test", phase: "started",
  activity: { type: "commandExecution", status: "running", title: "Ran commands", input: "$ pwd" },
};

for (const compression of ["none", "zstd"]) {
  test(`legacy ${compression} history refuses before repair and cold loads losslessly after repair`, async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-history-repair-"));
    const contexts = [];
    async function mount() {
      const ctx = new Context(); contexts.push(ctx);
      await ctx.plugin(SessionStore);
      await ctx.plugin(JsonlSessionPersistence, { root, compression });
      return ctx;
    }
    try {
      const id = SessionId("legacy-activity");
      const session = Session.create(id);
      session.append("turn/start", { turn: 1 });
      session.append("relay-codex/activity", payload);
      session.append("relay-codex/activity", {
        ...payload, phase: "completed", activity: { ...payload.activity, status: "completed", output: "## raw output\n" },
      });
      session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
      const writer = await mount();
      await writePersistedSession(writer.sessionPersistence, session.header, sessionEvents(session));
      await writer.fiber.dispose();
      const reader = await mount();
      await assert.rejects(loadPersistedSession(reader.sessionPersistence, id), { name: "SessionFormatUnsupportedError" });
      await reader.fiber.dispose();
      const path = join(root, (await readdir(root, { recursive: true })).find(file => file.endsWith(compression === "zstd" ? ".jsonl.zstd" : ".jsonl")));
      const original = await readFile(path);
      assert.equal((await repairActivityHistory(path)).changed, 2);
      assert.deepEqual(await readFile(path), original);
      const repaired = await repairActivityHistory(path, { write: true });
      assert.equal(repaired.changed, 2);
      assert.deepEqual(await readFile(repaired.backup), original);
      const fixed = await mount();
      const loaded = await loadPersistedSession(fixed.sessionPersistence, id);
      assert.deepEqual(loaded.events, sessionEvents(session).map(event => event.type === "relay-codex/activity"
        ? { ...event, ignorable: true } : event));
      const repairedBytes = await readFile(path);
      assert.equal((await repairActivityHistory(path, { write: true })).changed, 0);
      assert.deepEqual(await readFile(path), repairedBytes);
    } finally {
      for (const ctx of contexts) await ctx.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("repair preserves unrelated unknown events and refuses malformed or torn activity logs", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-repair-refusal-"));
  try {
    const path = join(root, "session.jsonl");
    const header = { type: "session", version: 0, id: "fixture" };
    const unrelated = { type: "future/required", seq: 1, time: 1, data: {} };
    const activity = { type: "relay-codex/activity", seq: 0, time: 1, data: payload };
    const text = records => records.map(record => JSON.stringify(record)).join("\n") + "\n";
    await writeFile(path, text([header, activity, unrelated]));
    await repairActivityHistory(path, { write: true });
    const repaired = (await readFile(path, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(repaired[2], unrelated);
    for (const bytes of [text([header, { ...activity, data: {} }]), text([header, activity]).slice(0, -1), "invalid\n"]) {
      await writeFile(path, bytes);
      await assert.rejects(repairActivityHistory(path, { write: true }));
      assert.equal(await readFile(path, "utf8"), bytes);
    }
  } finally { await rm(root, { recursive: true, force: true }) }
});

test("root scan covers old and new logs across workspaces, skips backups and symlinks, and verifies zero remaining", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-repair-scan-"));
  try {
    const header = JSON.stringify({ type: "session", version: 0, id: "fixture" }) + "\n";
    const event = { type: "relay-codex/activity", seq: 0, time: 1, data: payload };
    const line = JSON.stringify(event) + "\n";
    const oldPath = join(root, "old-workspace", "old-session", "session.jsonl");
    const newPath = join(root, "new-workspace", "new-session", "session.jsonl.zstd");
    const cleanPath = join(root, "new-workspace", "fixed-session", "session.jsonl");
    for (const path of [oldPath, newPath, cleanPath]) await mkdir(join(path, ".."), { recursive: true });
    await writeFile(oldPath, header + line);
    await utimes(oldPath, new Date("2001-01-01"), new Date("2001-01-01"));
    await writeFile(newPath, Buffer.concat([zstdCompressSync(header), zstdCompressSync(line)]));
    await writeFile(cleanPath, header + JSON.stringify({ ...event, ignorable: true }) + "\n");
    await writeFile(`${oldPath}.bak`, header + line);
    await symlink(join(root, "old-workspace"), join(root, "linked-workspace"), "junction");
    const report = await scanActivityHistories(root);
    assert.equal(report.scanned, 3);
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.affected.map(entry => entry.path).sort(), [oldPath, newPath].sort());
    assert.equal(await readFile(oldPath, "utf8"), header + line);
    for (const entry of report.affected) await repairActivityHistory(entry.path, { write: true });
    assert.deepEqual(await scanActivityHistories(root), { scanned: 3, affected: [], errors: [] });
    await writeFile(newPath, "broken zstd");
    const broken = await scanActivityHistories(root);
    assert.equal(broken.scanned, 3);
    assert.equal(broken.errors.length, 1);
    assert.equal(broken.errors[0].path, newPath);
  } finally { await rm(root, { recursive: true, force: true }) }
});
