import type { ChatConversationViewNode, ToolCallBlock } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionEventLike, SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { describe, expect, it, vi } from 'vitest'
import type {
  ConversationLocation, ConversationMatch, ConversationNodeContext,
  ConversationNodeDefinition, ConversationTimelineSnapshot, ConversationViewDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ConversationNodeAssembler } from '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation/assembler.ts'
import type { ToolCallId, MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { ContentBlock, ImageBlock, StreamChunk } from '@deepseek-ai/dsh-llm/types'
import type { SessionEvent, SessionEventMap, TurnEndReason } from '@deepseek-ai/dsh-session/types'
import { codexActivityDefinition, type CodexActivityEventData } from '../src/client/codex-activity.ts'
import {
  canTakeOverCodexProcess, codexProcessAnswerSegments, codexProcessDefinition as definition, initialCodexProcessState,
  projectCodexProcess, readCodexPresentation, reduceCodexProcess, replayCodexProcess,
  type CodexProcessState,
} from '../src/client/codex-process.ts'


// Load the official implementation through its public contract without adding
// its source-only declaration merges to the plugin's TypeScript program.
const { toolDefinition } = await vi.importActual<{ toolDefinition: ConversationNodeDefinition }>(
  '@deepseek-ai/dsh-client-ui-chat/src/client/conversation-nodes/tool.ts',
)
const { assistantDefinition } = await vi.importActual<{ assistantDefinition: ConversationNodeDefinition }>(
  '@deepseek-ai/dsh-client-ui-chat/src/client/conversation-nodes/assistant.ts',
)

// Native shapes from official DSH 0a15e36e7f82b6ed45af6fa9759f29b40dcd965d.
function event<T extends keyof SessionEventMap>(seq: number, type: T, data: SessionEventMap[T]): SessionEvent<T> {
  return { type, seq, time: seq * 100, data,
    ...type === 'assistant/message' || type === 'tool/result' ? { surfaceOp: 'append' } : {},
  } as SessionEvent<T>
}

const start = (seq = 1, turn = 1) => event(seq, 'turn/start', { turn })
const end = (seq: number, reason: TurnEndReason = { kind: 'completed' }, turn = 1) => event(seq, 'turn/end', { turn, reason })
const chunk = (seq: number, value: StreamChunk, step = 1) => event(seq, 'assistant/chunk', { turn: 1, step, chunk: value })
const text = (seq: number, value: string, index = 0, step = 1) => chunk(seq, { type: 'text-delta', index, text: value }, step)

function payload(itemId = 'item', phase: 'started' | 'completed' = 'started'): CodexActivityEventData {
  return { version: 1, threadId: 'thread', turnId: 'turn', itemId, phase,
    activity: { type: 'commandExecution', title: 'Ran commands', input: '$ pwd',
      status: phase === 'started' ? 'running' : 'completed',
      ...phase === 'completed' ? { output: '/workspace\n', exitCode: '0' } : {},
    } }
}

function call(seq: number, itemId = 'item', step = 1) {
  return event(seq, 'tool/call', { turn: 1, step, callId: `call-${itemId}` as ToolCallId,
    name: 'relay_codex_activity', arguments: JSON.stringify(payload(itemId)),
  })
}

function result(seq: number, itemId = 'item', step = 1, isError = false) {
  const callId = `call-${itemId}` as ToolCallId
  return event(seq, 'tool/result', { turn: 1, step,
    message: { id: `result-${itemId}` as MessageId, role: 'user', source: { kind: 'tool', callId },
      content: [{ type: 'tool-result', toolCallId: callId, isError, content: [{ type: 'text', text: '/workspace\n' }] }],
    },
    meta: JSON.parse(JSON.stringify({ codexActivity: payload(itemId, 'completed') })),
  })
}

function assistant(seq: number, content: ContentBlock[] = [], step = 1, provider = 'relay-codex', replayState?: unknown) {
  return event(seq, 'assistant/message', { turn: 1, step,
    message: { id: `message-${seq}` as MessageId, role: 'assistant', content,
      source: { kind: 'model', provider, model: 'fixture-model', ...replayState ? { replayState } : {} },
    },
  })
}

const presentation = { response: { codexPresentation: { version: 1,
  blocks: [{ index: 0, itemId: 'answer', phase: 'final_answer' }],
} } }
function modernAssistant(seq: number, value: string | ContentBlock[], step = 1) {
  const content: ContentBlock[] = typeof value === 'string' ? [{ type: 'text', text: value }] : value
  return assistant(seq, content, step, 'relay-codex', { response: { codexPresentation: { version: 1,
    blocks: content.map((block, index) => ({ index, itemId: `block-${index}`,
      phase: block.type === 'text' ? index === content.length - 1 ? 'final_answer' : 'commentary' : null,
    })),
  } } })
}

const synthetic = (seq: number, itemId = 'item', step = 1) => assistant(seq, [{
  type: 'tool-call', id: `call-${itemId}` as ToolCallId, name: 'relay_codex_activity', arguments: JSON.stringify(payload(itemId)),
}], step)

function context(events: readonly SessionEvent[], incremental = true, location: ConversationLocation = { kind: 'unresolved' }): ConversationNodeContext<CodexProcessState> {
  const matches: ConversationMatch[] = events.flatMap(event => {
    const match = definition.match(event)
    return match ? [{ event, role: match.role, view: undefined, location }] : []
  })
  let value: ConversationNodeContext<CodexProcessState> = {
    key: 'process-1', kind: definition.kind, id: '1', matches: [], start: undefined,
    state: undefined, current: new Map(),
  }
  for (const match of matches) {
    value = { ...value, matches: [...value.matches, match] }
    if (match.role === 'start') {
      value = { ...value, start: match }
      if (incremental) value = { ...value, state: definition.start(value, match, { previous: () => undefined }) }
    } else if (incremental && value.state) {
      value = { ...value, state: definition.update({ ...value, state: value.state }, match) }
    }
  }
  return value
}

const state = (events: readonly SessionEvent[]) => projectCodexProcess(context(events))!
const node = (events: readonly SessionEvent[]) => definition.buildViewNode!(context(events)) as ChatConversationViewNode | null

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}

