import type { CodexActivityEventData } from './src/client/codex-activity.ts'
export const CODEX_ACTIVITY_TOOL: 'relay_codex_activity'
export function readActivityPayload(value: unknown): CodexActivityEventData | null
