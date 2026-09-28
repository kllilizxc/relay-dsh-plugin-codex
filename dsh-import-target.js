import {
  appendPersistedEvents,
  loadPersistedSession,
  sessionEventCount,
  sessionEvents,
  toolCallId as ToolCallId,
} from "./dsh-compat.mjs";
import { createHash } from "node:crypto";

import {
  freezeMessage,
  MessageId,
} from "@deepseek-ai/dsh-llm";
import {
  SessionId,
} from "@deepseek-ai/dsh-session";

import { CODEX_PRESET, CODEX_PROVIDER } from "./codex-adapter.js";

const TERMINAL_CODEX_TURN_STATUSES = new Set(["completed", "interrupted", "failed"]);

export class DshCodexImportTarget {
  constructor({ ctx, runtime, adapter = null, logger = console }) {
    this.ctx = ctx;
    this.runtime = runtime;
    this.adapter = adapter;
    this.logger = logger;
    this.persistedIds = null;
  }

  async prepare(input) {
    const source = await this.runtime.readThread(input.thread.id, { includeTurns: true });
    const sessionId = SessionId(input.binding.sessionId);
    const resident = this.ctx.agents.get(sessionId);
    if (resident) return { ...input, source, agent: resident, handle: null };

    const persistedIds = await this.loadPersistedIds();
    const requestConfig = codexRequestHeaderConfig(input.binding, source);
    const agentOptions = {
      provider: CODEX_PROVIDER,
      model: requestConfig?.model ?? input.binding.config.model,
    };
    const sourceUpdatedAt = input.thread.updatedAt ?? source.updatedAt;
    const sourceCreatedAt = input.thread.createdAt ?? source.createdAt;
    const seed = buildCodexHistorySeed(source.turns ?? [], sourceUpdatedAt, {
      terminalOnly: true,
      requestConfig,
    });
    const handle = persistedIds.has(sessionId)
      ? await this.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions })
      : await this.ctx.agents.create({
          sessionId,
          seed,
          agentOptions,
          meta: {
            cwd: source.cwd ?? input.thread.cwd,
            createdAt: importedHeaderCreatedAt({
              createdAt: sourceCreatedAt,
              updatedAt: sourceUpdatedAt,
            }, seed),
            agentPreset: CODEX_PRESET,
          },
        });
    return { ...input, source, agent: handle.agent, handle };
  }

  async hydrate(transaction) {
    const source = transaction.source;
    const session = transaction.agent.session;
    const result = projectCodexHistory(session, source.turns ?? [], { terminalOnly: true });
    applyThreadTitle(this.ctx, session, source);
    await this.ctx.sessions.flush(session);
    const projectionCache = this.ctx.get?.("sessionProjectionCache");
    if (!projectionCache?.write) {
      throw new Error("Codex session import requires DSH's sessionProjectionCache service");
    }
    await projectionCache.write(session);
    return result;
  }

  async attach(transaction) {
    const workspace = await this.ctx.workspaceRegistry.resolveByPath(transaction.workspaceCwd);
    if (!workspace) throw new Error(`No registered DSH Workspace matches ${transaction.workspaceCwd}`);
    await workspace.attachSession(SessionId(transaction.binding.sessionId));
  }

  async finalize(transaction) {
    await this.ctx.sessions.flush(transaction.agent.session);
    const persistedIds = await this.loadPersistedIds();
    persistedIds.add(SessionId(transaction.binding.sessionId));
  }

  async release(transaction) {
    await transaction.handle?.dispose();
  }

  async sync(binding, ownedTurnIds = new Set()) {
    const source = await this.runtime.readThread(binding.threadId, { includeTurns: true });
    const sessionId = SessionId(binding.sessionId);
    let acquired;
    try {
      acquired = await this.acquireSessionForSync(sessionId);
    } catch (error) {
      if (isMissingDshSessionError(error)) {
        if (!this.adapter?.replaceImportedSession) {
          throw new Error("Codex session sync requires binding replacement to rebuild a missing DSH Session", { cause: error });
        }
        return await this.rebuildFromCodex(binding, source, "dsh-session-not-found");
      }
      throw error;
    }
    const session = acquired.session;
    const requestConfig = codexRequestHeaderConfig(binding, source);
    const rebuildReason = codexHistoryRebuildReason(session, source.turns ?? [], {
      requestConfig,
    });
    if (rebuildReason) {
      if (!this.adapter?.replaceImportedSession) {
        throw new Error(`Codex session sync requires binding replacement to rebuild corrupt DSH history: ${rebuildReason}`);
      }
      return await this.rebuildFromCodex(binding, source, rebuildReason);
    }

    const skippedTurnIds = new Set([
      ...ownedTurnIds,
      ...codexReplayTurnIds(session),
    ]);
    const result = projectCodexHistory(session, source.turns ?? [], {
      terminalOnly: true,
      skipTurnIds: skippedTurnIds,
    });
    if (result.projectedMessages > 0) {
      await this.persistAcquiredSession(acquired);
      const projectionCache = this.ctx.get?.("sessionProjectionCache");
      if (!projectionCache?.write) {
        throw new Error("Codex session sync requires DSH's sessionProjectionCache service");
      }
      await projectionCache.write(session);
    }
    return { ...result, modelSelectionChanged: false };
  }

  async acquireSessionForSync(sessionId) {
    const live = this.liveSession(sessionId);
    if (live) return { session: live, live: true, persistedLength: sessionEventCount(live) };

    const loaded = await loadPersistedSession(this.ctx.sessionPersistence, sessionId);
    const becameLive = this.liveSession(sessionId);
    if (becameLive) {
      return { session: becameLive, live: true, persistedLength: sessionEventCount(becameLive) };
    }
    const session = this.ctx.sessions.prepare(sessionId, {
      seed: structuredClone(loaded.events),
      meta: structuredClone(loaded.meta),
      seedSource: "persistence",
      // rc.1 separates the exact inherited prefix from header.isSeeded.
      // alpha.3 ignores this unknown option, preserving one runtime artifact.
      inheritedEventCount: loaded.inheritedEventCount,
    });
    return { session, live: false, persistedLength: loaded.events.length };
  }

  liveSession(sessionId) {
    return this.ctx.agents?.get?.(sessionId)?.session ?? this.ctx.sessions?.get?.(sessionId);
  }

  async persistAcquiredSession(acquired) {
    if (acquired.live) {
      await this.ctx.sessions.flush(acquired.session);
      return;
    }
    const suffix = sessionEvents(acquired.session, acquired.persistedLength);
    if (suffix.length > 0) {
      await appendPersistedEvents(this.ctx.sessionPersistence, acquired.session.id, suffix);
      acquired.persistedLength = sessionEventCount(acquired.session);
    }
  }

  async rebuildFromCodex(binding, source, reason) {
    const oldSessionId = SessionId(binding.sessionId);
    const sessionId = SessionId(rebuiltSessionId(binding.threadId, binding.sessionId));
    const requestConfig = codexRequestHeaderConfig(binding, source);
    const seed = buildCodexHistorySeed(source.turns ?? [], source.updatedAt, {
      terminalOnly: true,
      requestConfig,
    });
    const agentOptions = {
      provider: CODEX_PROVIDER,
      model: requestConfig?.model ?? binding.config.model,
    };
    const residentReplacement = this.liveSession(sessionId);
    let handle = null;
    let acquired = residentReplacement
      ? { session: residentReplacement, live: true, persistedLength: sessionEventCount(residentReplacement) }
      : null;
    if (!acquired) {
      try {
        handle = await this.ctx.agents.create({
          sessionId,
          seed,
          agentOptions,
          meta: {
            cwd: source.cwd ?? binding.config.cwd,
            createdAt: importedHeaderCreatedAt({
              createdAt: source.createdAt,
              updatedAt: source.updatedAt,
            }, seed),
            agentPreset: CODEX_PRESET,
          },
        });
        acquired = {
          session: handle.agent.session,
          live: true,
          persistedLength: sessionEventCount(handle.agent.session),
        };
      } catch (error) {
        if (!isExistingDshSessionError(error)) throw error;
        acquired = await this.acquireSessionForSync(sessionId);
      }
    }
    try {
      const session = acquired.session;
      const candidateReason = codexHistoryRebuildReason(session, source.turns ?? [], { requestConfig });
      if (candidateReason) {
        throw new Error(`Existing Codex rebuild candidate ${sessionId} is invalid: ${candidateReason}`);
      }
      projectCodexHistory(session, source.turns ?? [], { terminalOnly: true });
      applyThreadTitle(this.ctx, session, source);
      await this.persistAcquiredSession(acquired);
      const projectionCache = this.ctx.get?.("sessionProjectionCache");
      if (!projectionCache?.write) {
        throw new Error("Codex session rebuild requires DSH's sessionProjectionCache service");
      }
      await projectionCache.write(session);
      const cwd = source.cwd ?? binding.config.cwd;
      await this.attachRebuiltSession(sessionId, cwd);
      this.adapter.replaceImportedSession(binding.sessionId, sessionId);
      await this.cleanupReplacedSession(oldSessionId, cwd);
      this.logger.info?.(`Rebuilt imported Codex DSH Session ${oldSessionId} as ${sessionId}: ${reason}`);
      const projected = codexHistoryProjection(source.turns ?? [], { terminalOnly: true });
      return {
        projectedMessages: projected.turns.reduce((count, turn) => (
          count + turn.timeline.filter(entry => entry.kind !== "activity").length
        ), 0),
        projectedActivities: projected.turns.reduce((count, turn) => (
          count + turn.timeline.filter(entry => entry.kind === "activity").length
        ), 0),
        projectedTurns: projected.turns.filter(turn => turn.timeline.length > 0).length,
        skippedItems: projected.skippedItems,
        rebuiltSessionId: String(sessionId),
        rebuiltFromSessionId: String(oldSessionId),
        rebuildReason: reason,
      };
    } finally {
      await handle?.dispose();
    }
  }

  async cleanupReplacedSession(sessionId, cwd) {
    try {
      await this.ctx.workspaceRegistry?.archiveSession?.(sessionId);
    } catch (error) {
      if (!isMissingDshSessionError(error)) {
        this.logger.warn?.(`Could not archive replaced Codex DSH Session ${sessionId}: ${error.message ?? error}`);
      }
    }
    if (!this.ctx.workspaceRegistry?.resolveByPath || !cwd) return;
    try {
      const workspace = await this.ctx.workspaceRegistry.resolveByPath(cwd);
      await workspace?.detachSession?.(sessionId);
    } catch (error) {
      this.logger.warn?.(`Could not detach replaced Codex DSH Session ${sessionId}: ${error.message ?? error}`);
    }
  }

  async attachRebuiltSession(sessionId, cwd) {
    if (!this.ctx.workspaceRegistry?.resolveByPath || !cwd) return;
    const workspace = await this.ctx.workspaceRegistry.resolveByPath(cwd);
    await workspace?.attachSession?.(sessionId);
  }

  async loadPersistedIds() {
    if (this.persistedIds === null) {
      this.persistedIds = new Set(
        (await this.ctx.sessionPersistence.list()).map(header => SessionId(header.id)),
      );
    }
    return this.persistedIds;
  }
}

