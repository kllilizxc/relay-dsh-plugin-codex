export class CodexHistorySynchronizer {
  constructor({ adapter, target }) {
    if (!adapter?.bindingForSession || !adapter?.ownedTurnIdsForSession) {
      throw new Error("Codex history sync requires the binding adapter");
    }
    if (!target?.sync) throw new Error("Codex history sync requires a DSH sync target");
    this.adapter = adapter;
    this.target = target;
    this.pendingSessions = new Map();
  }

  async syncSession(sessionId) {
    const key = String(sessionId ?? "").trim();
    if (!key) throw new Error("DSH sessionId is required for Codex history sync");
    const binding = this.adapter.bindingForSession(key);
    if (binding?.bindingMode !== "imported" || binding.importState !== "committed") {
      return { status: "not-imported", projectedMessages: 0, projectedTurns: 0, skippedItems: 0 };
    }
    const pending = this.pendingSessions.get(key);
    if (pending) return pending;
    const operation = this.target.sync(binding, this.adapter.ownedTurnIdsForSession(key))
      .then(result => ({ status: "synced", ...result }))
      .finally(() => { this.pendingSessions.delete(key); });
    this.pendingSessions.set(key, operation);
    return operation;
  }
}