describe('Codex process projection', () => {
  it('projects the current DSH assistant/live-chunk stream shape', () => {
    const live = {
      type: 'assistant/live-chunk', seq: 2, time: 200,
      data: {
        attemptId: 'attempt-1', turn: 1, step: 1,
        chunk: { type: 'text-delta', index: 0, text: 'Current stream' },
      },
    } as SessionEventLike
    const projected = reduceCodexProcess(reduceCodexProcess(initialCodexProcessState(1, 100), start()), live)
    expect(projected.segments).toMatchObject([{ kind: 'text', text: 'Current stream', step: 1, index: 0 }])
  })

  it('starts before visibility and anchors once at the first visible event', () => {
    const events = [start(), chunk(2, { type: 'block-start', index: 0, blockType: 'text' })]
    expect(node(events)).toBeNull()
    events.push(text(3, 'Looking now'))
    expect(node(events)).toBeNull() // Streaming alone does not identify the provider.
    const owned = [...events, synthetic(4), call(5)]
    expect(node(owned)).toMatchObject({ anchorSeq: 3, target: 'chat', kind: 'relay-codex-process' })
    expect(node([...owned, result(6), modernAssistant(7, 'Looking now'), end(8)]))
      .toMatchObject({ key: 'process-1', anchorSeq: 3 })
    expect(state(owned)).toMatchObject({ turn: 1, startedAt: 100, owned: true, ownedSteps: [1], status: 'running' })
  })

  it('preserves commentary/tool/commentary order and is identical incrementally and on replay at every prefix', () => {
    const events = [start(), text(2, 'Inspecting.'), synthetic(3), call(4), result(5),
      text(6, 'The result is ready.', 1), assistant(7, [
        { type: 'text', text: 'Inspecting.' }, { type: 'text', text: 'The result is ready.' },
      ]), end(8)]
    for (let size = 1; size <= events.length; size++) {
      const prefix = events.slice(0, size)
      expect(projectCodexProcess(context(prefix))).toEqual(projectCodexProcess(context(prefix, false)))
      expect(definition.buildViewNode!(context(prefix))).toEqual(definition.buildViewNode!(context(prefix, false)))
    }
    expect(state(events).segments.map(({ kind, text, callId, seq }) => ({ kind, text, callId, seq }))).toEqual([
      { kind: 'text', text: 'Inspecting.', seq: 2 },
      { kind: 'activity', callId: 'call-item', seq: 3 },
      { kind: 'text', text: 'The result is ready.', seq: 6 },
    ])
  })

  it('tool-only and empty synthetic messages neither erase nor settle streamed text', () => {
    const events = [start(), text(2, 'Checking '), synthetic(3), call(4), assistant(5), text(6, 'files.')]
    const projected = state(events)
    expect(projected.segments[0]).toMatchObject({ kind: 'text', text: 'Checking files.', settled: false })
    expect(projected.segments.filter(segment => segment.kind === 'activity')).toHaveLength(1)
    expect(projected.status).toBe('running')
  })

  it('settles aggregate text once without duplicating it or moving earlier activity', () => {
    const events = [start(), text(2, 'Hello'), call(3), text(4, 'Answer', 1), result(5),
      assistant(6, [{ type: 'text', text: 'Hello' }, { type: 'text', text: 'Answer!' }]),
      assistant(7, [{ type: 'text', text: 'Hello' }, { type: 'text', text: 'Answer!' }]), end(8)]
    expect(state(events).segments.map(segment => segment.text ?? segment.callId)).toEqual(['Hello', 'call-item', 'Answer!'])
    expect(state(events).segments.map(segment => segment.seq)).toEqual([2, 3, 4])
  })

  it('keys indices by step and deduplicates sparse aggregate indices', () => {
    const events = [start(), text(2, 'Step one', 7), assistant(3, [{ type: 'text', text: 'Step one' }]),
      text(4, 'Step two', 7, 2), text(5, 'Answer', 12, 2), assistant(6, [
        { type: 'text', text: 'Step two' }, { type: 'text', text: 'Answer' },
      ], 2), end(7)]
    expect(state(events).segments.map(segment => segment.key)).toEqual(['block:1:7', 'block:2:7', 'block:2:12'])
    expect(state(events).ownedSteps).toEqual([1, 2])
  })

  it('ignores late deltas, duplicate starts, and duplicate block closes after settlement', () => {
    const events = [start(), text(2, 'A'), chunk(3, { type: 'block-start', index: 0, blockType: 'text' }),
      chunk(4, { type: 'block-end', index: 0, block: { type: 'text', text: 'AB' } }), text(5, 'late'),
      chunk(6, { type: 'block-end', index: 0, block: { type: 'text', text: 'wrong' } }), assistant(7)]
    expect(state(events).segments[0].text).toBe('AB')
    const folded = replayCodexProcess(events)!
    expect(reduceCodexProcess(folded, events[1])).toBe(folded)
  })

  it('publishes only owned turn data and never publishes step data', () => {
    expect(definition.buildLocationData!(context([start(), text(2, 'Unknown')]), 'turn')).toBeNull()
    const ctx = context([start(), text(2, 'Codex'), assistant(3)])
    expect(definition.buildLocationData!(ctx, 'step')).toBeNull()
    expect(definition.buildLocationData!(ctx, 'turn')).toEqual({ kind: 'turn', turn: 1, key: 'relay-codex-process', value: state([start(), text(2, 'Codex'), assistant(3)]) })
  })

  it('never claims a foreign provider, even with similar names or presentation metadata', () => {
    for (const provider of ['deepseek', 'openai', 'relay-codex-other']) {
      const events = [start(), text(2, 'Foreign'), assistant(3, [{ type: 'text', text: 'Foreign' }], 1, provider,
        { response: { codexPresentation: { version: 1, blocks: [{ index: 0, itemId: 'x', phase: 'final_answer' }] } } }), end(4)]
      expect(state(events)).toMatchObject({ owned: false, ownedSteps: [], segments: [] })
      expect(node(events)).toBeNull()
    }
  })

  it('protects foreign and unproven steps inside an owned DSH turn', () => {
    const events = [start(), text(2, 'Foreign first', 0, 1), assistant(3, [{ type: 'text', text: 'Foreign first' }], 1, 'deepseek'),
      text(4, 'Codex', 0, 2), assistant(5, [{ type: 'text', text: 'Codex' }], 2),
      text(6, 'Unknown until settlement', 0, 3)]
    expect(state(events).segments.map(segment => segment.text)).toEqual(['Codex'])
    expect(state(events).ownedSteps).toEqual([2])
    expect(state(events).takeoverSafe).toBe(false)
    expect(state(events).takeoverReasons).toContain('foreign-provider')
    expect(node(events)).toBeNull()
    const closed = [...events, assistant(7, [{ type: 'text', text: 'Foreign last' }], 3, 'deepseek'), end(8)]
    expect(state(closed).segments.map(segment => segment.text)).toEqual(['Codex'])
    expect(state(closed).ownedSteps).toEqual([2])
  })

  it('does not leak turn ownership across turns', () => {
    const owned = state([start(), assistant(2, [{ type: 'text', text: 'Codex' }])])
    expect(reduceCodexProcess(owned, start(3, 2))).toBe(owned)
    expect(replayCodexProcess([start(3, 2), end(4, { kind: 'completed' }, 2)])?.owned).toBe(false)
  })

  it('observes unrelated tools and malformed activity payloads without claiming them', () => {
    for (const args of ['{broken', 'null', '{}', JSON.stringify({ ...payload(), version: 2 }), JSON.stringify({ ...payload(), activity: { title: 'x' } })]) {
      const native = call(2)
      const events = [start(), { ...native, data: { ...native.data, arguments: args } }, end(3)]
      expect(state(events).owned).toBe(false)
      expect(state(events).takeoverReasons).toContain('unsupported-tool')
    }
    const foreign = call(2)
    expect(definition.match({ ...foreign, data: { ...foreign.data, name: 'other_tool' } })).toEqual({ id: '1', role: 'update' })
    expect(definition.match(event(2, 'step/start', { turn: 1, step: 1 }))).toBeNull()
  })

  it('retains call identity, provenance, input, output, and first sequence across duplicate results', () => {
    const events = [start(), call(2), result(3), result(4), call(5), end(6)]
    expect(state(events).segments).toHaveLength(1)
    expect(state(events).segments[0]).toMatchObject({ seq: 2, callId: 'call-item', id: 'item', itemId: 'item',
      messageId: 'result-item', threadId: 'thread', turnId: 'turn', settled: true,
      activity: { status: 'completed', input: '$ pwd', output: '/workspace\n', exitCode: '0',
        provenance: { threadId: 'thread', turnId: 'turn' } },
    })
  })

  it('reconstructs completed-only tools without inventing a call or requiring turn/start', () => {
    const events = [result(10), end(11)]
    expect(context(events).state).toBeUndefined()
    expect(state(events)).toMatchObject({ startedAt: 1000, endedAt: 1100, status: 'completed', owned: true, ownedSteps: [1] })
    expect(state(events).segments[0]).toMatchObject({ seq: 10, callId: 'call-item', activity: { status: 'completed' } })
    expect(state(events).takeoverSafe).toBe(false)
    expect(state(events).takeoverReasons).toContain('orphan-tool-result')
    expect(node(events)).toBeNull()
    expect(state([call(10), result(11), end(12)]).segments).toHaveLength(1)
  })

  it('reconstructs delta-only partial history and uses available location boundaries', () => {
    const events = [text(10, 'Partial'), synthetic(11)]
    const location: ConversationLocation = { kind: 'turn', turn: {
      turn: 1, start: start(1), end: end(12, { kind: 'interrupted' }), status: 'closed', steps: [], data: { get: () => undefined },
    } }
    const ctx = context(events, true, location)
    expect(projectCodexProcess(ctx)).toMatchObject({ startedAt: 100, endedAt: 1200, status: 'error', owned: true })
    expect(projectCodexProcess(ctx)?.segments[0].text).toBe('Partial')
    expect(projectCodexProcess(ctx)?.segments[1].activity?.status).toBe('error')
    expect(definition.buildViewNode!(ctx)).toMatchObject({ anchorSeq: 10, location })
  })

  it('preserves images exactly and keeps reasoning distinct from visible prose', () => {
    const attachment: ImageBlock['attachment'] = {
      attachmentId: 'attachment-fixture' as ImageBlock['attachment']['attachmentId'], mediaType: 'image/png',
      bytes: 42, width: 320, height: 200, name: 'fixture.png', originalDimensions: { width: 640, height: 400 },
    }
    const events = freeze([start(), chunk(2, { type: 'reasoning-delta', index: 0, text: 'Thinking' }), call(3),
      chunk(4, { type: 'block-start', index: 1, blockType: 'image' }),
      chunk(5, { type: 'block-end', index: 1, block: { type: 'image', attachment } }),
      assistant(6, [{ type: 'reasoning', text: 'Thinking' }, { type: 'image', attachment }]), result(7), end(8)])
    const before = JSON.stringify(events)
    const projected = state(events)
    expect(projected.segments.map(segment => segment.kind)).toEqual(['reasoning', 'activity', 'image'])
    expect(projected.segments[2].attachment).toBe(attachment)
    expect(projected.segments[2].attachment).toEqual(attachment)
    expect(JSON.stringify(events)).toBe(before)
    expect(codexProcessAnswerSegments(projected)).toEqual([])
  })

  it.each<TurnEndReason>([
    { kind: 'aborted', reason: { kind: 'legacy' } }, { kind: 'interrupted' },
    { kind: 'error', error: { code: 'FIXTURE', message: 'Failed' } },
    { kind: 'blocked' }, { kind: 'max-tokens' },
  ])('settles outstanding activities as errors when the turn ends with $kind', reason => {
    const running = state([start(), call(2, 'done'), result(3, 'done'), call(4, 'unfinished')])
    freeze(running)
    const closed = reduceCodexProcess(running, end(5, reason))
    expect(closed.status).toBe('error')
    expect(closed.endedAt).toBe(500)
    expect(closed.segments.map(segment => segment.activity?.status)).toEqual(['completed', 'error'])
    expect(running.segments[1].activity?.status).toBe('running')
  })

  it('does not falsely report successful unresolved calls, and honors result-level failures', () => {
    expect(state([start(), call(2), end(3)]).segments[0].activity?.status).toBe('error')
    expect(state([start(), result(2, 'item', 1, true), end(3)]).segments[0].activity?.status).toBe('error')
    const withoutMetadata = result(3, 'item', 1, true)
    delete withoutMetadata.data.meta
    expect(state([start(), call(2), withoutMetadata, end(4)]).segments[0].activity?.status).toBe('error')
  })

  it('keeps a recovered tool failure visible while the successfully completed turn is completed', () => {
    const events = [start(), call(2, 'denied'), result(3, 'denied', 1, true),
      call(4, 'retry'), result(5, 'retry'), assistant(6, [{ type: 'text', text: 'Recovered answer' }]), end(7)]
    const projected = state(events)
    expect(projected.status).toBe('completed')
    expect(projected.segments.filter(segment => segment.kind === 'activity').map(segment => segment.activity?.status))
      .toEqual(['error', 'completed'])
    expect(codexProcessAnswerSegments(projected).map(segment => segment.text)).toEqual(['Recovered answer'])
  })

  it('does not let a foreign step failure contaminate the owned process status', () => {
    const events = [start(), text(2, 'Foreign partial'), chunk(3, {
      type: 'finish', reason: { kind: 'error', failure: { code: 'FOREIGN', message: 'Foreign failure' } },
    }), assistant(4, [{ type: 'text', text: 'Foreign partial' }], 1, 'deepseek'),
      text(5, 'Codex answer', 0, 2), assistant(6, [{ type: 'text', text: 'Codex answer' }], 2), end(7)]
    expect(state(events)).toMatchObject({ status: 'completed', ownedSteps: [2] })
    expect(state(events).error).toBeUndefined()
    expect(state(events).segments.map(segment => segment.text)).toEqual(['Codex answer'])
  })

  it('a fatal Codex finish still fails the process even if the boundary says completed', () => {
    const events = [start(), text(2, 'Partial'), chunk(3, {
      type: 'finish', reason: { kind: 'error', failure: { code: 'FATAL', message: 'Fatal failure' } },
    }), assistant(4, [{ type: 'text', text: 'Partial' }]), end(5)]
    expect(state(events)).toMatchObject({ status: 'error', error: 'Fatal failure', ownedSteps: [1] })
  })

  it('retains aborted finish failure and streamed text through the final interrupted checkpoint', () => {
    const interrupted = assistant(5, [{ type: 'text', text: 'Partial' }])
    interrupted.data.interrupted = true
    const events = [start(), call(2), text(3, 'Partial'), chunk(4, {
      type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'Stopped' } },
    }), interrupted, end(6, { kind: 'aborted', reason: { kind: 'legacy' } })]
    expect(state(events)).toMatchObject({ status: 'error', error: 'Stopped' })
    expect(state(events).segments[1].text).toBe('Partial')
    expect(codexProcessAnswerSegments(state(events))).toEqual([])
  })

  it('uses animation-frame publication for deltas and immediately publishes finish metadata and closure', () => {
    for (const [event, expected] of [
      [start(), 'none'], [text(2, 'x'), 'animation-frame'],
      [chunk(3, { type: 'reasoning-delta', index: 0, text: 'x' }), 'animation-frame'],
      [chunk(4, { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }), 'none'],
      [chunk(5, { type: 'finish', reason: { kind: 'stop' } }), 'immediate'], [call(6), 'immediate'], [end(7), 'immediate'],
    ] as const) {
      expect(definition.publication!({ event, view: undefined, role: 'update', location: { kind: 'unresolved' } })).toBe(expected)
    }
  })
})