export function rebuiltSessionId(threadId, oldSessionId = "") {
  const digest = createHash("sha256")
    .update(`${String(threadId)}\n${String(oldSessionId)}`)
    .digest("hex")
    .slice(0, 24);
  return `codex-rebuild-${digest}`;
}

export function projectCodexHistory(session, turns, options = {}) {
  const existing = new Set(session.deriveMessages().map(message => String(message.id)));
  let nextTurn = sessionEvents(session).filter(event => event.type === "turn/start").length + 1;
  let projectedMessages = 0;
  let projectedActivities = 0;
  let projectedTurns = 0;
  const projection = codexHistoryProjection(turns, options);

  for (const sourceTurn of projection.turns) {
    const expectedIds = projectionMessageIds(sourceTurn);
    const presentCount = expectedIds.filter(id => existing.has(id)).length;
    if (presentCount === expectedIds.length) continue;
    if (presentCount > 0) {
      throw new Error(`Cannot incrementally project partial Codex Turn ${sourceTurn.sourceId}`);
    }

    const turn = nextTurn++;
    appendProjectedTurn((type, data, surfaceOp) => {
      session.append(type, data, surfaceOp === null ? undefined : { surfaceOp });
    }, sourceTurn, turn);
    for (const id of expectedIds) existing.add(id);
    projectedMessages += sourceTurn.timeline.filter(entry => entry.kind !== "activity").length;
    projectedActivities += sourceTurn.timeline.filter(entry => entry.kind === "activity").length;
    projectedTurns += 1;
  }

  return {
    projectedMessages,
    projectedActivities,
    projectedTurns,
    skippedItems: projection.skippedItems,
  };
}

