import { EventEmitter } from "node:events";
import { definePlugin } from "./internal/plugin-sdk.mjs";
import { CodexAppServerClient, RELAY_CODEX_APP_SERVER_ARGS } from "./app-server-client.mjs";
import { CodexSessionRuntime } from "./session-runtime.mjs";

export const CODEX_EXECUTION_CAPABILITY = "relay.execution.codex.v1";
export const CODEX_TERMINAL_CAPABILITY = "relay.terminal.codex.v1";

export function createCodexExecutionPlugin(config = {}) {
  const controller = config.controller ?? new CodexRuntimeController(config);
  return definePlugin({
    manifest: {
      id: "relay.execution.codex",
      version: "1.1.0",
      provides: {
        [CODEX_EXECUTION_CAPABILITY]: "1.1.0",
        [CODEX_TERMINAL_CAPABILITY]: "1.0.0",
      },
      optional: { "relay.logging.v1": "^1.0.0" },
      permissions: ["process:codex-app-server", "filesystem:workspace"],
    },
    activate({ capabilities, defer }) {
      const logger = capabilities.optional("relay.logging.v1") ?? console;
      controller.logger = logger;
      controller.onReload = config.onReload;
      const ready = controller.start(config.command);
      defer(() => controller.close());
      void ready.catch((error) => {
        logger.error?.(`Relay Codex App Server failed to initialize: ${error?.stack ?? error}`);
      });

      return {
        capabilities: {
          [CODEX_EXECUTION_CAPABILITY]: executionCapability(controller),
          [CODEX_TERMINAL_CAPABILITY]: terminalCapability(controller),
        },
      };
    },
  });
}

