export interface SessionSelectionObservable {
  getSnapshot(): { sessionId?: string } | undefined
  subscribe(listener: () => void): () => void
}

export interface CodexSyncResult {
  status: 'synced' | 'not-imported'
  projectedMessages: number
  projectedTurns: number
  skippedItems: number
  modelSelectionChanged?: boolean
  rebuiltSessionId?: string
  rebuiltFromSessionId?: string
  rebuildReason?: string
}

export function observeSessionOpen(
  currentProvideInfo: SessionSelectionObservable,
  syncSession: (
    sessionId: string,
    isLatestSelection: () => boolean,
  ) => Promise<unknown> | unknown,
  onError?: (error: unknown) => void,
  readFallbackSessionId?: () => string | null,
): () => void

export function syncOpenedCodexSession(
  sessionId: string,
  fetchImpl?: typeof fetch,
): Promise<CodexSyncResult>

export function syncOpenedCodexSessionAndRefresh(
  sessionId: string,
  refreshSessions: () => Promise<unknown> | unknown,
  fetchImpl?: typeof fetch,
  openSession?: ((sessionId: string) => void) | null,
  writeCurrentSessionId?: (sessionId: string) => void,
  isLatestSelection?: () => boolean,
): Promise<CodexSyncResult>

export function readPersistedDshCurrentSessionId(storage?: Storage): string | null

export function writePersistedDshCurrentSessionId(sessionId: string, storage?: Storage): void