export function codexHistoryRebuildReason(session, turns, options = {}) {
  const headerReason = codexRequestHeaderRebuildReason(session, options.requestConfig);
  if (headerReason) return headerReason;

  let messages;
  try {
    messages = session.deriveMessages();
  } catch {
    return "message-derivation-failed";
  }

  const expectedProjection = codexHistoryProjection(turns, { terminalOnly: true });
  const expectedCodexIds = expectedProjection.turns.flatMap(projectionMessageIds);
  const expectedCodexIdSet = new Set(expectedCodexIds);
  const actualCodexIds = messages.map(message => String(message.id)).filter(isCodexProjectionMessageId);
  if (actualCodexIds.some(id => !expectedCodexIdSet.has(id))) return "codex-message-not-in-source";
  if (!isOrderedSubsequence(actualCodexIds, expectedCodexIds)) return "codex-message-order-drift";

  const actualMessages = new Map(messages.map(message => [String(message.id), message]));
  for (const expectedTurn of expectedProjection.turns) {
    for (const entry of expectedTurn.timeline) {
      if (entry.kind === "activity") continue;
      const { id, role, text } = entry;
      const actual = actualMessages.get(id);
      if (!actual) continue;
      if (actual.role !== role) return "codex-message-role-drift";
      if (textFromDshMessage(actual) !== text) return "codex-message-content-drift";
    }
  }

  const activityReason = codexActivityRebuildReason(session, expectedProjection.turns);
  if (activityReason) return activityReason;

  const codexMessageTurns = new Set();
  const dshTurnByMessageId = new Map();
  const endReasonByTurn = new Map();
  let currentTurn = null;
  for (const event of sessionEvents(session)) {
    if (typeof event.type === "string" && event.type.startsWith("relay-codex/")) {
      return "legacy-relay-codex-event";
    }
    if (event.type === "turn/start") {
      currentTurn = event.data.turn;
      continue;
    }
    if (event.type === "user/message" && isCodexProjectionMessageId(event.data?.id)) {
      codexMessageTurns.add(currentTurn);
      dshTurnByMessageId.set(String(event.data.id), currentTurn);
      continue;
    }
    if (event.type === "assistant/message" && isCodexProjectionMessageId(event.data?.message?.id)) {
      const turn = event.data.turn ?? currentTurn;
      codexMessageTurns.add(turn);
      dshTurnByMessageId.set(String(event.data.message.id), turn);
      continue;
    }
    if (event.type === "tool/result" && isCodexProjectionMessageId(event.data?.message?.id)) {
      const turn = event.data.turn ?? currentTurn;
      codexMessageTurns.add(turn);
      dshTurnByMessageId.set(String(event.data.message.id), turn);
      continue;
    }
    if (event.type === "turn/end") {
      const turn = event.data.turn;
      endReasonByTurn.set(turn, event.data.reason);
      if (event.data.reason?.kind === "error" && !codexMessageTurns.has(turn)) {
        return "dsh-runtime-error-turn";
      }
      if (currentTurn === turn) currentTurn = null;
    }
  }

  for (const expectedTurn of expectedProjection.turns) {
    const expectedIds = projectionMessageIds(expectedTurn);
    const presentIds = expectedIds.filter(id => actualMessages.has(id));
    if (presentIds.length === 0) continue;
    if (presentIds.length !== expectedIds.length) return "codex-turn-partially-projected";
    const dshTurns = new Set(presentIds.map(id => dshTurnByMessageId.get(id)));
    if (dshTurns.size !== 1 || dshTurns.has(undefined) || dshTurns.has(null)) {
      return "codex-turn-boundary-drift";
    }
    const [dshTurn] = dshTurns;
    if (!sameTurnEndReason(endReasonByTurn.get(dshTurn), expectedTurn.endReason)) {
      return "codex-turn-end-reason-drift";
    }
  }
  return null;
}

