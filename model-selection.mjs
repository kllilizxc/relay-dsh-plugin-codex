import { sessionPreset, modelDirectory } from "./dsh-client-compat.mjs";
const DEFAULT_RETRY_DELAYS_MS = Object.freeze([50, 250, 1_000]);

export function installModelSelection(
  ctx,
  preset,
  provider,
  otherProvider,
  { retryDelaysMs = DEFAULT_RETRY_DELAYS_MS } = {},
) {
  const operations = new Map();
  const desired = new Map();
  const pending = new Set();
  const retryTimers = new Map();
  let stopped = false;
  let nextGeneration = 1;

  const clearRetry = (id) => {
    const timer = retryTimers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    retryTimers.delete(id);
  };

  const currentTarget = (id, target) => {
    const list = ctx.sessions.list.getSnapshot();
    const latest = list.byId[id];
    return !stopped
      && (list.byId[id]?.retainedBy?.mainView ?? 0) > 0
      && latest?.blank === true
      && desired.get(id)?.generation === target.generation
      && sessionPreset(latest) === target.selectedPreset;
  };

  const retry = (id, target) => {
    if (!currentTarget(id, target) || retryTimers.has(id)) return;
    const delay = retryDelaysMs[target.retry];
    if (delay === undefined) return;
    target.retry += 1;
    retryTimers.set(id, setTimeout(() => {
      retryTimers.delete(id);
      if (currentTarget(id, target)) void reconcile(id, target);
    }, delay));
  };

  const reconcile = async (id, target) => {
    if (!currentTarget(id, target) || operations.has(id)) return;
    operations.set(id, target.generation);
    try {
      const directory = modelDirectory(ctx, id);
      const models = await directory.load();
      if (!currentTarget(id, target)) return;
      if (!models.current) {
        retry(id, target);
        return;
      }
      const currentProvider = models.current.provider;
      const group = target.selectedPreset === preset
        ? models.groups.find(candidate => candidate.id === provider)
        : currentProvider === provider
          ? models.groups.find(candidate => candidate.id !== provider && candidate.id !== otherProvider)
          : null;
      if (target.selectedPreset === preset && currentProvider === provider) return;
      if (!group || group.models.length === 0) {
        retry(id, target);
        return;
      }
      const model = group.models.find(candidate => candidate.id === models.current.model) ?? group.models[0];
      const selected = await directory.select({
        provider: group.id,
        model: model.id,
        ...(model.reasoning?.defaultEffort
          ? { reasoningEffort: model.reasoning.defaultEffort }
          : {}),
      });
      if (!currentTarget(id, target)) return;
      if (selected?.ok === false) {
        retry(id, target);
        return;
      }
      clearRetry(id);
    } catch {
      retry(id, target);
    } finally {
      operations.delete(id);
      if (pending.delete(id)) sync();
    }
  };

  const sync = () => {
    if (stopped) return;
    const list = ctx.sessions.list.getSnapshot();
    const id = Object.values(list.byId).find(session => (session.retainedBy?.mainView ?? 0) > 0)?.id;
    if (id === undefined || list.byId[id]?.blank !== true) return;
    const selectedPreset = sessionPreset(list.byId[id]);
    if (selectedPreset !== preset && selectedPreset === otherProvider) return;

    const desiredKey = `${selectedPreset ?? "standard"}`;
    let target = desired.get(id);
    if (!target || target.key !== desiredKey) {
      clearRetry(id);
      target = { key: desiredKey, selectedPreset, generation: nextGeneration++, retry: 0 };
      desired.set(id, target);
    }
    if (operations.has(id)) {
      pending.add(id);
      return;
    }
    void reconcile(id, target);
  };

  const off = ctx.sessions.list.subscribe(sync);
  sync();
  return () => {
    stopped = true;
    off();
    for (const id of retryTimers.keys()) clearRetry(id);
  };
}