export class CodexRuntimeController extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = { ...config };
    this.cwd = config.cwd ?? process.cwd();
    this.current = null;
    this.ready = null;
    this.started = false;
    this.closed = false;
    this.reloadPromise = null;
    this.desiredCommand = undefined;
    this.logger = console;
    this.onReload = null;
    this.idleTimeoutMs = config.idleTimeoutMs ?? 30_000;
    this.idleTimer = null;
    this.parking = null;
    this.catalog = [];
    this.standbyStatus = null;
    this.usedConfiguredClient = false;
    this.modelRefresh = null;
  }

  async start(command) {
    if (this.closed) throw notStartedError();
    if (this.parking) await this.parking;
    if (this.current) return this.ready;
    this.started = true;
    this.standbyStatus = null;
    this.desiredCommand = command;
    const entry = this.createCandidate(command, this.createClient(command));
    this.current = entry;
    this.ready = entry.ready;
    this.attach(entry);
    try {
      await entry.ready;
      entry.initialized = true;
      this.catalog = structuredClone(entry.runtime.models);
      this.standbyStatus = null;
      this.scheduleIdle();
    } catch (error) {
      await entry.runtime.close().catch(() => {});
      throw error;
    }
    if (!this.closed && this.desiredCommand !== command) {
      void this.reload(this.desiredCommand).catch((error) => this.logReloadFailure(error));
    }
    return entry.ready;
  }

  async reload(command) {
    this.desiredCommand = command;
    if (this.parking) await this.parking;
    if (!this.started || this.closed) return;
    if (!this.current) {
      await this.start(command);
      this.onReload?.({ command, models: this.listModels() });
      this.emit("reloaded", { command });
      return command;
    }
    clearTimeout(this.idleTimer);
    if (this.reloadPromise) return this.reloadPromise;
    let succeeded = false;
    this.reloadPromise = this.processReload().then((result) => {
      succeeded = true;
      return result;
    }).finally(() => {
      this.reloadPromise = null;
      this.scheduleIdle();
      if (succeeded && !this.closed && this.desiredCommand !== this.current?.command) {
        void this.reload(this.desiredCommand).catch((error) => this.logReloadFailure(error));
      }
    });
    return this.reloadPromise;
  }

  async processReload() {
    const previous = this.current;
    if (!previous) return;
    if (!previous.runtime.isReloadSafe()) {
      await waitForRuntimeChange(previous.runtime, () => previous.runtime.isReloadSafe());
      if (this.closed || this.desiredCommand === previous.command) return;
    }
    const command = this.desiredCommand;
    if (command === previous.command) return;
    const candidate = await this.startCandidate(command, this.createClient(command));
    try {
      candidate.runtime.adoptStateFrom(previous.runtime);
      candidate.retained = previous.retained;
      this.detach(previous);
      this.current = candidate;
      this.ready = candidate.ready;
      this.attach(candidate);
      await previous.runtime.close();
      this.onReload?.({ command, models: candidate.runtime.models });
      this.emit("reloaded", { command });
      return command;
    } catch (error) {
      await candidate.runtime.close().catch(() => {});
      throw error;
    }
  }

  async startCandidate(command, client) {
    const entry = this.createCandidate(command, client);
    try {
      await entry.ready;
      entry.initialized = true;
      return entry;
    } catch (error) {
      await entry.runtime.close().catch(() => {});
      throw error;
    }
  }

  createCandidate(command, client) {
    const runtime = new CodexSessionRuntime({ client, cwd: this.cwd });
    const ready = runtime.initialize();
    return { command, client, runtime, ready, users: 0, retained: false, initialized: false };
  }

  createClient(command) {
    if (this.config.client && !this.usedConfiguredClient) {
      this.usedConfiguredClient = true;
      return this.config.client;
    }
    if (typeof this.config.clientFactory === "function") {
      return this.config.clientFactory(command);
    }
    return createAppServerClient({ ...this.config, command });
  }

  attach(entry) {
    const changed = () => this.scheduleIdle();
    const forward = (event) => (...args) => this.emit(event, ...args);
    entry.forwarders = [
      [entry.runtime, "change", changed],
      [entry.runtime, "activity", forward("activity")],
      [entry.runtime, "request", forward("request")],
      [entry.runtime, "change", forward("change")],
      [entry.runtime, "connectionStatus", forward("connectionStatus")],
      [entry.client, "notification", forward("notification")],
    ];
    for (const [emitter, event, listener] of entry.forwarders) emitter.on(event, listener);
  }

  detach(entry) {
    for (const [emitter, event, listener] of entry.forwarders ?? []) emitter.off(event, listener);
    entry.forwarders = [];
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.idleTimer);
    if (this.parking) await this.parking;
    if (this.current) {
      this.current.runtime.emit("change");
      this.detach(this.current);
      await this.current.runtime.close();
    }
  }

  logReloadFailure(error) {
    this.current?.runtime.addDiagnostic?.(
      `Codex runtime reload failed: ${error?.message ?? error}`,
    );
    this.logger.error?.(`Relay Codex runtime reload failed: ${error?.stack ?? error}`);
    this.emit("change");
  }

  // Catalog discovery stays eager; browsing it never wakes a parked child.
  whenReady() { return this.ready ?? Promise.reject(notStartedError()); }
  status() { return this.standbyStatus ?? this.current?.runtime.status() ?? initialUnavailableStatus(); }
  listModels() { return structuredClone(this.current?.runtime.models ?? this.catalog); }

  /** Share one metadata refresh; invoke owns wake-up and protects against idle teardown. */
  refreshModels() {
    if (this.modelRefresh) return this.modelRefresh;
    const operation = this.invoke("refreshModels", []).then(() => {
      this.catalog = this.listModels();
      return this.listModels();
    }).catch(error => {
      this.logger.warn?.(`Codex model refresh failed; keeping the last catalog: ${error?.message ?? error}`);
      return this.listModels();
    }).finally(() => {
      if (this.modelRefresh === operation) this.modelRefresh = null;
    });
    this.modelRefresh = operation;
    return operation;
  }

  scheduleIdle() {
    clearTimeout(this.idleTimer);
    const entry = this.current;
    // A supplied single-use client has no replacement factory. Native Threads and
    // opaque terminal calls retain their process; their state cannot be inferred
    // from a completed RPC or an idle Turn.
    if (this.closed || this.parking || this.reloadPromise || !entry?.initialized
      || entry.users || entry.retained || this.idleTimeoutMs <= 0
      || (this.config.client && !this.config.clientFactory)
      || entry.client.pending?.size || entry.runtime.status().state !== "connected" || !entry.runtime.isReloadSafe()) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.current !== entry || this.closed || this.reloadPromise || entry.users
        || entry.retained || entry.client.pending?.size || entry.runtime.status().state !== "connected" || !entry.runtime.isReloadSafe()) return;
      // The gate closes synchronously. New operations await the old child's full
      // shutdown before sharing exactly one replacement initialization.
      this.parking = this.park(entry).finally(() => { this.parking = null; });
      void this.parking.catch(error => this.logReloadFailure(error));
    }, this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  async park(entry) {
    await entry.runtime.close();
    this.catalog = structuredClone(entry.runtime.models);
    this.standbyStatus = {
      ...entry.runtime.status(), state: "standby", code: "CODEX_APP_SERVER_STANDBY",
      message: "Codex is ready and will start when needed.", action: null, changedAt: Date.now(),
    };
    this.detach(entry);
    this.current = null;
    this.emit("connectionStatus", this.standbyStatus);
    this.emit("change");
  }

  async invoke(method, args, { client = false, retain = false } = {}) {
    clearTimeout(this.idleTimer);
    if (this.parking) await this.parking;
    if (this.closed) throw notStartedError();
    if (!this.current) await this.start(this.desiredCommand);
    if (this.closed) throw notStartedError();
    const entry = this.current;
    entry.users++;
    // Mark before sending: an unknown response must never authorize teardown.
    if (retain) entry.retained = true;
    try {
      await entry.ready;
      return await (client ? entry.client : entry.runtime)[method](...args);
    } finally {
      entry.users--;
      this.scheduleIdle();
    }
  }
  async listSkills(cwd) {
    const result = await this.request("skills/list", { cwds: [cwd], forceReload: true });
    return result.data.flatMap(entry => entry.skills).filter(skill => skill.enabled)
      .map(({ name, description, path }) => ({ name, description, path }));
  }
  hasSession(sessionId) { return this.current?.runtime.sessions.has(sessionId) ?? false; }
  getSession(...args) { return this.current?.runtime.getSession(...args) ?? null; }
  patchSession(sessionId, patch) {
    const session = this.current?.runtime.sessions.get(sessionId);
    if (session) Object.assign(session, structuredClone(patch));
    return Boolean(session);
  }
  listWorkspaceThreads(...args) { return this.invoke("listWorkspaceThreads", args); }
  readThread(...args) { return this.invoke("readThread", args); }
  createSession(...args) { return this.invoke("createSession", args, { retain: true }); }
  forkSession(...args) { return this.invoke("forkSession", args, { retain: true }); }
  resumeSession(...args) { return this.invoke("resumeSession", args, { retain: true }); }
  applyTrustedPolicy(...args) { return this.invoke("applyTrustedPolicy", args, { retain: true }); }
  sendMessage(...args) { return this.invoke("sendMessage", args, { retain: true }); }
  interruptTurn(...args) { return this.invoke("interruptTurn", args, { retain: true }); }
  releaseSession(...args) { return this.invoke("releaseSession", args, { retain: true }); }
  resolveRequest(...args) { return this.current.runtime.resolveRequest(...args); }
  respondDynamicTool(...args) { return this.current.runtime.respondDynamicTool(...args); }
  rejectRequest(...args) { return this.current.runtime.rejectRequest(...args); }
  request(...args) { return this.invoke("request", args, { client: true }); }
  terminalRequest(...args) { return this.invoke("request", args, { client: true, retain: true }); }
  subscribeActivity(listener) { return subscribe(this, "activity", listener); }
  subscribeRequest(listener) { return subscribe(this, "request", listener); }
  subscribeStatus(listener) { return subscribe(this, "connectionStatus", listener); }
  subscribeNotification(listener) { return subscribe(this, "notification", listener); }
}