function codexRequestHeaderRebuildReason(session, expectedConfig) {
  if (!expectedConfig) return null;
  const events = sessionEvents(session);
  const headers = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.type === "request/header");
  if (headers.length === 0) return "codex-request-header-missing";
  if (headers.length > 1) return "codex-request-header-ambiguous";
  const firstEndSeed = events.findIndex(event => event.type === "session/end-seed");
  if (firstEndSeed >= 0 && headers[0].index > firstEndSeed) {
    return "codex-request-header-after-end-seed";
  }
  const config = headers[0].event.data?.header?.config
    ?? session.requestHeader?.()?.config;
  if (!sameRequestConfig(config, expectedConfig)) return "codex-request-header-drift";
  return null;
}

export function buildCodexHistorySeed(turns, updatedAt, options = {}) {
  const projection = codexHistoryProjection(turns, options);
  const time = codexTimestampMs(updatedAt);
  const events = [];
  const append = (type, data, surfaceOp = null) => {
    events.push({
      type,
      seq: events.length,
      time,
      data,
      ...(surfaceOp === null ? {} : { surfaceOp }),
    });
  };

  if (options.requestConfig) {
    append("request/header", {
      header: { config: options.requestConfig },
      reason: "initial",
    });
  }

  let turn = 1;
  for (const sourceTurn of projection.turns) {
    if (sourceTurn.timeline.length === 0) continue;
    appendProjectedTurn(append, sourceTurn, turn);
    turn += 1;
  }
  return events;
}

