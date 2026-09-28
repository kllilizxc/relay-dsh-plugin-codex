import type { MarkdownFileMentions } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CodexProcessSegment } from './codex-process.ts'

// Synthetic activity tools have no native mutation presenter. Use their exact
// structured change records, never infer files from prose or shell commands.
export function codexProducedFileMentions(
  segments: readonly CodexProcessSegment[],
  openFile: (path: string) => void,
  native: MarkdownFileMentions | undefined,
): MarkdownFileMentions | undefined {
  const paths = new Set<string>()
  for (const { activity } of segments) {
    if (activity?.type !== 'fileChange' || activity.status !== 'completed' || !activity.input) continue
    let changes: unknown
    try { changes = JSON.parse(activity.input) } catch { continue }
    if (!Array.isArray(changes)) continue
    for (const change of changes) {
      if (!change || typeof change !== 'object' || typeof change.path !== 'string'
        || !change.path.trim() || /[\0\r\n]/.test(change.path)) continue
      const kind = change.kind?.type ?? change.kind ?? change.action
      if (kind === 'delete') paths.delete(change.path)
      else if (['add', 'update', 'create', 'modify'].includes(kind)) {
        const moved = change.kind?.move_path
        if (moved != null) {
          paths.delete(change.path)
          if (typeof moved === 'string' && moved.trim() && !/[\0\r\n]/.test(moved)) paths.add(moved)
        } else paths.add(change.path)
      }
    }
  }
  if (paths.size === 0) return native
  return {
    resolve(value) {
      const existing = native?.resolve(value)
      if (existing) return existing
      const matches = [...paths].filter(path => path === value || path.split(/[\\/]/).at(-1) === value)
      const path = paths.has(value) ? value : matches.length === 1 ? matches[0] : undefined
      return path === undefined ? undefined : { open: () => { openFile(path) }, title: path, label: `Open ${path}` }
    },
  }
}