describe('Codex presentation phases', () => {
  const replayState = { response: { codexPresentation: { version: 1, blocks: [
    { index: 3, itemId: 'progress', phase: 'commentary' }, { index: 8, itemId: 'answer', phase: 'final_answer' },
  ] } } }

  it('applies explicit phases at finish and reads the same metadata on persisted source', () => {
    const events = [start(), text(2, 'Progress', 3), call(3), result(4), text(5, 'Answer', 8)]
    expect(state(events).segments.every(segment => segment.phase === undefined)).toBe(true)
    const finished = [...events, chunk(6, { type: 'finish', reason: { kind: 'stop' }, replayState })]
    expect(state(finished).segments.filter(segment => segment.kind === 'text').map(segment => segment.phase)).toEqual(['commentary', 'final_answer'])
    expect(codexProcessAnswerSegments(state(finished)).map(segment => segment.text)).toEqual(['Answer'])
    const aggregate = assistant(7, [{ type: 'text', text: 'Progress' }, { type: 'text', text: 'Answer' }], 1, 'relay-codex', replayState)
    const settled = state([...finished, aggregate, end(8)])
    expect(settled.segments).toHaveLength(3)
    const persisted = state([start(), aggregate, end(8)])
    expect(persisted.segments.map(({ key, phase, itemId, text }) => ({ key, phase, itemId, text })))
      .toEqual(settled.segments.filter(segment => segment.kind === 'text').map(({ key, phase, itemId, text }) => ({ key, phase, itemId, text })))
  })

  it('does not invent phases from wording, and keeps a legacy sole text as the answer after closure', () => {
    const events = [start(), assistant(2, [{ type: 'text', text: 'Final answer: all done.' }])]
    expect(codexProcessAnswerSegments(state(events))).toEqual([])
    const closed = state([...events, end(3)])
    expect(closed.segments[0].phase).toBeUndefined()
    expect(codexProcessAnswerSegments(closed)).toEqual([closed.segments[0]])
    expect(closed.segments).toHaveLength(1)
  })

  it('preserves persisted images between text blocks without shifting text phase metadata', () => {
    const attachment: ImageBlock['attachment'] = { attachmentId: 'image' as ImageBlock['attachment']['attachmentId'],
      mediaType: 'image/png', bytes: 42, width: 32, height: 32 }
    const metadata = { response: { codexPresentation: { version: 1, blocks: [
      { index: 0, itemId: 'progress', phase: 'commentary' }, { index: 2, itemId: 'answer', phase: 'final_answer' },
    ] } } }
    const aggregate = assistant(10, [
      { type: 'text', text: 'Image follows' }, { type: 'image', attachment }, { type: 'text', text: 'Answer' },
    ], 1, 'relay-codex', metadata)
    const projected = state([aggregate, end(11)])
    expect(projected.segments.map(segment => [segment.key, segment.kind, segment.phase])).toEqual([
      ['block:1:0', 'text', 'commentary'], ['block:1:1', 'image', undefined], ['block:1:2', 'text', 'final_answer'],
    ])
    expect(projected.segments[1].attachment).toBe(attachment)
  })

  it('keeps explicit commentary and unknown modern phases out of the legacy answer fallback', () => {
    for (const phase of ['commentary', 'unknown', null]) {
      const metadata = { response: { codexPresentation: { version: 1, blocks: [{ index: 0, itemId: 'x', phase }] } } }
      const closed = state([start(), assistant(2, [{ type: 'text', text: 'Progress only' }], 1, 'relay-codex', metadata), end(3)])
      expect(codexProcessAnswerSegments(closed)).toEqual([])
      expect(closed.segments[0].text).toBe('Progress only')
    }
  })

  it('rejects malformed metadata and ignores invalid indices and duplicate mappings', () => {
    for (const value of [undefined, null, [], {}, { response: null }, { response: { codexPresentation: { version: 2, blocks: [] } } }]) {
      expect(readCodexPresentation(value)).toBeUndefined()
    }
    const parsed = readCodexPresentation({ response: { codexPresentation: { version: 1, blocks: [
      null, { index: -1, itemId: 'x' }, { index: 0.5, itemId: 'x' }, { index: 0, itemId: 10 },
      { index: 0, itemId: 'valid', phase: 'commentary' }, { index: 0, itemId: 'duplicate', phase: 'final_answer' },
    ] } } })
    expect(parsed).toEqual({ version: 1, blocks: [{ index: 0, itemId: 'valid', phase: 'commentary' }] })
  })

  it('does not consume replacement surface messages', () => {
    const replacement = assistant(2, [{ type: 'text', text: 'Replacement' }])
    replacement.surfaceOp = { op: 'replace', start: 1, end: 1 }
    expect(definition.match(replacement)).toBeNull()
    expect(replayCodexProcess([])).toBeUndefined()
    expect(initialCodexProcessState(2, 10)).toMatchObject({ turn: 2, owned: false, status: 'running' })
  })
})