function codexHistoryProjection(turns, {
  terminalOnly = false,
  skipTurnIds = new Set(),
} = {}) {
  const projected = [];
  let skippedItems = 0;
  for (const sourceTurn of turns) {
    if (!sourceTurn || typeof sourceTurn.id !== "string" || !Array.isArray(sourceTurn.items)) continue;
    if (skipTurnIds.has(sourceTurn.id)) continue;
    if (terminalOnly && !TERMINAL_CODEX_TURN_STATUSES.has(sourceTurn.status)) continue;
    const timeline = [];
    const ordinals = new Map();
    for (const [index, item] of sourceTurn.items.entries()) {
      const ordinal = ordinals.get(item?.type) ?? 0;
      ordinals.set(item?.type, ordinal + 1);
      const key = projectionItemKey(item, ordinal, index);
      if (item?.type === "userMessage") {
        const text = textFromUserItem(item);
        if (text) timeline.push({
          kind: "message",
          id: `codex:${sourceTurn.id}:user:${key}`,
          role: "user",
          text,
        });
      } else if (item?.type === "agentMessage") {
        const text = normalizedText(item.text);
        if (text) timeline.push({
          kind: "message",
          id: `codex:${sourceTurn.id}:assistant:${key}`,
          role: "assistant",
          text,
          phase: normalizedText(item.phase) || null,
        });
      } else if (isProjectedActivity(item)) {
        timeline.push(projectCodexActivity(sourceTurn.id, item, key));
      } else {
        skippedItems += 1;
      }
    }
    projected.push({
      sourceId: sourceTurn.id,
      timeline,
      endReason: codexTurnEndReason(sourceTurn),
    });
  }
  return { turns: projected, skippedItems };
}

function appendProjectedTurn(append, sourceTurn, turn) {
  append("turn/start", { turn });
  let step = 0;
  for (const entry of sourceTurn.timeline) {
    if (entry.kind === "message" && entry.role === "user") {
      append("user/message", freezeMessage({
        id: MessageId(entry.id),
        role: "user",
        content: [{ type: "text", text: entry.text }],
        source: { kind: "user" },
      }), "append");
      continue;
    }

    step += 1;
    append("step/start", { turn, step });
    if (entry.kind === "message") {
      append("assistant/message", {
        turn,
        step,
        stream: [],
        message: freezeMessage({
          id: MessageId(entry.id),
          role: "assistant",
          content: [{ type: "text", text: entry.text }],
          source: { kind: "model", provider: CODEX_PROVIDER, model: "imported" },
        }),
      }, "append");
    } else {
      const callId = ToolCallId(entry.callId);
      append("assistant/message", {
        turn,
        step,
        stream: [],
        message: freezeMessage({
          id: MessageId(entry.requestId),
          role: "assistant",
          content: [{
            type: "tool-call",
            id: callId,
            name: entry.toolName,
            arguments: entry.arguments,
          }],
          source: { kind: "model", provider: CODEX_PROVIDER, model: "imported" },
        }),
      }, "append");
      append("tool/call", {
        turn,
        step,
        callId,
        name: entry.toolName,
        arguments: entry.arguments,
      });
      append("tool/result", {
        turn,
        step,
        message: freezeMessage({
          id: MessageId(entry.resultId),
          role: "user",
          content: [{
            type: "tool-result",
            toolCallId: callId,
            content: entry.resultContent,
            isError: entry.isError,
          }],
          source: { kind: "tool", callId },
        }),
        ...(entry.error ? { error: entry.error } : {}),
        ...(entry.meta ? { meta: entry.meta } : {}),
      }, "append");
    }
    append("step/end", { turn, step });
  }
  append("turn/end", { turn, reason: sourceTurn.endReason });
}

