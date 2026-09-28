/** Read native catalogs using the persisted session's workspace, without starting a turn. */
export function registerNativeSkillsRoute(ctx, { preset, listSkills }) {
  return ctx.webServer.register({
    kind: "exact",
    path: `/api/relay/${preset.replace("relay-", "")}/skills`,
    handler: createNativeSkillsHandler({
      preset, listSkills,
      async readSession(id) {
        const observation = await ctx.get("sessionQuery").observeSession(id);
        try {
          return { cwd: observation.header.cwd, preset: observation.projections.values.agentPreset };
        } finally { observation[Symbol.dispose](); }
      },
    }),
  });
}

export function createNativeSkillsHandler({ preset, listSkills, readSession }) {
  return async (request, response) => {
    const send = (status, body) => {
      response.writeHead(status, {
        "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
        ...(status === 405 ? { allow: "GET" } : {}),
      });
      response.end(JSON.stringify(body));
    };
    if (request.method !== "GET") return send(405, { error: "method_not_allowed" });
    const id = new URL(request.url, "http://relay.invalid").searchParams.get("sessionId");
    if (!id) return send(400, { error: "sessionId_required" });
    try {
      const session = await readSession(id);
      if (session.preset !== preset) return send(200, { skills: [] });
      if (!session.cwd) throw new Error("Session workspace is unavailable");
      send(200, { skills: await listSkills(id, session.cwd) });
    } catch (error) {
      send(503, { error: String(error?.message ?? error) });
    }
  };
}