interface RuntimeSnapshot {
  readonly nodes: readonly ChatConversationViewNode[]
  readonly timeline: ConversationTimelineSnapshot
}

// Only the view collector is test-owned; event matching, location publication,
// incremental updates, window replacement, and prepend use the official engine.
const testView: ConversationViewDefinition<ChatConversationViewNode, RuntimeSnapshot> = {
  target: 'chat',
  create: () => {
    let nodes: readonly ChatConversationViewNode[] = []
    return {
      empty: { nodes, timeline: { turnOrder: [], turns: new Map() } },
      replace: input => { nodes = input.nodes; return { nodes, timeline: input.timeline } },
      apply: input => {
        const merged = new Map(nodes.map(node => [node.key, node]))
        input.upserts.forEach(node => { merged.set(node.key, node) })
        nodes = [...merged.values()]
        return { nodes, timeline: input.timeline }
      },
    }
  },
}

const input = (event: SessionEventLike): SessionEventLikeEntry =>
  event.type === 'assistant/live-chunk' ? { type: 'transient', event } : { type: 'event', event }
function runtime(events: readonly SessionEventLike[] = [], hasMore = false, definitions: readonly ConversationNodeDefinition[] = [definition]) {
  const assembler = new ConversationNodeAssembler(
    { entries: () => definitions, fallbackEntry: () => undefined }, { entries: () => [testView] },
  )
  // alpha.3 materializes target views lazily after the first consumer
  // subscribes; alpha.2 eagerly materializes every registered view.
  ;(assembler as ConversationNodeAssembler & { activateTarget?: (target: string) => boolean })
    .activateTarget?.('chat')
  assembler.replaceWindow(events.map(input), hasMore)
  assembler.flush()
  return assembler
}
const snapshot = (assembler: ConversationNodeAssembler) => assembler.snapshot('chat') as RuntimeSnapshot

