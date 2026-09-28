import { CODEX_SYNC_PATH } from "../../codex-sync-contract.mjs";

const DSH_CURRENT_SESSION_STORAGE_KEY = "dsh.sessions.current";

export function observeSessionOpen(
  currentProvideInfo,
  syncSession,
  onError = console.warn,
  readFallbackSessionId = readPersistedDshCurrentSessionId,
) {
  let selectedSessionId = null;
  let selectionRevision = 0;
  let latestOperation = null;
  const runSync = async (sessionId, revision) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await syncSession(sessionId, () => (
          selectionRevision === revision && selectedSessionId === sessionId
        ));
        return;
      } catch (error) {
        const stillSelected = selectionRevision === revision && selectedSessionId === sessionId;
        if (!stillSelected || attempt === 1) {
          if (stillSelected) selectedSessionId = null;
          onError(error);
          return;
        }
      }
    }
  };
  const reconcile = () => {
    const sessionId = currentProvideInfo.getSnapshot()?.sessionId ?? readFallbackSessionId() ?? null;
    // Rebuilding archives the old Session before the HTTP response can name
    // its replacement. Preserve the in-flight selection across that masked gap.
    if (sessionId === null && latestOperation !== null) return;
    if (sessionId === selectedSessionId) return;
    selectedSessionId = sessionId;
    selectionRevision += 1;
    if (sessionId === null) return;
    const revision = selectionRevision;
    const operation = runSync(String(sessionId), revision);
    latestOperation = operation;
    void operation.finally(() => {
      if (latestOperation === operation) latestOperation = null;
    });
  };
  const unsubscribe = currentProvideInfo.subscribe(reconcile);
  reconcile();
  return unsubscribe;
}

export async function syncOpenedCodexSession(sessionId, fetchImpl = fetch) {
  const response = await fetchImpl(CODEX_SYNC_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.message ?? `Codex history sync failed with HTTP ${response.status}`);
  }
  if (body?.status !== "synced" && body?.status !== "not-imported") {
    throw new Error("Codex history sync returned an invalid response");
  }
  return body;
}

export async function syncOpenedCodexSessionAndRefresh(
  sessionId,
  refreshSessions,
  fetchImpl = fetch,
  openSession = null,
  writeCurrentSessionId = writePersistedDshCurrentSessionId,
  isLatestSelection = () => true,
) {
  const result = await syncOpenedCodexSession(sessionId, fetchImpl);
  const rebuiltSessionId = typeof result.rebuiltSessionId === "string" && result.rebuiltSessionId.trim()
    ? result.rebuiltSessionId
    : null;
  if (result.status === "synced" && (
    result.projectedMessages > 0
    || rebuiltSessionId !== null
  )) {
    await refreshSessions();
  }
  if (rebuiltSessionId !== null && isLatestSelection()) {
    writeCurrentSessionId(rebuiltSessionId);
    try {
      await openSession?.(rebuiltSessionId);
    } catch (error) {
      if (!isLatestSelection()) return result;
      await refreshSessions();
      if (!isLatestSelection()) return result;
      await openSession?.(rebuiltSessionId);
    }
  }
  return result;
}

export function readPersistedDshCurrentSessionId(storage = browserStorage()) {
  try {
    const raw = storage?.getItem?.(DSH_CURRENT_SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return typeof parsed?.sessionId === "string" && parsed.sessionId.trim()
      ? parsed.sessionId
      : null;
  } catch {
    return null;
  }
}

export function writePersistedDshCurrentSessionId(sessionId, storage = browserStorage()) {
  const candidate = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!candidate) return;
  try {
    storage?.setItem?.(DSH_CURRENT_SESSION_STORAGE_KEY, JSON.stringify({ sessionId: candidate }));
  } catch {
    // DSH treats localStorage persistence as best-effort; match that contract.
  }
}

function browserStorage() {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