function projectionMessageIds(turn) {
  return turn.timeline.flatMap(entry => entry.kind === "activity"
    ? [entry.requestId, entry.resultId]
    : [entry.id]);
}

function projectionItemKey(item, ordinal, index) {
  const id = normalizedText(item?.id);
  return id || `${normalizedText(item?.type) || "item"}-${ordinal}-${index}`;
}

function isProjectedActivity(item) {
  return item?.type === "commandExecution"
    || item?.type === "fileChange"
    || item?.type === "webSearch"
    || item?.type === "mcpToolCall";
}

function projectCodexActivity(turnId, item, key) {
  const identity = `codex:${turnId}:activity:${key}`;
  const common = {
    kind: "activity",
    sourceType: item.type,
    requestId: `${identity}:request`,
    resultId: `${identity}:result`,
    callId: `${identity}:call`,
  };
  if (item.type === "commandExecution") {
    const exitCode = Number.isInteger(item.exitCode) ? item.exitCode : null;
    const output = rawText(item.aggregatedOutput) || "(no output)";
    const result = exitCode !== null && exitCode !== 0
      ? `${output.replace(/\n+$/, "")}\n[exit code: ${exitCode}]`
      : output;
    const isError = failedActivity(item);
    return {
      ...common,
      toolName: "bash",
      arguments: jsonText({
        command: rawText(item.command),
        description: commandActivityDescription(item),
        ...(normalizedText(item.cwd) ? { workdir: normalizedText(item.cwd) } : {}),
      }),
      resultContent: [{ type: "text", text: result }],
      isError,
      ...(isError ? { error: activityError(item, "CodexCommandError", "CODEX_COMMAND_FAILED") } : {}),
    };
  }
  if (item.type === "fileChange") {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const diffs = changes.flatMap(fileChangeDiffs);
    const first = changes[0];
    const isUpdate = changes.some(change => change?.kind?.type !== "add");
    const isError = failedActivity(item);
    return {
      ...common,
      toolName: isUpdate ? "edit" : "write",
      arguments: jsonText(isUpdate ? {
        file_path: normalizedText(first?.path) || "(unknown file)",
        old_string: diffs[0]?.oldText ?? "",
        new_string: diffs[0]?.newText ?? rawText(first?.diff),
      } : {
        file_path: normalizedText(first?.path) || "(unknown file)",
        content: rawText(first?.diff),
      }),
      resultContent: [{ type: "text", text: fileChangeResultText(changes) }],
      isError,
      ...(diffs.length > 0 ? { meta: { diffs } } : {}),
      ...(isError ? { error: activityError(item, "CodexFileChangeError", "CODEX_FILE_CHANGE_FAILED") } : {}),
    };
  }
  if (item.type === "webSearch") {
    const query = normalizedText(item.query)
      || normalizedText(item.action?.query)
      || (Array.isArray(item.action?.queries) ? item.action.queries.map(normalizedText).filter(Boolean).join("; ") : "");
    return {
      ...common,
      toolName: "web_search",
      arguments: jsonText({ query, queries: Array.isArray(item.action?.queries) ? item.action.queries : [query] }),
      resultContent: [{
        type: "text",
        text: item.results == null ? `Search completed: ${query}` : jsonText(item.results, "Search completed"),
      }],
      isError: false,
    };
  }
  const mcpError = failedActivity(item);
  return {
    ...common,
    toolName: "run_code",
    arguments: jsonText({
      description: [normalizedText(item.server), normalizedText(item.tool)].filter(Boolean).join(" · ") || "Codex tool call",
      code: jsonText(item.arguments, "{}"),
    }),
    resultContent: [{
      type: "text",
      text: item.result == null
        ? normalizedErrorText(item.error) || "(no output)"
        : jsonText(item.result, "(unserializable result)"),
    }],
    isError: mcpError,
    ...(mcpError ? { error: activityError(item, "CodexMcpToolError", "CODEX_MCP_TOOL_FAILED") } : {}),
  };
}