describe('official ConversationNodeAssembler integration', () => {
  const events = [start(), event(2, 'step/start', { turn: 1, step: 1 }), text(3, 'Inspecting'),
    synthetic(4), call(5), result(6), text(7, 'Answer', 1), modernAssistant(8, [
      { type: 'text', text: 'Inspecting' }, { type: 'text', text: 'Answer' },
    ]), event(9, 'step/end', { turn: 1, step: 1 }), end(10)]

  it('produces identical turn data on streaming append and full window replay', () => {
    const live = runtime()
    for (const event of events) {
      live.append(input(event))
      live.flush()
      const replay = runtime(events.filter(value => value.seq <= event.seq))
      const current = snapshot(live)
      const restored = snapshot(replay)
      expect(current.nodes.filter(node => node.visibility === 'visible').map(node => [node.key, node.anchorSeq, node.data]))
        .toEqual(restored.nodes.filter(node => node.visibility === 'visible').map(node => [node.key, node.anchorSeq, node.data]))
      expect(current.timeline.turns.get(1)?.data.get('relay-codex-process'))
        .toEqual(restored.timeline.turns.get(1)?.data.get('relay-codex-process'))
    }
    expect(snapshot(live).nodes).toHaveLength(1)
    expect(snapshot(live).nodes[0]).toMatchObject({ anchorSeq: 3, data: { owned: true, ownedSteps: [1], status: 'completed' } })
  })

  it('replays partial windows then prepends the missing turn/start without changing the node key', () => {
    const partial = runtime(events.slice(3), true)
    const key = snapshot(partial).nodes[0].key
    partial.prepend(events.slice(0, 3).map(input), false)
    partial.flush()
    expect(snapshot(partial).nodes).toHaveLength(1)
    expect(snapshot(partial).nodes[0].key).toBe(key)
    const full = snapshot(runtime(events))
    expect(snapshot(partial).nodes[0].data).toEqual(full.nodes[0].data)
    expect(snapshot(partial).nodes[0].anchorSeq).toBe(3)
    expect(snapshot(partial).timeline.turns.get(1)?.data.get('relay-codex-process')).toEqual(full.nodes[0].data)
  })

  it('continues a partial window without a start and honors animation-frame cadence and duplicate delivery', () => {
    const partial = runtime([call(10)], true)
    expect(partial.append(input(text(11, 'Live')))).toBe('animation-frame')
    partial.flush()
    expect((snapshot(partial).nodes[0].data as CodexProcessState).segments[1].text).toBe('Live')
    expect(partial.append(input(text(11, 'Live')))).toBe('none')
    partial.append(input(end(12, { kind: 'interrupted' })))
    partial.flush()
    expect(snapshot(partial).nodes[0].data).toMatchObject({ status: 'error', endedAt: 1200 })
    expect((snapshot(partial).nodes[0].data as CodexProcessState).segments).toHaveLength(2)
  })

  it('keeps foreign steps and separate foreign turns outside the published owned step list', () => {
    const mixed = runtime([...events.slice(0, -2), event(9, 'step/end', { turn: 1, step: 1 }),
      event(10, 'step/start', { turn: 1, step: 2 }), text(11, 'Foreign', 0, 2),
      assistant(12, [{ type: 'text', text: 'Foreign' }], 2, 'deepseek'), end(13), start(14, 2),
      event(15, 'assistant/message', { ...assistant(15, [{ type: 'text', text: 'Another turn' }], 1, 'deepseek').data, turn: 2 }),
      end(16, { kind: 'completed' }, 2)])
    expect(snapshot(mixed).nodes).toHaveLength(0)
    expect(snapshot(mixed).timeline.turns.get(1)?.data.get('relay-codex-process'))
      .toMatchObject({ turn: 1, ownedSteps: [1], takeoverSafe: false, takeoverReasons: ['foreign-provider'] })
    expect(snapshot(mixed).timeline.turns.get(2)?.data.get('relay-codex-process')).toBeUndefined()
  })

  it('hides an already-published node if conflicting foreign provenance invalidates ownership', () => {
    const live = runtime([start(), call(2)])
    live.append(input(assistant(3, [{ type: 'text', text: 'Foreign' }], 1, 'deepseek')))
    expect(() => live.flush()).not.toThrow()
    expect(snapshot(live).nodes[0]).toMatchObject({ visibility: 'hidden', data: { owned: false, ownedSteps: [] } })
    expect(snapshot(live).timeline.turns.get(1)?.data.get('relay-codex-process')).toBeUndefined()
  })

  it('explicitly leaves unlocated legacy custom activities to their existing renderer', () => {
    const legacy = event(2, 'relay-codex/activity', payload())
    expect(definition.match(legacy)).toBeNull()
    expect(snapshot(runtime([start(), legacy, end(3)])).nodes).toHaveLength(0)
  })
})

function nativeCall(seq: number, name: string, step = 1) {
  const value = call(seq, name, step)
  return { ...value, data: { ...value.data, name, arguments: '{}' } }
}

function nativeResult(seq: number, name: string, step = 1) {
  const value = result(seq, name, step)
  delete value.data.meta
  return value
}

// Native-row sentinels check chronology and co-registration without implementing
// native UI. The real assembler owns both definitions and the shared Turn data.
const nativeRows: ConversationNodeDefinition<SessionEvent> = {
  kind: 'test-native-row', target: 'chat',
  match: event => event.type === 'assistant/message' || event.type === 'tool/result'
    ? { id: String(event.seq), role: 'start' } : null,
  start: (_context, match) => match.event,
  update: context => context.state,
  buildViewNode: context => context.start ? {
    key: context.key, kind: 'test-native-row', id: context.id, target: 'chat',
    anchorSeq: context.start.event.seq, location: context.start.location, visibility: 'visible', data: context.state,
  } as ChatConversationViewNode : null,
}

