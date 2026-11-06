// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import type { ComponentType } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import type { ConversationNodeContext } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { CodexProcessSegment, CodexProcessState } from '../src/client/codex-process.ts'

const { markdown } = vi.hoisted(() => ({ markdown: vi.fn(({text}: {text: string}) => <p>{text}</p>) }))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  MarkdownText: markdown, DisclosureRow: () => null, localFileLinks: () => [],
}))
import { codexProcessDefinition, initialCodexProcessState } from '../src/client/codex-process.ts'
import { installProcessPresentation } from '../src/client/process-presentation.tsx'

afterEach(() => { cleanup(); markdown.mockClear() })

function setup(projectAssistantText?: (sessionId: string | undefined, turn: number, text: string) => string) {
  let definition = codexProcessDefinition
  let Renderer: ComponentType<any> | undefined
  const policy = { subscribe: () => () => {}, hideToolRows: () => false, projectAssistantText }
  const events = { register(next: typeof definition) { definition = next }, registerDisplayProjection() { return () => {} } }
  const slots = {
    inject(_name: string, install: () => unknown) { install() },
    register(options: {key: string}, component: ComponentType<any>) {
      if (options.key === 'relay-codex-process') Renderer = component
      return () => {}
    },
    entries: () => [], subscribe: () => () => {},
  }
  const ctx = { get: (name: string) => name === 'uiConversation' ? { events } : policy,
    on: () => () => {}, slots } as never
  installProcessPresentation(ctx, { getSnapshot: () => false, subscribe: () => () => {} })
  return {
    publish(raw: string, sessionId = 'home', status: 'running' | 'completed' = 'running') {
      // A provider item boundary can divide the opening tag. The installed
      // definition must project the cumulative text before either item paints.
      const split = Math.min(raw.length, 'Public <noteb'.length)
      const text = (key: string, value: string): CodexProcessSegment => ({ key, seq: 1, step: 1,
        kind: 'text', text: value, phase: 'final_answer', settled: status === 'completed' })
      const state: CodexProcessState = { ...initialCodexProcessState(4, 100), owned: true, ownedSteps: [1],
        firstVisibleSeq: 1, segments: [text('one', raw.slice(0, split)), text('two', raw.slice(split))], status,
        presentations: { 1: { version: 1, blocks: [{ index: 0, itemId: 'answer', phase: 'final_answer' }] } } }
      const context = { sessionId, key: 'turn', kind: 'relay-codex-process', id: '4', matches: [],
        state, current: new Map() } as unknown as ConversationNodeContext<CodexProcessState>
      const location = definition.buildLocationData!(context, 'turn', null)!
      const node = definition.buildViewNode!(context)!
      const props = { node, sessionId, renderFactorySlot: () => null, loadImage: async () => '',
        useTurnData: () => undefined, useChat: (select: (value: unknown) => unknown) => select({ nodes: new Map() }),
        useSession: () => undefined, openFile() {}, fileMentions: () => undefined }
      const Component = Renderer!
      return { element: <Component {...props} />, context, location, node }
    },
  }
}

test.each([
  '<notebook>PRIVATE_NOTEBOOK_BODY</notebook>',
  '<notebook-edit><old>PRIVATE_OLD_ANCHOR</old><new>PRIVATE_NEW_VALUE</new></notebook-edit>',
])('the installed grouped renderer discloses no private live prefix or history: %s', block => {
  // Reproduce the released client path: its definition published raw segments,
  // and CodexProcessView passed them directly to MarkdownText independently of
  // the host's native assistant-step renderer.
  const raw = `Public ${block}`
  const old = setup().publish(raw)
  const previous = render(old.element)
  expect(previous.container.textContent).toContain('PRIVATE_')
  expect(markdown.mock.calls.some(([props]) => props.text.includes('PRIVATE_'))).toBe(true)
  previous.unmount(); markdown.mockClear()

  const host = vi.fn((sessionId: string | undefined, turn: number, text: string) =>
    sessionId === 'home' && turn === 4 ? (text.length > raw.length ? 'Public  ending' : 'Public ') : text)
  const current = setup(host)
  const first = current.publish('Public ')
  const view = render(first.element)
  for (let end = 1; end <= block.length; end++) {
    const prefix = `Public ${block.slice(0, end)}`
    const published = current.publish(prefix)
    view.rerender(published.element)
    expect(view.container.textContent).toBe('Public ')
    expect(markdown.mock.calls.every(([props]) => !props.text.includes('<') && !props.text.includes('PRIVATE_'))).toBe(true)
    expect(host).toHaveBeenCalledWith('home', 4, prefix)
    expect(published.context.state.segments.map(segment => segment.text).join('')).toBe(prefix)
  }
  const history = current.publish(`${raw} ending`, 'home', 'completed')
  view.rerender(history.element)
  expect(view.container.textContent).toBe('Public  ending')
  expect((history.location.value as CodexProcessState).segments.map(segment => segment.text).join('')).toBe('Public  ending')

  // The same installed slot leaves an ordinary conversation's literal text alone.
  const ordinary = current.publish(raw, 'ordinary', 'completed')
  view.rerender(ordinary.element)
  expect(view.container.textContent).toBe(raw)
})
