import { describe, expect, it, vi } from 'vitest'
import { codexProducedFileMentions } from '../src/client/process-files.ts'
import type { CodexProcessSegment } from '../src/client/codex-process.ts'

const change = (input: unknown, status = 'completed', type = 'fileChange') => ({
  kind: 'activity', key: 'edit', seq: 1, step: 1,
  activity: { type, status, title: 'Edited a file', input: JSON.stringify(input) },
}) as CodexProcessSegment

describe('Codex produced-file mentions', () => {
  it('opens exact successful edit paths and unique basenames through DSH', () => {
    const open = vi.fn()
    const mentions = codexProducedFileMentions([change([
      { path: '/workspace/delivery.txt', kind: { type: 'update' } },
      { path: '/workspace/new.txt', kind: { type: 'add' } },
    ])], open, undefined)!
    mentions.resolve('delivery.txt')!.open()
    mentions.resolve('/workspace/new.txt')!.open()
    expect(open.mock.calls).toEqual([['/workspace/delivery.txt'], ['/workspace/new.txt']])
    expect(mentions.resolve('unrelated.txt')).toBeUndefined()
  })

  it('rejects ambiguous basenames while preserving exact paths', () => {
    const mentions = codexProducedFileMentions([change([
      { path: '/a/file.txt', kind: { type: 'update' } },
      { path: '/b/file.txt', kind: { type: 'update' } },
    ])], vi.fn(), undefined)!
    expect(mentions.resolve('file.txt')).toBeUndefined()
    expect(mentions.resolve('/b/file.txt')?.title).toBe('/b/file.txt')
  })

  it('does not claim running, failed, read, shell, unknown or malformed changes', () => {
    for (const segment of [
      change([{ path: '/a/file.txt', kind: { type: 'update' } }], 'running'),
      change([{ path: '/a/file.txt', kind: { type: 'update' } }], 'error'),
      change([{ path: '/a/file.txt', kind: { type: 'update' } }], 'completed', 'commandExecution'),
      change([{ path: '/a/file.txt', kind: { type: 'future' } }]),
      change([{ path: '/a/file.txt\n', kind: { type: 'add' } }]), change({ path: '/a/file.txt' }),
      change('truncated'),
    ]) expect(codexProducedFileMentions([segment], vi.fn(), undefined)).toBeUndefined()
  })

  it('deduplicates edits, removes successful deletes, and ignores failed deletes', () => {
    const edit = change([{ path: '/a/file.txt', kind: { type: 'update' } }])
    const deletion = [{ path: '/a/file.txt', kind: { type: 'delete' } }]
    expect(codexProducedFileMentions([edit, edit], vi.fn(), undefined)?.resolve('file.txt')).toBeDefined()
    expect(codexProducedFileMentions([edit, change(deletion)], vi.fn(), undefined)).toBeUndefined()
    expect(codexProducedFileMentions([edit, change(deletion, 'error')], vi.fn(), undefined)?.resolve('file.txt')).toBeDefined()
  })

  it('preserves native resolver identity without edits and native resolution priority', () => {
    const entry = { open: vi.fn(), label: 'Native file', title: '/native/file.txt' }
    const native = { resolve: vi.fn(() => entry) }
    expect(codexProducedFileMentions([], vi.fn(), native)).toBe(native)
    const composed = codexProducedFileMentions([change([{ path: '/a/file.txt', action: 'modify' }])], vi.fn(), native)!
    expect(composed.resolve('file.txt')).toBe(entry)
  })

  it('opens the destination of a moved file, never the obsolete source', () => {
    const mentions = codexProducedFileMentions([
      change([{ path: '/a/old.txt', kind: { type: 'add' } }]),
      change([{ path: '/a/old.txt', kind: { type: 'update', move_path: '/a/new.txt' } }]),
    ], vi.fn(), undefined)!
    expect(mentions.resolve('old.txt')).toBeUndefined()
    expect(mentions.resolve('new.txt')?.title).toBe('/a/new.txt')
    expect(codexProducedFileMentions([change([{ path: '/a/old.txt', kind: { type: 'update', move_path: 42 } }])], vi.fn(), undefined)).toBeUndefined()
  })
})