describe('conservative turn takeover', () => {
  const imported = [start(), modernAssistant(2, 'Inspecting'),
    nativeCall(3, 'bash'), nativeResult(4, 'bash'),
    assistant(5, [{ type: 'text', text: 'Editing' }], 2), nativeCall(6, 'edit', 2), nativeResult(7, 'edit', 2),
    modernAssistant(8, 'Final answer', 3), end(9)]

  it('leaves imported bash/edit rows and all commentary in native chronological order', () => {
    freeze(imported)
    const before = JSON.stringify(imported)
    const value = runtime(imported, false, [definition, nativeRows])
    const projected = snapshot(value).timeline.turns.get(1)?.data.get('relay-codex-process')
    expect(projected).toMatchObject({ owned: true, ownedSteps: [1, 2, 3], takeoverSafe: false,
      takeoverReasons: ['unsupported-tool'], unsupportedToolSeq: 3 })
    expect(canTakeOverCodexProcess(projected)).toBe(false)
    expect(snapshot(value).nodes.map(node => [node.kind, node.anchorSeq])).toEqual([
      ['test-native-row', 2], ['test-native-row', 4], ['test-native-row', 5], ['test-native-row', 7], ['test-native-row', 8],
    ])
    expect(JSON.stringify(imported)).toBe(before)
  })

  it('revokes live takeover at the first unsupported call and never re-enables it for that turn', () => {
    const live = runtime(imported.slice(0, 2), false, [definition, nativeRows])
    const original = snapshot(live).nodes.find(node => node.kind === definition.kind)!
    expect(original.visibility).toBe('visible')
    for (const event of imported.slice(2)) {
      expect(live.append(input(event))).toBe('immediate')
      expect(() => live.flush()).not.toThrow()
      const current = snapshot(live).nodes.find(node => node.key === original.key)!
      expect(current.visibility).toBe('hidden')
      expect(canTakeOverCodexProcess(current.data as CodexProcessState)).toBe(false)
      const replay = runtime(imported.filter(value => value.seq <= event.seq), false, [definition, nativeRows])
      expect(snapshot(live).timeline.turns.get(1)?.data.get('relay-codex-process'))
        .toEqual(snapshot(replay).timeline.turns.get(1)?.data.get('relay-codex-process'))
      expect(snapshot(live).nodes.filter(node => node.visibility === 'visible').map(node => node.anchorSeq))
        .toEqual(snapshot(replay).nodes.map(node => node.anchorSeq))
    }
  })

  it('revokes takeover when an older page reveals unsupported tools before the final answer', () => {
    const partial = runtime(imported.slice(7), true)
    expect(snapshot(partial).nodes[0].visibility).toBe('visible')
    partial.prepend(imported.slice(0, 7).map(input), false)
    expect(() => partial.flush()).not.toThrow()
    expect(snapshot(partial).nodes[0]).toMatchObject({ visibility: 'hidden', data: { takeoverSafe: false } })
    expect(snapshot(partial).timeline.turns.get(1)?.data.get('relay-codex-process'))
      .toEqual(snapshot(runtime(imported)).timeline.turns.get(1)?.data.get('relay-codex-process'))
  })

  it('disables takeover for tool-only assistant checkpoints even without tool/call events', () => {
    for (const name of ['bash', 'edit', 'relay_codex_activity']) {
      const events = [start(), assistant(2, [{ type: 'tool-call', id: 'native' as ToolCallId, name, arguments: '{}' }]),
        assistant(3, [{ type: 'text', text: 'Done' }]), end(4)]
      expect(state(events)).toMatchObject({ owned: true, takeoverSafe: false, unsupportedToolSeq: 2 })
      expect(node(events)).toBeNull()
    }
  })

  it('disables takeover for unsupported result-only histories and streamed tool blocks', () => {
    const unsupported = [nativeResult(3, 'bash'),
      chunk(3, { type: 'block-start', index: 1, blockType: 'tool-call' }),
      chunk(3, { type: 'tool-call-delta', index: 1, id: 'bash' as ToolCallId, name: 'bash', argumentsDelta: '{}' }),
      chunk(3, { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'bash' as ToolCallId, name: 'bash', arguments: '{}' } }),
    ]
    for (const boundary of unsupported) {
      const events = [start(), assistant(2, [{ type: 'text', text: 'Before' }]), boundary,
        assistant(4, [{ type: 'text', text: 'After' }], 2), end(5)]
      expect(state(events).takeoverReasons).toContain('unsupported-tool')
      expect(node(events)).toBeNull()
    }
  })

  it('does not treat a valid-looking activity payload under a different tool name as represented', () => {
    const wrongName = call(2)
    const events = [start(), { ...wrongName, data: { ...wrongName.data, name: 'bash' } }, result(3),
      assistant(4, [{ type: 'text', text: 'Done' }]), end(5)]
    expect(state(events).takeoverReasons).toContain('unsupported-tool')
    expect(canTakeOverCodexProcess(state(events))).toBe(false)
  })

  it('keeps all native rows when foreign-provider steps interleave two owned steps', () => {
    const mixed = [start(), modernAssistant(2, 'Codex first'),
      assistant(3, [{ type: 'text', text: 'Foreign middle' }], 2, 'deepseek'),
      assistant(4, [{ type: 'text', text: 'Codex last' }], 3), end(5)]
    const live = runtime([], false, [definition, nativeRows])
    for (const event of mixed) {
      live.append(input(event))
      live.flush()
    }
    const projected = snapshot(live).timeline.turns.get(1)?.data.get('relay-codex-process')
    expect(projected).toMatchObject({ ownedSteps: [1, 3], foreignSteps: [2], takeoverSafe: false,
      takeoverReasons: ['foreign-provider'] })
    expect(canTakeOverCodexProcess(projected)).toBe(false)
    expect(snapshot(live).nodes.filter(node => node.visibility === 'visible').map(node => node.anchorSeq)).toEqual([2, 3, 4])
    expect(snapshot(runtime(mixed)).nodes).toHaveLength(0)
  })

  it('pauses takeover for an unproven visible step and resumes only when that step is owned', () => {
    const live = runtime([start(), modernAssistant(2, 'First')])
    live.append(input(text(3, 'Next', 0, 2)))
    live.flush()
    expect(snapshot(live).nodes[0]).toMatchObject({ visibility: 'hidden',
      data: { takeoverSafe: false, takeoverReasons: ['unowned-step'], ownedSteps: [1] } })
    live.append(input(assistant(4, [{ type: 'text', text: 'Next' }], 2)))
    live.flush()
    expect(snapshot(live).nodes[0]).toMatchObject({ visibility: 'visible', anchorSeq: 2,
      data: { takeoverSafe: true, takeoverReasons: [], ownedSteps: [1, 2] } })
  })

  it('keeps supported activity-only and text/activity/text turns eligible', () => {
    for (const events of [[call(9)], [call(9), result(10), modernAssistant(11, []), end(12)],
      [start(), text(2, 'Before'), synthetic(3), call(4), result(5),
      text(6, 'After', 1), modernAssistant(7, [{ type: 'text', text: 'Before' }, { type: 'text', text: 'After' }]), end(8)]]) {
      expect(state(events).takeoverSafe).toBe(true)
      expect(state(events).takeoverReasons).toEqual([])
      expect(canTakeOverCodexProcess(state(events))).toBe(true)
      expect(node(events)?.visibility).toBe('visible')
    }
    expect(canTakeOverCodexProcess(undefined)).toBe(false)
    expect(canTakeOverCodexProcess(null)).toBe(false)
    expect(canTakeOverCodexProcess(initialCodexProcessState(1, 100))).toBe(false)
  })

  it('does not propagate an unsupported turn into the next fully supported turn', () => {
    const next = modernAssistant(11, 'New turn')
    const value = runtime([...imported, start(10, 2), { ...next, data: { ...next.data, turn: 2 } }, end(12, { kind: 'completed' }, 2)])
    expect(snapshot(value).nodes).toHaveLength(1)
    expect(snapshot(value).nodes[0].data).toMatchObject({ turn: 2, takeoverSafe: true, takeoverReasons: [] })
  })
})

