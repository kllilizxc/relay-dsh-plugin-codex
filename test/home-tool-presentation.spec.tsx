// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  MarkdownText: ({text}: {text: string}) => <p>{text}</p>,
  DisclosureRow: ({title}: {title: string}) => <div>{title}</div>,
  localFileLinks: () => [],
}))
import { ProcessBody } from '../src/client/CodexProcessView.tsx'
import { initialCodexProcessState, type CodexProcessSegment } from '../src/client/codex-process.ts'

afterEach(cleanup)
test('host policy hides only duplicate workbench groups while retaining live text and other tools', () => {
  const segments: CodexProcessSegment[] = [
    {key:'text', seq:1, step:1, kind:'text', text:'I will hand this off.', settled:false},
    {key:'handoff', seq:2, step:1, kind:'activity', activity:{type:'dynamicToolCall', title:'dsh / workbench', status:'running'}},
    {key:'other', seq:3, step:1, kind:'activity', activity:{type:'commandExecution', title:'Ran commands', status:'running'}},
  ]
  const state = {...initialCodexProcessState(1, Date.now()), segments}
  const slot = () => null
  const {rerender, container} = render(<ProcessBody state={state} renderFactorySlot={slot} loadImage={() => Promise.resolve('')} />)
  expect(container.querySelector('[data-codex-activity-group]')?.getAttribute('data-count')).toBe('2')
  expect(screen.getByText('I will hand this off.')).not.toBeNull()
  rerender(<ProcessBody state={state} renderFactorySlot={slot} loadImage={() => Promise.resolve('')} hideToolRows />)
  expect(container.querySelector('[data-codex-activity-group]')?.getAttribute('data-count')).toBe('1')
  expect(screen.getByText('I will hand this off.')).not.toBeNull()
})

test('optional host policy follows service arrival, changes and removal', async () => {
  const { conversationToolPresentation } = await import('../src/client/process-presentation.tsx')
  let service: { subscribe: (listener: () => void) => () => void; hideToolRows: (id: string) => boolean; projectAssistantText?: (id: string | undefined, turn: number, text: string) => string } | undefined
  let onService: ((name: string) => void) | undefined, onChange: (() => void) | undefined
  const ctx = { get: () => service, on: (_name: string, cb: (name: string) => void) => { onService = cb; return () => { onService = undefined } } } as never
  const policy = conversationToolPresentation(ctx), changed = vi.fn(), stop = policy.subscribe(changed)
  expect(policy.hideToolRows('home')).toBe(false)
  expect(policy.projectAssistantText?.('home', 1, 'private')).toBe('private')
  service = { subscribe: listener => { onChange = listener; return () => { onChange = undefined } }, hideToolRows: id => id === 'home',
    projectAssistantText: (id, _turn, text) => id === 'home' ? '' : text }
  onService?.('conversationToolPresentation')
  expect(policy.hideToolRows('home')).toBe(true)
  expect(policy.hideToolRows('other')).toBe(false)
  expect(policy.projectAssistantText?.('home', 1, 'private')).toBe('')
  expect(policy.projectAssistantText?.('other', 1, 'private')).toBe('private')
  onChange?.()
  expect(changed).toHaveBeenCalledTimes(2)
  service = undefined; onService?.('conversationToolPresentation')
  expect(policy.hideToolRows('home')).toBe(false)
  expect(policy.projectAssistantText?.('home', 1, 'private')).toBe('private')
  stop(); expect(onService).toBeUndefined()
})

test('late host policy invalidates existing grouped data through the shared display registry', async () => {
  const { installProcessPresentation } = await import('../src/client/process-presentation.tsx')
  let service: { subscribe(listener: () => void): () => void; hideToolRows(id: string): boolean; projectAssistantText(id: string | undefined, turn: number, text: string): string } | undefined
  let onService: ((name: string) => void) | undefined, stop: (() => void) | undefined
  const refreshed = vi.fn(), register = vi.fn()
  const events = { register, registerDisplayProjection(projection: { subscribe(listener: () => void): () => void }) {
    stop = projection.subscribe(refreshed); return stop
  } }
  const ctx = { get: (name: string) => name === 'uiConversation' ? { events } : service,
    on: (_name: string, listener: (name: string) => void) => { onService = listener; return () => { onService = undefined } },
    slots: { inject() {} } } as never
  installProcessPresentation(ctx, { getSnapshot: () => false, subscribe: () => () => {} })
  const state = { ...initialCodexProcessState(1, 100), owned: true, ownedSteps: [1], firstVisibleSeq: 1,
    segments: [{key:'text',seq:1,step:1,kind:'text',text:'Private payload'}],
    presentations: {1:{version:1,blocks:[{index:0,itemId:'answer',phase:'final_answer'}]}} }
  const context = { sessionId:'home',key:'turn',kind:'relay-codex-process',id:'1',state,matches:[],current:new Map() }
  const definition = register.mock.calls[0][0]
  expect(definition.buildLocationData(context, 'turn', null).value.segments[0].text).toBe('Private payload')
  service = { subscribe: () => () => {}, hideToolRows: () => false, projectAssistantText: () => '' }
  onService?.('conversationToolPresentation')
  expect(refreshed).toHaveBeenCalledOnce()
  expect(definition.buildLocationData(context, 'turn', null).value.segments[0].text).toBe('')
  expect(definition.buildViewNode(context).data.segments[0].text).toBe('')
  expect(context.state.segments[0].text).toBe('Private payload')
  stop?.()
})
