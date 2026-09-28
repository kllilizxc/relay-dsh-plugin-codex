import type { ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionEventLike } from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  ConversationMatch, ConversationNodeContext, ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ContentBlock, ImageBlock, StreamChunk } from '@deepseek-ai/dsh-llm/types'
import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session/types'
import { CODEX_ACTIVITY_TOOL, readActivityPayload } from '../../codex-activity-wire.mjs'
import type { CodexActivityData, CodexActivityEventData } from './codex-activity.ts'

type LegacyAssistantChunkEvent = {
  readonly type: 'assistant/chunk'
  readonly seq: number
  readonly time: number
  readonly data: { readonly turn: number; readonly step: number; readonly chunk: StreamChunk }
}

type CompatibleAssistantLiveChunkEvent = {
  readonly type: 'assistant/live-chunk'
  readonly seq: number
  readonly time: number
  readonly data: {
    readonly attemptId: string
    readonly turn: number
    readonly step: number
    readonly chunk: StreamChunk
  }
}

type LegacyChunkRowEvent = {
  readonly type: 'chunkrow/text-chunks' | 'chunkrow/reasoning-chunks'
  readonly seq: number
  readonly time: number
  readonly data: { readonly turn: number; readonly step: number; readonly index: number; readonly texts: readonly string[] }
} | {
  readonly type: 'chunkrow/tool-call-chunks'
  readonly seq: number
  readonly time: number
  readonly data: { readonly turn: number; readonly step: number; readonly index: number; readonly args: readonly unknown[] }
}

type CompatibleSessionEventLike = SessionEventLike | LegacyAssistantChunkEvent | CompatibleAssistantLiveChunkEvent | LegacyChunkRowEvent

// Official DSH contracts verified against 0.1.5-rc.2 (fb2c4b9e) and
// 0.1.6-alpha.1 (0a15e36e).
export type CodexProcessPhase = 'commentary' | 'final_answer'
export type CodexProcessStatus = 'running' | 'completed' | 'error'
export type CodexProcessTakeoverReason =
  | 'unowned-turn' | 'no-visible-content' | 'foreign-provider' | 'unowned-step'
  | 'unsupported-tool' | 'unsupported-content' | 'orphan-tool-result' | 'legacy-no-presentation'

export interface CodexPresentationBlock {
  readonly index: number
  readonly itemId: string
  readonly phase?: CodexProcessPhase | null
}

export interface CodexPresentation {
  readonly version: 1
  readonly blocks: readonly CodexPresentationBlock[]
}

export interface CodexProcessSegment {
  readonly key: string
  readonly seq: number
  readonly visibleSeq?: number
  readonly step: number
  readonly kind: 'text' | 'reasoning' | 'image' | 'activity'
  readonly index?: number
  readonly text?: string
  readonly attachment?: ImageBlock['attachment']
  readonly phase?: CodexProcessPhase
  readonly itemId?: string
  readonly activity?: CodexActivityData
  readonly activityPhase?: CodexActivityEventData['phase']
  readonly id?: string
  readonly callId?: string
  /** Only tool/call supplies native renderer dispatch identity; checkpoints do not. */
  readonly nativeCallSeq?: number
  readonly messageId?: string
  readonly threadId?: string
  readonly turnId?: string
  readonly name?: string
  readonly argsRaw?: string
  readonly settled?: boolean
}

