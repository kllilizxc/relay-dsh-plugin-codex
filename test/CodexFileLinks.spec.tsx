// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ProcessBody } from '../src/client/CodexProcessView.tsx'
import { initialCodexProcessState } from '../src/client/codex-process.ts'

afterEach(cleanup)
// Skipped: turning an absolute-path markdown link into an open button requires
// the DSH frontend's MarkdownText path links capability, which public DSH
// 0.2.1-rc.2 does not ship; the link degrades to a plain anchor there.
it.skip('opens an artifact from the native Codex final answer', () => {
  const openFile = vi.fn()
  const state = { ...initialCodexProcessState(1, 0), status: 'completed' as const, endedAt: 1000,
    segments: [{ key: 'answer', seq: 1, step: 0, kind: 'text' as const, phase: 'final_answer' as const,
      settled: true, text: '[打开 HANDOFF.md](/tmp/handoff/HANDOFF.md)' }] }
  render(<ProcessBody state={state} renderFactorySlot={() => null} loadImage={() => undefined} openFile={openFile} />)
  fireEvent.click(screen.getByRole('button', { name: '打开 HANDOFF.md' }))
  expect(openFile).toHaveBeenCalledWith('/tmp/handoff/HANDOFF.md', undefined)
})