function createAppServerClient(config) {
  try {
    return new CodexAppServerClient({
      command: config.command,
      args: config.args ?? RELAY_CODEX_APP_SERVER_ARGS,
      requestTimeoutMs: positiveInteger(config.requestTimeoutMs, 60_000),
    });
  } catch (error) {
    return new FailedCodexClient(error);
  }
}

class FailedCodexClient extends EventEmitter {
  constructor(error) {
    super();
    this.error = error;
    this.process = null;
  }

  async start() { throw this.error; }
  async request() { throw this.error; }
  respond() { throw this.error; }
  respondError() {}
  async close() {}
}

function executionCapability(runtime) {
  return Object.freeze({
    whenReady: () => runtime.whenReady(),
    status: () => runtime.status(),
    subscribeStatus: (listener) => runtime.subscribeStatus(listener),
    listModels: () => runtime.listModels(),
    refreshModels: () => runtime.refreshModels(),
    listSkills: cwd => runtime.listSkills(cwd),
    hasSession: (sessionId) => runtime.hasSession(sessionId),
    getSession: (sessionId) => runtime.getSession(sessionId),
    patchSession: (sessionId, patch) => runtime.patchSession(sessionId, patch),
    async listWorkspaceThreads(...args) {
      await runtime.whenReady();
      return runtime.listWorkspaceThreads(...args);
    },
    async readThread(...args) {
      await runtime.whenReady();
      return runtime.readThread(...args);
    },
    createSession: runtime.createSession.bind(runtime),
    forkSession: runtime.forkSession.bind(runtime),
    resumeSession: runtime.resumeSession.bind(runtime),
    applyTrustedPolicy: runtime.applyTrustedPolicy.bind(runtime),
    sendMessage: runtime.sendMessage.bind(runtime),
    interruptTurn: runtime.interruptTurn.bind(runtime),
    releaseSession: runtime.releaseSession.bind(runtime),
    resolveRequest: runtime.resolveRequest.bind(runtime),
    respondDynamicTool: runtime.respondDynamicTool.bind(runtime),
    rejectRequest: runtime.rejectRequest.bind(runtime),
    subscribeActivity: (listener) => runtime.subscribeActivity(listener),
    subscribeRequest: (listener) => runtime.subscribeRequest(listener),
  });
}

function terminalCapability(client) {
  return Object.freeze({
    whenReady: () => client.whenReady(),
    request: client.terminalRequest.bind(client),
    subscribeNotification: listener => client.subscribeNotification(listener),
  });
}

function waitForRuntimeChange(runtime, predicate) {
  return new Promise((resolve) => {
    const check = () => {
      if (!predicate()) return;
      runtime.off("change", check);
      resolve();
    };
    runtime.on("change", check);
    check();
  });
}

function notStartedError() {
  const error = new Error("Codex runtime has not started");
  error.code = "CODEX_RUNTIME_NOT_STARTED";
  return error;
}

function initialUnavailableStatus() {
  return { state: "unavailable", code: "CODEX_RUNTIME_NOT_STARTED", message: "Codex runtime has not started." };
}

function subscribe(emitter, event, listener) {
  emitter.on(event, listener);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    emitter.off(event, listener);
  };
}

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