export interface CodexProcessState {
  readonly turn: number
  readonly owned: boolean
  readonly ownedSteps: readonly number[]
  readonly foreignSteps: readonly number[]
  /** Ownership is provenance only. Native-row suppression must require takeoverSafe. */
  readonly takeoverSafe: boolean
  readonly takeoverReasons: readonly CodexProcessTakeoverReason[]
  readonly unsupportedToolSeq?: number
  readonly unsupportedContentSeq?: number
  readonly orphanResultSeq?: number
  readonly startedAt: number
  readonly endedAt?: number
  readonly status: CodexProcessStatus
  readonly segments: readonly CodexProcessSegment[]
  readonly firstVisibleSeq?: number
  readonly lastSeq?: number
  readonly endReason?: TurnEndReason
  readonly error?: string
  readonly stepErrors?: Readonly<Record<number, string>>
  readonly presentations: Readonly<Record<number, CodexPresentation>>
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationTurnDataMap {
    'relay-codex-process': CodexProcessState
  }
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    'relay-codex-process': CodexProcessState
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

/** Read the same opaque response metadata from a finish or persisted model source. */
export function readCodexPresentation(replayState: unknown): CodexPresentation | undefined {
  const value = record(record(record(replayState)?.response)?.codexPresentation)
  if (value?.version !== 1 || !Array.isArray(value.blocks)) return undefined
  const blocks: CodexPresentationBlock[] = []
  const seen = new Set<number>()
  for (const candidate of value.blocks) {
    const block = record(candidate)
    if (!block || typeof block.index !== 'number' || !Number.isSafeInteger(block.index)
      || block.index < 0 || typeof block.itemId !== 'string' || seen.has(block.index)) continue
    seen.add(block.index)
    blocks.push({
      index: block.index, itemId: block.itemId,
      ...block.phase === 'commentary' || block.phase === 'final_answer' ? { phase: block.phase } : {},
    })
  }
  return { version: 1, blocks }
}

function activityArguments(args: string): CodexActivityEventData | null {
  try { return readActivityPayload(JSON.parse(args)) } catch { return null }
}

export function initialCodexProcessState(turn: number, startedAt: number): CodexProcessState {
  return withTakeoverSafety({ turn, owned: false, ownedSteps: [], foreignSteps: [], startedAt,
    takeoverSafe: false, takeoverReasons: [], status: 'running', segments: [], presentations: {} })
}

function visible(segment: CodexProcessSegment): boolean {
  return segment.kind === 'activity' || segment.attachment !== undefined || Boolean(segment.text?.trim())
}

function withTakeoverSafety(state: CodexProcessState): CodexProcessState {
  const takeoverReasons: CodexProcessTakeoverReason[] = []
  if (!state.owned) takeoverReasons.push('unowned-turn')
  if (state.firstVisibleSeq === undefined) takeoverReasons.push('no-visible-content')
  if (state.foreignSteps.length) takeoverReasons.push('foreign-provider')
  if (state.segments.some(segment => visible(segment) && !state.ownedSteps.includes(segment.step))) takeoverReasons.push('unowned-step')
  if (state.unsupportedToolSeq !== undefined) takeoverReasons.push('unsupported-tool')
  if (state.unsupportedContentSeq !== undefined) takeoverReasons.push('unsupported-content')
  if (state.orphanResultSeq !== undefined) takeoverReasons.push('orphan-tool-result')
  // Unlocated legacy relay-codex/activity events never enter this turn's matches.
  // Keep old text-only projections native so their final text cannot jump ahead
  // of legacy activity rows. Mixed native/legacy rows remain undetectable here;
  // the UI must check the session's legacy nodes before mounting/suppressing.
  // Activity-backed failures remain eligible even when finish lacks metadata.
  if (state.owned && Object.keys(state.presentations).length === 0
    && !state.segments.some(segment => segment.kind === 'activity')) {
    takeoverReasons.push('legacy-no-presentation')
  }
  return { ...state, takeoverSafe: takeoverReasons.length === 0, takeoverReasons }
}

/** Also require a visible, mounted process node before suppressing any native row. */
export function canTakeOverCodexProcess(state: CodexProcessState | undefined | null): boolean {
  return state?.owned === true && state.takeoverSafe === true && state.firstVisibleSeq !== undefined
}

function unsupportedTool(state: CodexProcessState, seq: number): CodexProcessState {
  return { ...state, unsupportedToolSeq: state.unsupportedToolSeq ?? seq }
}

function firstVisible(segments: readonly CodexProcessSegment[], steps: readonly number[]): number | undefined {
  return segments.filter(segment => steps.includes(segment.step) && visible(segment))
    .reduce<number | undefined>((seq, segment) => Math.min(seq ?? Infinity, segment.visibleSeq ?? segment.seq), undefined)
}

function ownStep(state: CodexProcessState, step: number): CodexProcessState {
  if (state.foreignSteps.includes(step) || state.ownedSteps.includes(step)) return state
  const ownedSteps = [...state.ownedSteps, step]
  return { ...state, owned: true, ownedSteps, firstVisibleSeq: firstVisible(state.segments, ownedSteps),
    ...state.stepErrors?.[step] ? { status: 'error', error: state.stepErrors[step] } : {},
  }
}

function putSegment(state: CodexProcessState, segment: CodexProcessSegment, visibleSeq: number): CodexProcessState {
  const index = state.segments.findIndex(value => value.key === segment.key)
  const segments = [...state.segments]
  const next = { ...segment, ...visible(segment) ? { visibleSeq: segment.visibleSeq ?? visibleSeq } : {} }
  if (index < 0) segments.push(next)
  else segments[index] = next
  return {
    ...state, segments,
    firstVisibleSeq: firstVisible(segments, state.ownedSteps),
  }
}

function present(state: CodexProcessState, step: number, presentation: CodexPresentation | undefined): CodexProcessState {
  if (!presentation) return state
  const mapping = new Map(presentation.blocks.map(block => [block.index, block]))
  return {
    ...state,
    presentations: { ...state.presentations, [step]: presentation },
    segments: state.segments.map(segment => {
      const block = segment.step === step && segment.index !== undefined ? mapping.get(segment.index) : undefined
      return block ? { ...segment, itemId: block.itemId, phase: block.phase ?? undefined } : segment
    }),
  }
}

function blockSegment(
  state: CodexProcessState, step: number, index: number, seq: number,
  block: ContentBlock, settled: boolean,
): CodexProcessState {
  if (state.foreignSteps.includes(step)) return state
  if (block.type !== 'text' && block.type !== 'reasoning' && block.type !== 'image') return state
  const key = `block:${step}:${index}`
  const previous = state.segments.find(segment => segment.key === key)
  const mapping = state.presentations[step]?.blocks.find(value => value.index === index)
  return putSegment(state, {
    ...previous, key, seq: previous?.seq ?? seq, step, index, kind: block.type, settled,
    ...block.type === 'image' ? { attachment: block.attachment } : { text: block.text },
    ...mapping ? { itemId: mapping.itemId, phase: mapping.phase ?? undefined } : {},
  }, seq)
}

function upsertActivity(
  state: CodexProcessState, step: number, seq: number, payload: CodexActivityEventData,
  details: { callId: string; argsRaw?: string; messageId?: string; isError?: boolean; nativeCallSeq?: number },
): CodexProcessState {
  if (state.foreignSteps.includes(step)) return state
  const key = `activity:${JSON.stringify([payload.threadId, payload.turnId, payload.itemId])}`
  const previous = state.segments.find(segment => segment.key === key)
  const completed = payload.phase === 'completed' || details.isError === true
  // Repeated synthetic requests and late start notifications cannot reopen a result.
  if (previous?.settled && !completed) return ownStep(state, step)
  const status = details.isError ? 'error' : completed && payload.activity.status === 'running'
    ? 'completed' : payload.activity.status
  return putSegment(ownStep(state, step), {
    ...previous, key, seq: previous?.seq ?? seq, step: previous?.step ?? step, kind: 'activity',
    id: payload.itemId, itemId: payload.itemId, threadId: payload.threadId, turnId: payload.turnId,
    callId: details.callId, name: CODEX_ACTIVITY_TOOL,
    ...details.nativeCallSeq === undefined ? {} : { nativeCallSeq: details.nativeCallSeq },
    ...details.argsRaw === undefined ? {} : { argsRaw: details.argsRaw },
    ...details.messageId === undefined ? {} : { messageId: details.messageId },
    activityPhase: completed ? 'completed' : payload.phase,
    activity: {
      ...previous?.activity, ...payload.activity, status,
      provenance: { threadId: payload.threadId, turnId: payload.turnId },
    },
    settled: completed,
  }, seq)
}

function closeProcess(state: CodexProcessState, time: number, reason: TurnEndReason): CodexProcessState {
  const segments = state.segments.map(segment => segment.kind === 'activity' && !segment.settled
    ? { ...segment, settled: true, activityPhase: 'completed' as const,
        activity: segment.activity && { ...segment.activity, status: 'error' as const } }
    : segment)
  return {
    ...state, endedAt: time, endReason: reason, segments,
    status: reason.kind !== 'completed' || state.status === 'error' ? 'error' : 'completed',
    ...reason.kind === 'error' ? { error: reason.error.message } : {},
  }
}

function stepFailure(state: CodexProcessState, step: number, error: string): CodexProcessState {
  return { ...state, stepErrors: { ...state.stepErrors, [step]: error },
    ...state.ownedSteps.includes(step) ? { status: 'error', error } : {},
    segments: state.segments.map(segment => segment.step === step && segment.kind === 'activity' && !segment.settled
      ? { ...segment, settled: true, activityPhase: 'completed',
          activity: segment.activity && { ...segment.activity, status: 'error' } }
      : segment),
  }
}

function sameBlock(segment: CodexProcessSegment, block: ContentBlock): boolean {
  if (segment.kind !== block.type) return false
  if (block.type === 'text' || block.type === 'reasoning') return segment.text === block.text
  return block.type === 'image' && segment.attachment?.attachmentId === block.attachment.attachmentId
}

function assistantMessage(state: CodexProcessState, event: SessionEvent<'assistant/message'>): CodexProcessState {
  const { message, step } = event.data
  if (message.source.provider !== 'relay-codex') {
    const ownedSteps = state.ownedSteps.filter(value => value !== step)
    const segments = state.segments.filter(segment => segment.step !== step)
    const { [step]: _removed, ...presentations } = state.presentations
    const { [step]: _failure, ...stepErrors } = state.stepErrors ?? {}
    const error = ownedSteps.map(value => stepErrors[value]).filter(Boolean).at(-1)
    return { ...state, ownedSteps, owned: ownedSteps.length > 0, segments, presentations,
      ...state.stepErrors ? { stepErrors } : {},
      ...state.endedAt === undefined ? { status: error ? 'error' : 'running', error } : {},
      foreignSteps: state.foreignSteps.includes(step) ? state.foreignSteps : [...state.foreignSteps, step],
      firstVisibleSeq: firstVisible(segments, ownedSteps) }
  }
  if (state.foreignSteps.includes(step)) return state
  let next = present(ownStep(state, step), step, readCodexPresentation(message.source.replayState))
  const blocks = next.segments.filter(segment => segment.step === step && segment.kind !== 'activity')
  const used = new Set<string>()
  let textPosition = 0
  // Final content is the step aggregate, not another paragraph after the stream.
  // Prefer exact content/identity before positional matching (indexes may be sparse).
  for (const [position, block] of message.content.entries()) {
    if (block.type === 'tool-call') {
      const payload = block.name === CODEX_ACTIVITY_TOOL ? activityArguments(block.arguments) : null
      if (payload) next = upsertActivity(next, step, event.seq, payload, { callId: block.id, argsRaw: block.arguments })
      else next = unsupportedTool(next, event.seq)
      continue
    }
    if (block.type !== 'text' && block.type !== 'reasoning' && block.type !== 'image') {
      next = { ...next, unsupportedContentSeq: next.unsupportedContentSeq ?? event.seq }
      continue
    }
    const mapping = block.type === 'image' ? undefined : next.presentations[step]?.blocks[textPosition++]
    let previous = blocks.find(segment => !used.has(segment.key) && sameBlock(segment, block))
    previous ??= blocks.find(segment => !used.has(segment.key) && segment.index === mapping?.index && segment.kind === block.type)
    previous ??= blocks.find(segment => !used.has(segment.key) && segment.index === position && segment.kind === block.type)
    previous ??= blocks.find(segment => !used.has(segment.key) && segment.kind === block.type)
    let index = previous?.index ?? mapping?.index ?? position
    // An incomplete window may contain only a later block at this dense position.
    if (!previous && (used.has(`block:${step}:${index}`) || next.segments.some(segment => segment.key === `block:${step}:${index}`))) {
      index = Math.max(index, ...next.segments.filter(segment => segment.step === step).map(segment => segment.index ?? -1)) + 1
    }
    used.add(`block:${step}:${index}`)
    next = blockSegment(next, step, index, event.seq, block, true)
  }
  return event.data.interrupted ? stepFailure(next, step, next.stepErrors?.[step] ?? 'Interrupted') : next
}

/** Pure ordered fold; no changes to native events, messages, blocks, or attachments. */
export function reduceCodexProcess(state: CodexProcessState, event: CompatibleSessionEventLike): CodexProcessState {
  const next = foldCodexProcess(state, event)
  return next === state ? state : withTakeoverSafety(next)
}

function foldCodexProcess(state: CodexProcessState, event: CompatibleSessionEventLike): CodexProcessState {
  const matched = codexProcessDefinition.match(event as SessionEventLike)
  if (event.type === 'chunkrow/text-chunks' || event.type === 'chunkrow/reasoning-chunks'
    || event.type === 'chunkrow/tool-call-chunks') {
    if (!matched || matched.id !== String(state.turn)) return state
    const count = event.type === 'chunkrow/tool-call-chunks' ? event.data.args.length : event.data.texts.length
    const offset = Math.max(0, (state.lastSeq ?? (event.seq - 1)) - event.seq + 1)
    if (offset >= count) return state
    const next = { ...state, lastSeq: event.seq + count - 1 }
    if (state.foreignSteps.includes(event.data.step)) return next
    if (event.type === 'chunkrow/tool-call-chunks') return unsupportedTool(next, event.seq + offset)
    const { step, index } = event.data
    const previous = state.segments.find(segment => segment.key === `block:${step}:${index}`)
    if (previous?.settled) return next
    const texts = event.data.texts.slice(offset)
    const firstVisibleOffset = texts.findIndex(text => text.trim() !== '')
    const updated = blockSegment(next, step, index, event.seq + offset, {
      type: event.type === 'chunkrow/text-chunks' ? 'text' : 'reasoning',
      text: (previous?.text ?? '') + texts.join(''),
    }, false)
    // Keep the original first visible token's sequence for native-row ordering.
    if (previous?.visibleSeq !== undefined || firstVisibleOffset <= 0) return updated
    const segments = updated.segments.map(segment => segment.key === `block:${step}:${index}`
      ? { ...segment, visibleSeq: event.seq + offset + firstVisibleOffset } : segment)
    return { ...updated, segments, firstVisibleSeq: firstVisible(segments, updated.ownedSteps) }
  }
  if (!matched || matched.id !== String(state.turn) || (state.lastSeq !== undefined && event.seq <= state.lastSeq)) return state
  let next: CodexProcessState = { ...state, lastSeq: event.seq }
  switch (event.type) {
    case 'turn/start': return { ...next, startedAt: event.time }
    case 'turn/end': return closeProcess(next, event.time, event.data.reason)
    case 'assistant/message': return assistantMessage(next, event)
    case 'tool/call': {
      const payload = event.data.name === CODEX_ACTIVITY_TOOL ? activityArguments(event.data.arguments) : null
      return payload ? upsertActivity(next, event.data.step, event.seq, payload, {
        callId: event.data.callId, argsRaw: event.data.arguments, nativeCallSeq: event.seq,
      }) : unsupportedTool(next, event.seq)
    }
    case 'tool/result': {
      const result = event.data.message.content[0]
      const callId = event.data.message.source.callId
      const previous = next.segments.find(segment => segment.kind === 'activity' && segment.callId === callId)
      const payload = readActivityPayload(record(event.data.meta)?.codexActivity)
      // A metadata-only result still renders natively under key ''. Without the
      // actual call, the Codex-specific wrapper cannot suppress that native row.
      // Keep this window unsafe; prepend replays with the earlier call evidence.
      // The official tool reducer also loses call identity on a second result.
      if ((payload || previous?.activity) && (previous?.nativeCallSeq === undefined
        || previous.messageId !== undefined || result.toolCallId !== callId)) {
        next = { ...next, orphanResultSeq: next.orphanResultSeq ?? event.seq }
      }
      const isError = result.isError === true || event.data.error !== undefined
      if (payload) return upsertActivity(next, event.data.step, event.seq, { ...payload, phase: 'completed' }, {
        callId, isError, messageId: event.data.message.id,
      })
      if (!previous?.activity) return unsupportedTool(next, event.seq)
      return putSegment(next, {
        ...previous, settled: true, activityPhase: 'completed', messageId: event.data.message.id,
        activity: { ...previous.activity, status: isError ? 'error' : 'completed' },
      }, event.seq)
    }
    case 'assistant/chunk':
    case 'assistant/live-chunk': {
      const { step, chunk } = event.data
      if (state.foreignSteps.includes(step)) return next
      if (chunk.type === 'finish') {
        next = present(next, step, readCodexPresentation(chunk.replayState))
        return chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted'
          ? stepFailure(next, step, chunk.reason.failure.message) : next
      }
      if (chunk.type === 'usage') return next
      // Streamed tool blocks are not represented by this projection. Native
      // relay activity envelopes are supported separately; do not hide other tools.
      if (chunk.type === 'tool-call-delta'
        || (chunk.type === 'block-start' && chunk.blockType === 'tool-call')
        || (chunk.type === 'block-end' && chunk.block.type === 'tool-call')) return unsupportedTool(next, event.seq)
      if ((chunk.type === 'block-start' && chunk.blockType !== 'text' && chunk.blockType !== 'reasoning' && chunk.blockType !== 'image')
        || (chunk.type === 'block-end' && chunk.block.type !== 'text' && chunk.block.type !== 'reasoning' && chunk.block.type !== 'image')) {
        return { ...next, unsupportedContentSeq: next.unsupportedContentSeq ?? event.seq }
      }
      const previous = next.segments.find(segment => segment.key === `block:${step}:${chunk.index}`)
      if (previous?.settled) return next
      if (chunk.type === 'block-start') {
        if (previous || (chunk.blockType !== 'text' && chunk.blockType !== 'reasoning')) return next
        return blockSegment(next, step, chunk.index, event.seq, { type: chunk.blockType, text: '' }, false)
      }
      if (chunk.type === 'block-end') return blockSegment(next, step, chunk.index, event.seq, chunk.block, true)
      return blockSegment(next, step, chunk.index, event.seq, {
        type: chunk.type === 'text-delta' ? 'text' : 'reasoning', text: (previous?.text ?? '') + chunk.text,
      }, false)
    }
    default: return next
  }
}

/** Rebuild a window without requiring its turn/start to have been loaded. */
export function replayCodexProcess(events: readonly CompatibleSessionEventLike[]): CodexProcessState | undefined {
  let state: CodexProcessState | undefined
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    const match = codexProcessDefinition.match(event as SessionEventLike)
    if (!match) continue
    state ??= initialCodexProcessState(Number(match.id), event.time)
    state = reduceCodexProcess(state, event)
  }
  return state
}