function commandActivityDescription(item) {
  const actions = Array.isArray(item.commandActions) ? item.commandActions : [];
  const labels = [...new Set(actions.map(action => ({
    readFiles: "Read files",
    read: "Read files",
    listFiles: "List files",
    search: "Search files",
  })[action?.type]).filter(Boolean))];
  if (labels.length > 0) return labels.join(", ");
  const command = normalizedText(item.command);
  return command ? command.split("\n", 1)[0].slice(0, 120) : "Run command";
}

function fileChangeResultText(changes) {
  if (changes.length === 0) return "No file changes recorded";
  return changes.map(change => {
    const type = change?.kind?.type;
    const verb = type === "add" ? "Added" : type === "delete" ? "Deleted" : "Updated";
    const path = normalizedText(change?.path) || "(unknown file)";
    const movePath = normalizedText(change?.kind?.move_path);
    return movePath ? `Moved ${path} to ${movePath}` : `${verb} ${path}`;
  }).join("\n");
}

function fileChangeDiffs(change) {
  const path = normalizedText(change?.path);
  const diff = rawText(change?.diff);
  if (!path || !diff) return [];
  if (change?.kind?.type === "add") return [{ path, oldText: null, newText: diff }];
  if (change?.kind?.type === "delete" && !diff.includes("@@")) {
    return [{ path, oldText: diff, newText: "" }];
  }
  const hunks = [];
  let oldLines = [];
  let newLines = [];
  const flush = () => {
    if (oldLines.length === 0 && newLines.length === 0) return;
    hunks.push({
      path,
      oldText: oldLines.length > 0 ? oldLines.join("\n") : null,
      newText: newLines.join("\n"),
    });
    oldLines = [];
    newLines = [];
  };
  let insideHunk = false;
  const lines = diff.split("\n");
  for (const [index, line] of lines.entries()) {
    if (index === lines.length - 1 && line === "") continue;
    if (line.startsWith("@@")) {
      flush();
      insideHunk = true;
      continue;
    }
    if (!insideHunk || line.startsWith("\\ No newline")) continue;
    if (line.startsWith("-")) oldLines.push(line.slice(1));
    else if (line.startsWith("+")) newLines.push(line.slice(1));
    else {
      const text = line.startsWith(" ") ? line.slice(1) : line;
      oldLines.push(text);
      newLines.push(text);
    }
  }
  flush();
  return hunks;
}

function activityError(item, name, fallbackCode) {
  const source = typeof item.error === "object" && item.error !== null ? item.error : {};
  return {
    name: normalizedText(source.name) || name,
    code: normalizedText(source.code) || fallbackCode,
  };
}

function failedActivity(item) {
  return item?.error != null || ["failed", "declined", "cancelled"].includes(item?.status);
}

function normalizedErrorText(error) {
  if (typeof error === "string") return error.trim();
  if (typeof error !== "object" || error === null) return "";
  return normalizedText(error.message) || jsonText(error, "");
}

function jsonText(value, fallback = "null") {
  try {
    return JSON.stringify(value, null, 2) ?? fallback;
  } catch {
    return fallback;
  }
}

function rawText(value) {
  return typeof value === "string" ? value : "";
}

function codexActivityRebuildReason(session, turns) {
  const expected = new Map(turns.flatMap(turn => turn.timeline)
    .filter(entry => entry.kind === "activity")
    .map(entry => [entry.callId, entry]));
  const calls = new Map();
  const results = new Map();
  for (const event of sessionEvents(session)) {
    if (event.type === "tool/call") calls.set(String(event.data.callId), event.data);
    if (event.type === "tool/result") results.set(String(event.data.message?.source?.callId), event.data);
  }
  for (const [callId, entry] of expected) {
    const call = calls.get(callId);
    const result = results.get(callId);
    if (!call && !result) continue;
    if (!call || !result) return "codex-activity-partially-projected";
    if (call.name !== entry.toolName || call.arguments !== entry.arguments) {
      return "codex-activity-call-drift";
    }
    const block = result.message?.content?.[0];
    if (block?.type !== "tool-result"
      || block.isError !== entry.isError
      || jsonText(block.content) !== jsonText(entry.resultContent)
      || jsonText(result.meta) !== jsonText(entry.meta)) {
      return "codex-activity-result-drift";
    }
  }
  return null;
}

