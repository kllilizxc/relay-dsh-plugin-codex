// Public interface adapters shared by both supported DSH generations.
export function sessionPreset(session) {
  if (session?.projectionValues && Object.hasOwn(session.projectionValues, 'agentPreset')) {
    return session.projectionValues.agentPreset;
  }
  return session?.agentPreset;
}

const service = (ctx, name) => typeof ctx.get === 'function' ? ctx.get(name) : ctx[name];
export function modelDirectory(ctx, sessionId) {
  const directories = service(ctx, 'modelDirectories');
  if (directories) return directories.directoryFor(sessionId);
  const sessions = service(ctx, 'connection')?.api?.sessions;
  if (!sessions) throw new Error('DSH model selection interface is unavailable');
  return {
    async load() {
      const response = await sessions.models({ sessionId });
      if (!response.result.ok) throw new Error('DSH model discovery failed');
      return response.result.value;
    },
    async select(selection) {
      const response = await sessions.selectModel({ sessionId, ...selection });
      if (!response.result.ok) throw new Error('DSH model selection failed');
    },
  };
}

// The controller catalog no longer owns navigation. Main-view retention is the
// public selection fact; histories and sidebars must not become the current view.
export function currentSessionId(state) {
  if (typeof state?.current === 'string') return state.current;
  return Object.values(state?.byId ?? {}).find(row => (row.retainedBy?.mainView ?? 0) > 0)?.id;
}