describe('orphan results with the official native tool definition', () => {
  function root(assembler: ConversationNodeAssembler): ToolCallBlock {
    const node = snapshot(assembler).nodes.find(node => node.kind === 'tool-call')!
    return (node.data as { root: ToolCallBlock }).root
  }

  it('keeps result-only metadata on the native generic dispatch path without process takeover', () => {
    const value = runtime([result(10), end(11)], true, [definition, toolDefinition])
    const block = root(value)
    expect(block).toMatchObject({ kind: 'tool-result', callId: 'call-item', call: null })
    // This is the dispatch-key expression in official ToolCallTree.callName.
    expect('kind' in block ? block.call?.name ?? '' : block.name).toBe('')
    const process = snapshot(value).timeline.turns.get(1)?.data.get('relay-codex-process')
    expect(process?.segments[0]).toMatchObject({ activity: { status: 'completed' }, callId: 'call-item' })
    expect(canTakeOverCodexProcess(process)).toBe(false)
    expect(process?.takeoverReasons).toContain('orphan-tool-result')
    expect(snapshot(value).nodes.map(node => node.kind)).toEqual(['tool-call'])
  })

  it('restores safe takeover and the native named dispatch key when the missing call is prepended', () => {
    const history = [start(), event(2, 'step/start', { turn: 1, step: 1 }), text(3, 'Inspecting'),
      synthetic(4), call(5), result(6), modernAssistant(7, 'Done'), end(8)]
    const partial = runtime(history.slice(5), true, [definition, toolDefinition])
    const toolKey = snapshot(partial).nodes.find(node => node.kind === 'tool-call')!.key
    expect(snapshot(partial).nodes.filter(node => node.kind === definition.kind)).toHaveLength(0)
    expect(root(partial)).toMatchObject({ call: null })

    partial.prepend(history.slice(0, 5).map(input), false)
    expect(() => partial.flush()).not.toThrow()
    expect(snapshot(partial).nodes.find(node => node.kind === 'tool-call')!.key).toBe(toolKey)
    expect(root(partial)).toMatchObject({ call: { name: 'relay_codex_activity' } })
    const process = snapshot(partial).timeline.turns.get(1)?.data.get('relay-codex-process')
    expect(canTakeOverCodexProcess(process)).toBe(true)
    expect(process?.takeoverReasons).toEqual([])
    expect(process?.orphanResultSeq).toBeUndefined()
    expect(process?.segments.find(segment => segment.kind === 'activity')).toMatchObject({ nativeCallSeq: 5 })
    const full = runtime(history, false, [definition, toolDefinition])
    expect(process).toEqual(snapshot(full).timeline.turns.get(1)?.data.get('relay-codex-process'))
    expect(root(partial)).toEqual(root(full))
    expect(snapshot(partial).nodes.find(node => node.kind === definition.kind))
      .toMatchObject({ visibility: 'visible', anchorSeq: 3 })
  })

  it('requires a native call even if an assistant checkpoint carries the same tool arguments', () => {
    const partial = runtime([synthetic(4), result(6), end(8)], true, [definition, toolDefinition])
    expect(root(partial)).toMatchObject({ call: null })
    const process = snapshot(partial).timeline.turns.get(1)?.data.get('relay-codex-process')
    expect(process?.segments[0].argsRaw).toBeDefined()
    expect(process?.segments[0].nativeCallSeq).toBeUndefined()
    expect(canTakeOverCodexProcess(process)).toBe(false)

    // Loading a still-earlier checkpoint is insufficient; only the native call
    // can give the official tool definition the name used for renderer dispatch.
    const resultOnly = runtime([result(6), end(8)], true, [definition, toolDefinition])
    resultOnly.prepend([input(synthetic(4))], true)
    resultOnly.flush()
    expect(root(resultOnly)).toMatchObject({ call: null })
    expect(canTakeOverCodexProcess(snapshot(resultOnly).timeline.turns.get(1)?.data.get('relay-codex-process'))).toBe(false)
  })

  it('does not mistake repeated orphan results or unrelated calls for call evidence', () => {
    const events = [call(9, 'other'), result(10), result(11), end(12)]
    const value = runtime(events, true, [definition, toolDefinition])
    const process = snapshot(value).timeline.turns.get(1)?.data.get('relay-codex-process')
    expect(canTakeOverCodexProcess(process)).toBe(false)
    expect(process?.segments.filter(segment => segment.callId === 'call-item')).toHaveLength(1)
    expect(process?.orphanResultSeq).toBe(10)
    expect(snapshot(value).nodes.filter(node => node.kind === definition.kind)).toHaveLength(0)
  })

  it('falls back if a duplicate recorded result makes the native tool lose its call name', () => {
    const value = runtime([start(), call(2), result(3)], false, [definition, toolDefinition])
    expect(root(value)).toMatchObject({ call: { name: 'relay_codex_activity' } })
    expect(canTakeOverCodexProcess(snapshot(value).timeline.turns.get(1)?.data.get('relay-codex-process'))).toBe(true)
    // Transport redelivery of the same seq is ignored by the real assembler.
    expect(value.append(input(result(3)))).toBe('none')
    value.append(input(result(4)))
    value.flush()
    expect(root(value)).toMatchObject({ call: null })
    const process = snapshot(value).timeline.turns.get(1)?.data.get('relay-codex-process')
    expect(canTakeOverCodexProcess(process)).toBe(false)
    expect(process?.segments).toHaveLength(1)
    expect(process?.orphanResultSeq).toBe(4)
  })

  it('revokes a live process when an orphan result arrives, identically to replay', () => {
    const history = [start(), text(2, 'Inspecting'), call(3, 'known'), result(4, 'known'),
      result(5, 'orphan'), assistant(6, [{ type: 'text', text: 'Done' }]), end(7)]
    const live = runtime(history.slice(0, 4), false, [definition, toolDefinition])
    const key = snapshot(live).nodes.find(node => node.kind === definition.kind)!.key
    for (const event of history.slice(4)) {
      live.append(input(event))
      expect(() => live.flush()).not.toThrow()
      expect(snapshot(live).nodes.find(node => node.key === key)).toMatchObject({ visibility: 'hidden' })
      const replay = runtime(history.filter(value => value.seq <= event.seq), false, [definition, toolDefinition])
      expect(snapshot(live).timeline.turns.get(1)?.data.get('relay-codex-process'))
        .toEqual(snapshot(replay).timeline.turns.get(1)?.data.get('relay-codex-process'))
    }
  })
})

