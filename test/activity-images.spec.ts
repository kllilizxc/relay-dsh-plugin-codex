import { describe, expect, it } from 'vitest'
import { createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { codexActivityImages, initialCodexProcessState, reduceCodexProcess } from '../src/client/codex-process.ts'
import type { CodexProcessSegment } from '../src/client/codex-process.ts'

const attachment = { attachmentId: 'sha256:fixture', mediaType: 'image/png', bytes: 42, width: 320, height: 200, name: 'capture.png' } as const
const payload = { version: 1, threadId: 'thread', turnId: 'turn', itemId: 'view', phase: 'completed',
  activity: { type: 'imageView', status: 'completed', title: 'Viewed an image' } } as const

describe('activity image projection', () => {
  it('preserves a real native tool result attachment in the grouped activity', () => {
    let state = reduceCodexProcess(initialCodexProcessState(1, 0), {
      type: 'tool/call', seq: 0, time: 1,
      data: { turn: 1, step: 1, callId: 'call', name: 'relay_codex_activity', arguments: JSON.stringify(payload) },
    } as never)
    state = reduceCodexProcess(state, { type: 'tool/result', seq: 1, time: 2, surfaceOp: 'append', data: {
      turn: 1, step: 1, meta: { codexActivity: payload },
      message: createToolResultMessage({ callId: 'call' as never, content: [{ type: 'image', attachment }], isError: false }),
    } } as never)
    expect(state.segments[0].activity?.images).toEqual([attachment])
    expect(codexActivityImages(state.segments[0], state.segments)).toEqual([attachment])
  })

  it('does not borrow an unrelated or unmapped historical image', () => {
    const segment = { key: 'activity', seq: 1, step: 1, kind: 'activity', itemId: 'view' } as const
    const images: CodexProcessSegment[] = [{ key: 'image', seq: 2, step: 1, kind: 'image', itemId: 'other', attachment }]
    expect(codexActivityImages(segment, images)).toEqual([])
    expect(codexActivityImages(segment, [{ ...images[0], itemId: undefined }])).toEqual([])
    expect(codexActivityImages(segment, [{ ...images[0], itemId: 'view' }])).toEqual([attachment])
  })
})