function codexTurnEndReason(sourceTurn) {
  if (sourceTurn.status === "interrupted") return { kind: "interrupted" };
  if (sourceTurn.status === "failed") {
    return {
      kind: "error",
      error: {
        message: normalizedText(sourceTurn.error?.message) || "Imported Codex turn failed",
        code: "CODEX_IMPORTED_TURN_FAILED",
      },
    };
  }
  return { kind: "completed" };
}

function codexReplayTurnIds(session) {
  const result = new Set();
  for (const message of session.deriveMessages()) {
    if (message.role !== "assistant" || message.source?.kind !== "model") continue;
    const replay = message.source.replayState?.response ?? message.source.replayState;
    const turnId = replay?.turnId;
    if (typeof turnId === "string" && turnId) result.add(turnId);
  }
  return result;
}

function codexRequestHeaderConfig(binding, source) {
  const model = normalizedText(source?.model) || normalizedText(binding?.config?.model);
  if (!model) return null;
  const reasoningEffort = normalizedText(source?.effort) || normalizedText(binding?.config?.effort);
  return {
    provider: CODEX_PROVIDER,
    model,
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

function sameRequestConfig(left, right) {
  return normalizedText(left?.provider) === normalizedText(right?.provider)
    && normalizedText(left?.model) === normalizedText(right?.model)
    && normalizedText(left?.reasoningEffort) === normalizedText(right?.reasoningEffort);
}

function textFromDshMessage(message) {
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .filter(block => block?.type === "text")
    .map(block => normalizedText(block.text))
    .filter(Boolean)
    .join("\n");
}

function sameTurnEndReason(left, right) {
  if (left?.kind !== right?.kind) return false;
  if (right?.kind !== "error") return true;
  return normalizedText(left?.error?.message) === normalizedText(right.error?.message)
    && normalizedText(left?.error?.code) === normalizedText(right.error?.code);
}

function isCodexProjectionMessageId(value) {
  return /^codex:/.test(String(value ?? ""));
}

function isOrderedSubsequence(actual, expected) {
  let cursor = 0;
  for (const id of actual) {
    cursor = expected.indexOf(id, cursor);
    if (cursor === -1) return false;
    cursor += 1;
  }
  return true;
}

function isMissingDshSessionError(error) {
  return typeof error?.message === "string"
    && (/\bsession\b.*\bnot found\b/i.test(error.message)
      || /\bno such session\b/i.test(error.message));
}

function isExistingDshSessionError(error) {
  return typeof error?.message === "string"
    && (/\bsession\b.*\balready exists\b/i.test(error.message)
      || /\blog already exists\b/i.test(error.message));
}

function importedHeaderCreatedAt(thread, seed) {
  const updatedAt = codexTimestampMs(thread.updatedAt);
  const hasUserMessage = seed.some(event => event.type === "user/message");
  if (!hasUserMessage) return updatedAt;
  return Math.min(codexTimestampMs(thread.createdAt, updatedAt), updatedAt);
}

function codexTimestampMs(value, fallback = Date.now()) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return fallback;
  const milliseconds = value < 1_000_000_000_000 ? value * 1000 : value;
  return Math.trunc(milliseconds);
}

function applyThreadTitle(ctx, session, thread) {
  const titles = ctx.get?.("sessionTitle");
  if (!titles) throw new Error("Codex session import requires DSH's sessionTitle service");
  const title = normalizedText(thread.name)
    || summarizeTitle(thread.preview)
    || `Codex ${String(thread.id).slice(0, 8)}`;
  if (titles.get(session)?.title === title) return;
  titles.rename(session, title);
}

function textFromUserItem(item) {
  if (!Array.isArray(item.content)) return "";
  return item.content
    .filter(part => part?.type === "text" || part?.type === "inputText")
    .map(part => normalizedText(part.text))
    .filter(Boolean)
    .join("\n");
}

function normalizedText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function summarizeTitle(value) {
  const text = normalizedText(value).replace(/\s+/g, " ");
  return text.length > 54 ? `${text.slice(0, 53)}...` : text;
}