export function projectCodexProcess(context: ConversationNodeContext<CodexProcessState>): CodexProcessState | undefined {
  let state = context.state ?? replayCodexProcess(context.matches.map(match => match.event))
  if (!state) return undefined
  const location = context.start?.location ?? context.matches.find(match => match.location.kind === 'turn' || match.location.kind === 'step')?.location
  if (location?.kind === 'turn' || location?.kind === 'step') {
    if (location.turn.start && state.startedAt !== location.turn.start.time) state = { ...state, startedAt: location.turn.start.time }
    if (state.endedAt === undefined && location.turn.end) state = closeProcess(state, location.turn.end.time, location.turn.end.data.reason)
  }
  // Evaluate before filtering: unproven visible steps are still native rows and
  // cannot be crossed by a turn-wide node anchored at the first Codex segment.
  state = withTakeoverSafety(state)
  const segments = state.segments.filter(segment => state.ownedSteps.includes(segment.step))
  return segments.length === state.segments.length ? state : { ...state, segments }
}

/**
 * Legacy completed turns have no phase contract: their last nonempty text may
 * serve as the answer. This does not assign final_answer or remove any segment;
 * in particular a sole text remains available to render. Metadata disables guessing.
 */
export function codexProcessAnswerSegments(state: CodexProcessState): readonly CodexProcessSegment[] {
  const text = state.segments.filter(segment => segment.kind === 'text' && visible(segment))
  const explicit = text.filter(segment => segment.phase === 'final_answer')
  if (explicit.length || Object.keys(state.presentations).length || state.status !== 'completed') return explicit
  const last = text.at(-1)
  return last ? [last] : []
}

