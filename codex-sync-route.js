import { CODEX_SYNC_PATH } from "./codex-sync-contract.mjs";
import {
  authorized,
  ImportRouteError,
  readJson,
  requiredString,
  writeJson,
} from "./codex-import-route.js";

export { CODEX_SYNC_PATH } from "./codex-sync-contract.mjs";

export function registerCodexSyncRoute(ctx, options) {
  return ctx.webServer.register({
    kind: "exact",
    path: CODEX_SYNC_PATH,
    handler: createCodexSyncHandler({
      token: process.env.RELAY_CODEX_IMPORT_TOKEN,
      ...options,
    }),
  });
}

export function createCodexSyncHandler({ synchronizer, token, maxBodyBytes = 4_096 }) {
  if (!synchronizer?.syncSession) throw new Error("Codex sync route requires a history synchronizer");
  return async (request, response) => {
    if (request.method !== "POST") {
      writeJson(response, 405, { error: "method_not_allowed" }, { allow: "POST" });
      return;
    }
    if (!authorized(request, token)) {
      writeJson(response, 403, { error: "forbidden" });
      return;
    }
    try {
      const body = await readJson(request, maxBodyBytes);
      const sessionId = requiredString(body?.sessionId, "sessionId");
      writeJson(response, 200, await synchronizer.syncSession(sessionId));
    } catch (error) {
      const status = error instanceof ImportRouteError ? error.statusCode : 500;
      writeJson(response, status, {
        error: status === 413 ? "payload_too_large" : status < 500 ? "invalid_request" : "sync_failed",
        message: error?.message ?? String(error),
      });
    }
  };
}