describe('minimal legacy presentation gate', () => {
  it('keeps legacy text-only turns native while versioned text-only turns can take over', () => {
    for (const closed of [false, true]) {
      const legacy = [start(), assistant(2, [{ type: 'text', text: 'Answer' }]), ...closed ? [end(3)] : []]
      expect(state(legacy)).toMatchObject({ owned: true, takeoverSafe: false, takeoverReasons: ['legacy-no-presentation'] })
      expect(state(legacy).segments[0].text).toBe('Answer')
      expect(node(legacy)).toBeNull()
      const modern = [start(), modernAssistant(2, 'Answer'), ...closed ? [end(3)] : []]
      expect(canTakeOverCodexProcess(state(modern))).toBe(true)
      expect(node(modern)?.visibility).toBe('visible')
    }
  })

  it('accepts explicit finish metadata without inventing it for unversioned text', () => {
    const history = [start(), text(2, 'Answer'), assistant(3, [{ type: 'text', text: 'Answer' }])]
    expect(node(history)).toBeNull()
    const finished = [...history, chunk(4, { type: 'finish', reason: { kind: 'stop' }, replayState: presentation }), end(5)]
    expect(node(finished)).toMatchObject({ anchorSeq: 2, data: { takeoverSafe: true, takeoverReasons: [] } })
    for (const replayState of [{}, { response: { codexPresentation: { version: 2, blocks: [] } } },
      { response: { codexPresentation: { version: 1, blocks: null } } }]) {
      expect(node([start(), assistant(2, [{ type: 'text', text: 'Answer' }], 1, 'relay-codex', replayState), end(3)])).toBeNull()
    }
  })

  it.each<TurnEndReason>([{ kind: 'completed' }, { kind: 'aborted', reason: { kind: 'legacy' } },
    { kind: 'error', error: { code: 'FAILED', message: 'Failed' } }])(
    'does not impose a terminal metadata requirement on native activity for $kind', reason => {
      const failedFinish = chunk(4, { type: 'finish', reason: { kind: 'error', failure: { code: 'FAILED', message: 'Failed' } } })
      const events = [start(), call(2), result(3), ...reason.kind === 'error' ? [failedFinish] : [], end(5, reason)]
      const projected = state(events)
      expect(projected.presentations).toEqual({})
      expect(projected.takeoverSafe).toBe(true)
      expect(node(events)?.visibility).toBe('visible')
      expect(projected.status).toBe(reason.kind === 'completed' ? 'completed' : 'error')
    },
  )

  it('preserves explicit safety booleans on UI fixtures', () => {
    const fixture = { ...initialCodexProcessState(1, 100), owned: true, ownedSteps: [1],
      firstVisibleSeq: 2, takeoverSafe: true, takeoverReasons: [] }
    expect(canTakeOverCodexProcess(fixture)).toBe(true)
    expect(canTakeOverCodexProcess({ ...fixture, takeoverSafe: false })).toBe(false)
  })

  it('preserves three legacy activity rows before the native answer in the official assembler', () => {
    const history = freeze([start(), event(2, 'step/start', { turn: 1, step: 1 }), text(3, 'Progress'),
      event(4, 'relay-codex/activity', payload('one')), event(5, 'relay-codex/activity', payload('one', 'completed')),
      event(6, 'relay-codex/activity', payload('two')), event(7, 'relay-codex/activity', payload('two', 'completed')),
      event(8, 'relay-codex/activity', payload('three')), event(9, 'relay-codex/activity', payload('three', 'completed')),
      assistant(10, [{ type: 'text', text: 'Final answer' }]), event(11, 'step/end', { turn: 1, step: 1 }), end(12)])
    const definitions = [definition, assistantDefinition, codexActivityDefinition]
    const live = runtime([], false, definitions)
    for (const event of history) {
      live.append(input(event))
      expect(() => live.flush()).not.toThrow()
    }
    const order = (value: ConversationNodeAssembler) => snapshot(value).nodes
      .filter(node => node.visibility === 'visible').sort((left, right) => left.anchorSeq - right.anchorSeq)
      .map(node => [node.kind, node.anchorSeq])
    expect(order(live)).toEqual([
      ['relay-codex-activity', 4], ['relay-codex-activity', 6], ['relay-codex-activity', 8], ['assistant-step', 10],
    ])
    expect(order(runtime(history, false, definitions))).toEqual(order(live))
    const partial = runtime(history.slice(7), true, definitions)
    partial.prepend(history.slice(0, 7).map(input), false)
    partial.flush()
    expect(order(partial)).toEqual(order(live))
    expect(snapshot(partial).timeline.turns.get(1)?.data.get('relay-codex-process'))
      .toMatchObject({ takeoverSafe: false, takeoverReasons: ['legacy-no-presentation'] })
  })
})


describe('DSH packed delta transport', () => {
  it.each(['text', 'reasoning'] as const)('preserves raw %s content, visible anchors, and logical sequences', kind => {
    const raw = [' ', 'hello', ' ', 'world'].map((value, offset) =>
      chunk(3 + offset, { type: kind === 'text' ? 'text-delta' : 'reasoning-delta', index: 0, text: value }))
    const packed: SessionEventLike = {
      type: kind === 'text' ? 'chunkrow/text-chunks' : 'chunkrow/reasoning-chunks',
      seq: 3, time: 300, data: { turn: 1, step: 1, index: 0, texts: [' ', 'hello', ' ', 'world'], dt: [100, 100, 100] },
    }
    const prefix = [start(), call(2)]
    expect(replayCodexProcess([...prefix, packed])).toEqual(replayCodexProcess([...prefix, ...raw]))
    const partial = replayCodexProcess([...prefix, raw[0], raw[1]])!
    const restored = reduceCodexProcess(partial, packed)
    expect(restored).toEqual(replayCodexProcess([...prefix, ...raw]))
    expect(reduceCodexProcess(restored, packed)).toBe(restored)
    const live = runtime(prefix)
    live.append(input(packed)); live.flush()
    expect(snapshot(live).nodes[0].data).toEqual(snapshot(runtime([...prefix, ...raw])).nodes[0].data)
    expect(definition.publication?.({ event: packed } as ConversationMatch)).toBe('animation-frame')
  })

  it('keeps native tool rendering for packed tool argument deltas', () => {
    const state = replayCodexProcess([start(), call(2), {
      type: 'chunkrow/tool-call-chunks', seq: 3, time: 300,
      data: { turn: 1, step: 1, index: 0, id: 'foreign-tool' as ToolCallId, args: ['{', '}'], dt: [100] },
    }])!
    expect(state.lastSeq).toBe(4)
    expect(state.takeoverReasons).toContain('unsupported-tool')
    expect(canTakeOverCodexProcess(state)).toBe(false)
  })
})