export const codexProcessDefinition: ConversationNodeDefinition<CodexProcessState> = {
  kind: 'relay-codex-process',
  target: 'chat',
  match: currentEvent => {
    const event = currentEvent as CompatibleSessionEventLike
    if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
    if (event.type === 'turn/end' || event.type === 'assistant/chunk' || event.type === 'assistant/live-chunk' || event.type === 'assistant/message'
      || event.type === 'tool/result' || event.type === 'tool/call'
      || event.type === 'chunkrow/text-chunks' || event.type === 'chunkrow/reasoning-chunks'
      || event.type === 'chunkrow/tool-call-chunks') {
      if ((event.type === 'assistant/message' || event.type === 'tool/result')
        && event.surfaceOp !== undefined && event.surfaceOp !== 'append') return null
      return { id: String(event.data.turn), role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'turn/start') throw new Error('relay-codex-process start requires turn/start')
    return reduceCodexProcess(initialCodexProcessState(match.event.data.turn, match.event.time), match.event)
  },
  update: (context, match) => reduceCodexProcess(context.state, match.event),
  publication: (match: ConversationMatch) => {
    const event = match.event as CompatibleSessionEventLike
    if (event.type === 'turn/start') return 'none'
    if (event.type.startsWith('chunkrow/')) return 'animation-frame'
    if (event.type !== 'assistant/chunk' && event.type !== 'assistant/live-chunk') return 'immediate'
    const type = event.data.chunk.type
    if (type === 'usage') return 'none'
    return type === 'text-delta' || type === 'reasoning-delta' || type === 'tool-call-delta' ? 'animation-frame' : 'immediate'
  },
  buildLocationData: (context, scope) => {
    if (scope !== 'turn') return null
    const state = projectCodexProcess(context)
    return state?.owned ? { kind: 'turn', turn: state.turn, key: 'relay-codex-process', value: state } : null
  },
  buildViewNode: (context): ChatConversationViewNode | null => {
    const state = projectCodexProcess(context)
    if (!state || !canTakeOverCodexProcess(state)) {
      const previous = context.current.get('chat') as ChatConversationViewNode | null | undefined
      return previous ? { ...previous, visibility: 'hidden', data: state ?? previous.data } : null
    }
    return {
      key: context.key, kind: 'relay-codex-process', id: context.id, target: 'chat',
      anchorSeq: state.firstVisibleSeq!,
      location: context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' },
      visibility: 'visible', data: state,
    }
  },
}
