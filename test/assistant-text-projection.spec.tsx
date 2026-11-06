import { expect, test, vi } from 'vitest'
import type { ConversationNodeContext } from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  codexProcessAnswerSegments, createCodexProcessDefinition, initialCodexProcessState, projectCodexProcess,
  type AssistantTextProjection, type CodexProcessSegment, type CodexProcessState,
} from '../src/client/codex-process.ts'

function context(segments: readonly CodexProcessSegment[], sessionId: string | undefined = 'home', status: 'running' | 'completed' = 'completed') {
  const state: CodexProcessState = { ...initialCodexProcessState(4, 1000), owned: true, ownedSteps: [1],
    status, firstVisibleSeq: 1, segments,
    presentations: { 1: { version: 1, blocks: [{ index: 0, itemId: 'answer', phase: 'final_answer' }] } },
  }
  Object.freeze(state); for (const segment of segments) Object.freeze(segment)
  return { key: 'process', kind: 'relay-codex-process', id: '4', matches: [], start: undefined,
    state, current: new Map(), sessionId } as ConversationNodeContext<CodexProcessState> & { sessionId?: string }
}
const text = (key: string, value: string): CodexProcessSegment => ({ key, seq: 1, step: 1, kind: 'text', text: value, phase: 'final_answer' })
const visible = (state: CodexProcessState | undefined) => state?.segments.filter(segment => segment.kind === 'text').map(segment => segment.text ?? '').join('')

test.each([
  ['<note', 'book>private memory</notebook>'],
  ['<notebook-ed', 'it><old>pending</old><new>done</new></notebook-edit>'],
])('host disclosure spans provider items split at %s without rewriting raw state', (opening, remainder) => {
  const first = `Public ${opening}`, second = `${remainder} visible ending`
  // The host owns the protocol parser. Relay receives only its disclosed
  // prefixes and must distribute them over the provider's separate items.
  const disclosures = new Map([[first, 'Public '], [first + second, 'Public  visible ending']])
  const project: AssistantTextProjection = (sessionId, turn, raw) => sessionId === 'home' && turn === 4
    ? disclosures.get(raw) ?? '' : raw
  const input = context([text('one', first), text('two', second)])
  const before = JSON.stringify(input.state)
  const definition = createCodexProcessDefinition(project)
  const location = definition.buildLocationData!(input, 'turn', null)!
  const node = definition.buildViewNode!(input)!
  expect(visible(location.value as CodexProcessState)).toBe('Public  visible ending')
  expect(visible(node.data as CodexProcessState)).toBe('Public  visible ending')
  expect(codexProcessAnswerSegments(node.data as CodexProcessState).map(segment => segment.text).join('')).toBe('Public  visible ending')
  expect(JSON.stringify(input.state)).toBe(before)
  expect(visible(input.state)).toContain(opening)
})

test.each(['<notebook>private memory</notebook>', '<notebook-edit><old>old</old><new>new</new></notebook-edit>'])('every live prefix delegates to host disclosure: %s', block => {
  for (let end = 1; end <= block.length; end++) {
    const raw = `Public ${block.slice(0, end)}`
    const project = vi.fn((_id: string | undefined, _turn: number, _raw: string) => 'Public ')
    const input = context([text('live', raw)], 'home', 'running')
    expect(visible(projectCodexProcess(input, project))).toBe('Public ')
    expect(project).toHaveBeenCalledWith('home', 4, raw)
    expect(visible(input.state)).toBe(raw)
  }
})

test('ordinary turns and hosts without a disclosure policy retain exact text; missing scope is passed through explicitly', () => {
  const raw = 'Literal <notebook>ordinary text</notebook>'
  const input = context([text('ordinary', raw)], 'ordinary')
  const project: AssistantTextProjection = (id, _turn, value) => id === undefined || id === 'home' ? '' : value
  expect(visible(projectCodexProcess(input))).toBe(raw)
  expect(visible(projectCodexProcess(input, project))).toBe(raw)
  const missing = context([text('unknown', raw)], undefined)
  // A missing owner is never replaced by whichever session is selected now.
  delete missing.sessionId
  expect(visible(projectCodexProcess(missing, project))).toBe('')
})

test('a metadata invalidation can disclose a completed turn again from its untouched raw context', () => {
  const raw = 'Public <notebook>private memory</notebook>'
  let disclosure: 'pending' | 'home' | 'ordinary' = 'pending'
  const project: AssistantTextProjection = (_id, _turn, value) => disclosure === 'pending' ? '' : disclosure === 'home' ? 'Public ' : value
  const definition = createCodexProcessDefinition(project), input = context([text('answer', raw)])
  expect(visible(definition.buildViewNode!(input)!.data as CodexProcessState)).toBe('')
  disclosure = 'home'
  expect(visible(definition.buildLocationData!(input, 'turn', null)!.value as CodexProcessState)).toBe('Public ')
  expect(visible(definition.buildViewNode!(input)!.data as CodexProcessState)).toBe('Public ')
  disclosure = 'ordinary'
  expect(visible(definition.buildViewNode!(input)!.data as CodexProcessState)).toBe(raw)
  expect(visible(input.state)).toBe(raw)
})
