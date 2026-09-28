// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { Component, useSyncExternalStore } from 'react'
import type React from 'react'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { MarkdownFileMentions } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CodexActivityData } from '../src/client/codex-activity.ts'

const markdownProbe = vi.hoisted(() => vi.fn())


vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  MarkdownText: (props: { text: string; streaming?: boolean; fileMentions?: MarkdownFileMentions }) => {
    markdownProbe(props)
    const mention = props.fileMentions?.resolve(props.text)
    return <div data-testid="markdown" data-streaming={Boolean(props.streaming)}>
      {props.text}
      {mention && <button title={mention.title} onClick={mention.open}>{mention.label}</button>}
    </div>
  },
  DisclosureRow: ({ icon, title, open, expandable, onToggle, children, collapsedContent }: {
    icon?: React.ReactNode
    title: string
    open: boolean
    expandable?: boolean
    onToggle: () => void
    children?: React.ReactNode
    collapsedContent?: React.ReactNode
  }) => (
    <div>
      <button type="button" aria-expanded={open} disabled={!expandable} onClick={onToggle}>
        {icon}<span>{title}</span>{collapsedContent}
      </button>
      {open ? <div>{children}</div> : null}
    </div>
  ),
  StateDot: ({ state }: { state: string }) => <span data-testid="state-dot" data-state={state} />,
}))

const conversationContextKey = (kind: string, id: string) => `${kind}:${id}`
import { GroupedCodexToolActivityView } from '../src/client/CodexActivityView.tsx'
import { ActivityGroup, CodexProcessView, ProcessBody, groupProcessSegments } from '../src/client/CodexProcessView.tsx'
import { initialCodexProcessState, type CodexProcessSegment, type CodexProcessState } from '../src/client/codex-process.ts'

const startedAt = 1000
const renderImages = () => null
const useEmptySession: React.ComponentProps<typeof CodexProcessView>['useChat'] = selector =>
  selector({ nodes: new Map() } as never)

beforeEach(() => {
  markdownProbe.mockClear()
  vi.useFakeTimers()
  vi.setSystemTime(startedAt + 4000)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('groupProcessSegments', () => {
  it('groups ten consecutive tools without changing the source segments', () => {
    const segments = Object.freeze(Array.from({ length: 10 }, (_, index) => Object.freeze(tool(`tool-${index}`))))
    const before = JSON.stringify(segments)
    expect(groupProcessSegments(segments)).toEqual([{ key: 'tool-0', activities: segments }])
    expect(JSON.stringify(segments)).toBe(before)
  })

  it('does not split activities for interleaved reasoning or empty commentary', () => {
    const first = tool('first')
    const second = tool('second')
    const segments = [first, prose('thinking', 'Inspecting the code', 'reasoning'), prose('blank', ' \n '), second]
    expect(groupProcessSegments(segments)).toEqual([{ key: 'first', activities: [first, second] }])
  })

  it('preserves commentary and images as boundaries between activity groups', () => {
    const first = tool('first')
    const second = tool('second')
    const third = tool('third')
    const commentary = prose('commentary', 'I found the entry point.')
    const image: CodexProcessSegment = { key: 'image', seq: 4, step: 0, kind: 'image', attachment: attachment() }
    expect(groupProcessSegments([first, commentary, second, image, third])).toEqual([
      { key: 'first', activities: [first] }, commentary, { key: 'second', activities: [second] },
      image, { key: 'third', activities: [third] },
    ])
    expect(groupProcessSegments([])).toEqual([])
  })
})

describe('ActivityGroup', () => {
  it('renders ten tools as one collapsed summary and expands all children', () => {
    const segments = Array.from({ length: 10 }, (_, index) => tool(`tool-${index}`))
    const { container } = render(<ActivityGroup segments={segments} />)
    const groups = container.querySelectorAll('[data-codex-activity-group]')
    expect(groups).toHaveLength(1)
    expect(groups[0].getAttribute('data-count')).toBe('10')
    expect(screen.getAllByRole('button')).toHaveLength(1)
    const toggle = screen.getByRole('button', { name: 'Ran commands' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelectorAll('[data-codex-activity]')).toHaveLength(0)
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelectorAll('[data-codex-activity]')).toHaveLength(10)
    expect(screen.queryByLabelText('Running')).toBeNull()
    expect(screen.queryByTestId('state-dot')).toBeNull()
  })

  it('shows the latest currently running action, then summarizes completed work', () => {
    const read = tool('read', reading('running'))
    const run = tool('run', command('running'))
    const image = tool('image', { type: 'imageView', status: 'completed', title: 'Viewed an image' })
    const { rerender } = render(<ActivityGroup segments={[read, run, image]} />)
    let toggle = screen.getByRole('button', { name: /Running npm test/ })
    expect(toggle.getAttribute('title')).toBe('Running npm test')
    expect(toggle.querySelector('[data-activity-icon="command"]')).not.toBeNull()
    expect(screen.getByText('2 running')).not.toBeNull()
    expect(screen.getByLabelText('Running')).not.toBeNull()

    rerender(<ActivityGroup segments={[read, tool('run'), image]} />)
    toggle = screen.getByRole('button', { name: /Reading README.md/ })
    expect(toggle.querySelector('[data-activity-icon="read"]')).not.toBeNull()
    expect(screen.queryByText('2 running')).toBeNull()

    rerender(<ActivityGroup segments={[tool('read', reading('completed')), tool('run'), image]} />)
    expect(screen.getByRole('button', { name: 'Read a file, ran a command, viewed an image' })).not.toBeNull()
    expect(screen.queryByLabelText('Running')).toBeNull()
    expect(screen.queryByTestId('state-dot')).toBeNull()
  })

  it('retains group and child disclosure state as outputs arrive and calls settle', () => {
    const segment = tool('stable-read', reading('running'))
    const { rerender, container } = render(<ActivityGroup segments={[segment]} />)
    const group = screen.getByRole('button', { name: /Reading README.md/ })
    fireEvent.click(group)
    const childRoot = container.querySelector<HTMLElement>('[data-codex-activity]')!
    const child = within(childRoot).getByRole('button', { name: 'Reading README.md' })
    fireEvent.click(child)
    rerender(<ActivityGroup segments={[tool('stable-read', { ...reading('running'), output: 'Partial output' }), tool('next')]} />)
    expect(group.getAttribute('aria-expanded')).toBe('true')
    expect(child.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText(/Partial output/)).not.toBeNull()

    rerender(<ActivityGroup segments={[tool('stable-read', { ...reading('completed'), output: 'Final output', exitCode: '0' }), tool('next')]} />)
    expect(screen.getByRole('button', { name: 'Read a file, ran a command' })).toBe(group)
    expect(group.getAttribute('aria-expanded')).toBe('true')
    expect(within(childRoot).getByRole('button', { name: 'Read README.md' })).toBe(child)
    expect(child.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText(/Final output/)).not.toBeNull()
    expect(screen.queryByText(/Partial output/)).toBeNull()
  })

  it('reports failed work alongside running work and after the group settles', () => {
    const failed = tool('failed', command('error'))
    const { rerender, container } = render(<ActivityGroup segments={[failed, tool('running', command('running'))]} />)
    expect(screen.getByText('1 failed')).not.toBeNull()
    expect(screen.getByLabelText('Running')).not.toBeNull()
    rerender(<ActivityGroup segments={[failed, tool('running')]} />)
    const toggle = screen.getByRole('button', { name: /Failed to run a command, ran a command/ })
    expect(screen.getByLabelText('Failed')).not.toBeNull()
    expect(screen.queryByLabelText('Running')).toBeNull()
    fireEvent.click(toggle)
    const error = container.querySelector<HTMLElement>('[data-codex-activity][data-status="error"]')!
    expect(within(error).getByTestId('state-dot').getAttribute('data-state')).toBe('error')
    expect(within(error).getByRole('button', { name: 'Failed to run npm test' })).not.toBeNull()
  })

  it('keeps unknown activity categories visible and safely skips missing activity payloads', () => {
    const unknown = tool('unknown', { type: 'newActivity', status: 'completed', title: 'External task' })
    const { rerender, container } = render(<ActivityGroup segments={[{ ...tool('empty'), activity: undefined }, unknown]} />)
    expect(screen.getByRole('button', { name: 'External task' }).querySelector('[data-activity-icon="unknown"]')).not.toBeNull()
    expect(container.querySelector('[data-count="1"]')).not.toBeNull()
    rerender(<ActivityGroup segments={[]} />)
    expect(container.textContent).toBe('')
  })
})

describe('ProcessBody', () => {
  it('renders one activity group around reasoning and separates groups at commentary', () => {
    const state = processState([
      tool('one'), prose('thinking', 'Check the assumptions.', 'reasoning'), tool('two'),
      prose('commentary', 'The dependency is available.'), tool('three'),
    ])
    const { container } = render(<ProcessBody state={state} renderMessageImages={renderImages} />)
    expect([...container.querySelectorAll('[data-codex-activity-group]')].map(node => node.getAttribute('data-count'))).toEqual(['2', '1'])
    expect(screen.getByText('The dependency is available.').closest('[data-codex-commentary]')).not.toBeNull()
    expect(screen.queryByText('Check the assumptions.')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Thinking' }))
    expect(screen.getByText('Check the assumptions.')).not.toBeNull()
  })

  it('collapses prior work when a final answer arrives and preserves expanded descendants', () => {
    const segments = [prose('commentary', 'Checking the README.'), tool('read', reading('running'))]
    const { rerender, container } = render(<ProcessBody state={processState(segments)} renderMessageImages={renderImages} />)
    const group = screen.getByRole('button', { name: /Reading README.md/ })
    fireEvent.click(group)
    const child = within(container.querySelector<HTMLElement>('[data-codex-activity]')!).getByRole('button')
    fireEvent.click(child)
    const answer = { ...prose('answer', 'The implementation is ready.'), phase: 'final_answer' as const }
    const completed = processState([segments[0], tool('read', { ...reading('completed'), output: 'README result' }), answer], {
      status: 'completed', endedAt: startedAt + 6000,
    })
    rerender(<ProcessBody state={completed} renderMessageImages={renderImages} />)
    const toggle = screen.getByRole('button', { name: 'Worked for 6s' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('[data-codex-process-content]')?.hasAttribute('hidden')).toBe(true)
    expect(screen.queryByRole('button', { name: 'Read README.md' })).toBeNull()
    expect(screen.getByText('The implementation is ready.').closest('[data-codex-final-answer]')).not.toBeNull()
    fireEvent.click(toggle)
    expect(screen.getByRole('button', { name: 'Read a file' })).toBe(group)
    expect(group.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('button', { name: 'Read README.md' })).toBe(child)
    expect(child.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText(/README result/)).not.toBeNull()
    expect(screen.getAllByText('The implementation is ready.')).toHaveLength(1)
  })

  it('honors a user-expanded process when the final answer arrives', () => {
    const state = processState([tool('run')])
    const { rerender } = render(<ProcessBody state={state} renderMessageImages={renderImages} />)
    const toggle = screen.getByRole('button', { name: 'Working for 4s' })
    fireEvent.click(toggle)
    fireEvent.click(toggle)
    rerender(<ProcessBody state={{ ...state, status: 'completed', endedAt: startedAt + 4000,
      segments: [...state.segments, { ...prose('answer', 'Done.'), phase: 'final_answer' }],
    }} renderMessageImages={renderImages} />)
    expect(screen.getByRole('button', { name: 'Worked for 4s' }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('button', { name: 'Ran a command' })).not.toBeNull()
  })

  it('does not guess a final answer from running commentary or hide answer-only turns', () => {
    const text = prose('text', 'Checking the files.')
    const { rerender, container } = render(<ProcessBody state={processState([text])} renderMessageImages={renderImages} />)
    expect(container.querySelector('[data-codex-final-answer]')).toBeNull()
    expect(screen.getByRole('button', { name: 'Working for 4s' }).getAttribute('aria-expanded')).toBe('true')
    rerender(<ProcessBody state={processState([{ ...text, phase: 'final_answer' }], { status: 'completed' })} renderMessageImages={renderImages} />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText(text.text!).closest('[data-codex-final-answer]')).not.toBeNull()
  })

  it('renders image attachments through the supplied renderer, including after the final answer', () => {
    const image = attachment()
    const renderer = vi.fn<React.ComponentProps<typeof ProcessBody>['renderMessageImages']>(() => <img alt="Rendered attachment" />)
    const state = processState([
      tool('run'), { ...prose('answer', 'Here is the image.'), phase: 'final_answer' },
      { key: 'image', seq: 3, step: 0, kind: 'image', attachment: image },
    ], { status: 'completed' })
    render(<ProcessBody state={state} renderMessageImages={renderer} />)
    expect(renderer).toHaveBeenCalledWith({ images: [{ attachment: image }], align: 'start' })
    expect(renderer.mock.calls[0][0].images[0].attachment).toBe(image)
    expect(screen.getByRole('img', { name: 'Rendered attachment' }).closest('[data-codex-final-answer]')).not.toBeNull()
  })

  it('keeps images emitted before final text visible through collapse and reopening', () => {
    const image = attachment()
    const renderer = vi.fn<React.ComponentProps<typeof ProcessBody>['renderMessageImages']>(() => <img alt="Generated deliverable" />)
    const state = processState([
      tool('generate', { type: 'imageGeneration', title: 'Generated an image', status: 'completed' }),
      { key: 'image', seq: 2, step: 0, kind: 'image', attachment: image },
      { ...prose('answer', 'Here is your image.'), phase: 'final_answer' },
    ], { status: 'completed', endedAt: startedAt + 4000 })
    const { container } = render(<ProcessBody state={state} renderMessageImages={renderer} />)
    const toggle = screen.getByRole('button', { name: 'Worked for 4s' })
    const visibleImage = screen.getByRole('img', { name: 'Generated deliverable' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(visibleImage.closest('[hidden]')).toBeNull()
    expect(visibleImage.closest('[data-codex-final-answer]')).not.toBeNull()
    expect(visibleImage.compareDocumentPosition(screen.getByText('Here is your image.')) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    expect(renderer.mock.calls[0][0].images[0].attachment).toBe(image)
    for (let index = 0; index < 2; index++) {
      renderer.mockClear()
      fireEvent.click(toggle)
      const currentImage = screen.getByRole('img', { name: 'Generated deliverable' })
      expect(container.querySelectorAll('img')).toHaveLength(1)
      expect(currentImage.closest('[hidden]')).toBeNull()
      expect(currentImage.closest(index === 0 ? '[data-codex-process-content]' : '[data-codex-final-answer]')).not.toBeNull()
      expect(currentImage.compareDocumentPosition(screen.getByText('Here is your image.')) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
      expect(renderer).toHaveBeenCalledTimes(1)
      expect(renderer.mock.calls[0][0].images[0].attachment).toBe(image)
    }
  })

  it('does not auto-collapse ongoing work when an image arrives before final prose', () => {
    const initial = processState([tool('generate', command('running'))])
    const renderer = () => <img alt="Live deliverable" />
    const { rerender, container } = render(<ProcessBody state={initial} renderMessageImages={renderer} />)
    const withImage = { ...initial, segments: [...initial.segments,
      { key: 'image', seq: 2, step: 0, kind: 'image' as const, attachment: attachment() },
    ] }
    rerender(<ProcessBody state={withImage} renderMessageImages={renderer} />)
    const toggle = screen.getByRole('button', { name: 'Working for 4s' })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelector('[data-codex-process-content]')?.hasAttribute('hidden')).toBe(false)
    expect(screen.getByRole('button', { name: /Running npm test/ })).not.toBeNull()
    expect(screen.getByRole('img', { name: 'Live deliverable' }).closest('[hidden]')).toBeNull()
    rerender(<ProcessBody state={{ ...withImage, segments: [...withImage.segments,
      { ...prose('answer', 'Finishing the result.'), phase: 'final_answer', settled: false },
    ] }} renderMessageImages={renderer} />)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByRole('img', { name: 'Live deliverable' }).closest('[hidden]')).toBeNull()
  })

  it('preserves image boundaries and source order while later activities are running', () => {
    const state = processState([
      tool('before', reading('completed')),
      { key: 'image', seq: 2, step: 0, kind: 'image', attachment: attachment() },
      prose('after-image', 'I will check the generated image.'),
      tool('after', command('running')),
    ])
    const { container } = render(<ProcessBody state={state} renderMessageImages={() => <img alt="In-order deliverable" />} />)
    const order = [...container.querySelectorAll('[data-codex-activity-group], img, [data-codex-commentary]')]
      .map(element => element.tagName === 'IMG' ? 'image'
        : element.hasAttribute('data-codex-commentary') ? 'commentary' : 'activity')
    expect(order).toEqual(['activity', 'image', 'commentary', 'activity'])
  })

  it('shows a stopped process and the supplied error without presenting success', () => {
    const state = processState([tool('failed', command('error'))], { status: 'error', endedAt: startedAt + 3000, error: 'Permission denied.' })
    const { container } = render(<ProcessBody state={state} renderMessageImages={renderImages} />)
    expect(screen.getByRole('button', { name: 'Stopped for 3s' }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('status').textContent).toBe('Permission denied.')
    expect(container.querySelector('[data-codex-process-turn]')?.getAttribute('data-status')).toBe('error')
    expect(screen.getByLabelText('Failed')).not.toBeNull()
    expect(screen.queryByText('Success')).toBeNull()
  })

  it('streams only unsettled running markdown and stops its elapsed timer when settled', () => {
    const state = processState([{ ...prose('text', 'Checking'), settled: false }])
    const { rerender } = render(<ProcessBody state={state} renderMessageImages={renderImages} />)
    expect(screen.getByTestId('markdown').getAttribute('data-streaming')).toBe('true')
    act(() => { vi.advanceTimersByTime(2000) })
    expect(screen.getByRole('button', { name: 'Working for 6s' })).not.toBeNull()
    rerender(<ProcessBody state={{ ...state, segments: [{ ...state.segments[0], settled: true }] }} renderMessageImages={renderImages} />)
    expect(screen.getByTestId('markdown').getAttribute('data-streaming')).toBe('false')
    rerender(<ProcessBody state={{ ...state, status: 'completed', endedAt: startedAt + 6000,
      presentations: { 0: { version: 1, blocks: [] } },
    }} renderMessageImages={renderImages} />)
    expect(screen.getByTestId('markdown').getAttribute('data-streaming')).toBe('false')
    expect(vi.getTimerCount()).toBe(0)
    act(() => { vi.advanceTimersByTime(10000) })
    expect(screen.getByRole('button', { name: 'Worked for 6s' })).not.toBeNull()
  })
})

describe('CodexProcessView file mentions', () => {
  it.each(['turn', 'step'] as const)('uses the official closed %s owner and passes its resolver only to the answer', kind => {
    const state = processState([prose('commentary', 'Checking README.md'),
      { ...prose('answer', 'README.md'), phase: 'final_answer' },
    ], { status: 'completed' })
    const turn = { turn: state.turn, status: 'closed' }
    const openFile = vi.fn()
    const mentions: MarkdownFileMentions = { resolve: token => token === 'README.md'
      ? { label: 'Open README.md', title: '/workspace/README.md', open: () => { openFile('/workspace/README.md') } }
      : undefined }
    const fileMentions = vi.fn<React.ComponentProps<typeof CodexProcessView>['fileMentions']>(() => mentions)
    const tail = { closing: { finalNode: { seq: 42 } } }
    const useTurnData = vi.fn(() => tail)
    const props = {
      node: { data: state, location: { kind, turn } }, sessionId: `file-mentions-${kind}`,
      renderMessageImages: renderImages, openFile, fileMentions, useTurnData, useChat: useEmptySession,
    } as unknown as React.ComponentProps<typeof CodexProcessView>
    const { rerender } = render(<CodexProcessView {...props} />)
    expect(useTurnData).toHaveBeenCalledWith('turn-tail')
    expect(fileMentions).toHaveBeenCalledExactlyOnceWith({ turn, seq: 42, openFile })
    expect(fileMentions.mock.calls[0][0].turn).toBe(turn)
    expect(fileMentions.mock.calls[0][0].openFile).toBe(openFile)
    expect(markdownProbe.mock.calls.find(([value]) => value.text === 'README.md')?.[0].fileMentions).toBe(mentions)
    expect(markdownProbe.mock.calls.find(([value]) => value.text === 'Checking README.md')?.[0].fileMentions).toBeUndefined()
    fireEvent.click(screen.getByRole('button', { name: 'Open README.md' }))
    expect(openFile).toHaveBeenCalledExactlyOnceWith('/workspace/README.md')
    rerender(<CodexProcessView {...props} />)
    expect(fileMentions).toHaveBeenCalledTimes(1)
  })

  it('waits for both a closed location and closing tail, and drops stale file mentions', () => {
    const state = processState([{ ...prose('answer', 'README.md'), phase: 'final_answer' }])
    const mentions: MarkdownFileMentions = { resolve: () => undefined }
    const fileMentions = vi.fn<React.ComponentProps<typeof CodexProcessView>['fileMentions']>(() => mentions)
    const openFile = vi.fn()
    let tail: { closing?: { finalNode: { seq: number } } } | undefined = { closing: { finalNode: { seq: 42 } } }
    const useTurnData = () => tail
    const makeProps = (location: unknown) => ({
      node: { data: state, location }, sessionId: 'file-mentions-lifecycle',
      renderMessageImages: renderImages, openFile, fileMentions, useTurnData, useChat: useEmptySession,
    } as unknown as React.ComponentProps<typeof CodexProcessView>)
    const { rerender } = render(<CodexProcessView {...makeProps({ kind: 'turn', turn: { status: 'running' } })} />)
    expect(fileMentions).not.toHaveBeenCalled()
    const turn = { turn: state.turn, status: 'closed' }
    tail = undefined
    rerender(<CodexProcessView {...makeProps({ kind: 'turn', turn })} />)
    expect(fileMentions).not.toHaveBeenCalled()
    tail = { closing: { finalNode: { seq: 43 } } }
    rerender(<CodexProcessView {...makeProps({ kind: 'turn', turn })} />)
    expect(fileMentions).toHaveBeenCalledExactlyOnceWith({ turn, seq: 43, openFile })
    expect(markdownProbe.mock.calls.at(-1)?.[0].fileMentions).toBe(mentions)
    tail = { closing: { finalNode: { seq: 44 } } }
    rerender(<CodexProcessView {...makeProps({ kind: 'turn', turn })} />)
    expect(fileMentions).toHaveBeenLastCalledWith({ turn, seq: 44, openFile })
    rerender(<CodexProcessView {...makeProps({ kind: 'unresolved' })} />)
    expect(fileMentions).toHaveBeenCalledTimes(2)
    expect(markdownProbe.mock.calls.at(-1)?.[0].fileMentions).toBeUndefined()
  })
})

describe('CodexProcessView readiness', () => {
  it('suppresses a represented native row only while its replacement is mounted', () => {
    const state = processState([tool('command', reading('completed'))], { status: 'completed' })
    const payload = { version: 1, threadId: 'thread', turnId: 'turn', itemId: 'command', phase: 'completed', activity: reading('completed') }
    const snapshot = { nodes: new Map([[conversationContextKey('tool-call', 'command'), {
      kind: 'tool-call', id: 'command',
      location: { kind: 'step', turn: { data: new Map([['relay-codex-process', state]]) } },
    }]]) }
    const props = {
      sessionId: 'process-session', callId: 'command', toolName: 'relay_codex_activity', openFile: vi.fn(),
      block: { kind: 'tool-result', callId: 'command', subCalls: [], call: null, isError: false, meta: { codexActivity: payload } },
      useChat: selector => selector(snapshot as never),
    } as ToolCallViewProps
    const node = { data: state, location: { kind: 'turn', turn: { status: 'running' } } } as unknown as React.ComponentProps<typeof CodexProcessView>['node']
    const processProps: Partial<React.ComponentProps<typeof CodexProcessView>> = {
      node, sessionId: props.sessionId, renderMessageImages: renderImages,
      openFile: vi.fn(), inspectCall: vi.fn(), forkAt: vi.fn(), fileMentions: () => undefined,
      useTurnData: () => undefined, useChat: useEmptySession,
    }
    const unsafe = { ...state, takeoverSafe: false, takeoverReasons: ['unsupported-tool'] as const }
    const tree = (show: boolean, safe = true) => <>
      <GroupedCodexToolActivityView {...props} />
      {show && <CodexProcessView {...processProps as React.ComponentProps<typeof CodexProcessView>}
        node={{ ...node, data: safe ? state : unsafe }} />}
    </>
    const { rerender, container } = render(tree(false))
    expect(screen.getByRole('button', { name: 'Read README.md' })).not.toBeNull()
    rerender(tree(true))
    expect(screen.queryByRole('button', { name: 'Read README.md' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Read a file' })).not.toBeNull()
    expect(container.querySelector('[data-codex-grouped-call="command"]')).not.toBeNull()
    // Keep the native lookup on its previous safe snapshot to prove that the
    // process itself releases presence when a later projection becomes unsafe.
    rerender(tree(true, false))
    expect(screen.getByRole('button', { name: 'Read README.md' })).not.toBeNull()
    expect(container.querySelector('[data-codex-grouped-call="command"]')).toBeNull()
    expect(container.querySelector('[data-codex-process-turn]')).toBeNull()
    rerender(tree(true))
    expect(container.querySelector('[data-codex-grouped-call="command"]')).not.toBeNull()
    const turnData = snapshot.nodes.get(conversationContextKey('tool-call', 'command'))!.location.turn.data
    turnData.set('relay-codex-process', unsafe)
    rerender(tree(true))
    expect(screen.getByRole('button', { name: 'Read README.md' })).not.toBeNull()
    expect(container.querySelector('[data-codex-grouped-call="command"]')).toBeNull()
    turnData.set('relay-codex-process', state)
    rerender(tree(true))
    expect(container.querySelector('[data-codex-grouped-call="command"]')).not.toBeNull()
    rerender(tree(false))
    expect(screen.getByRole('button', { name: 'Read README.md' })).not.toBeNull()
    expect(container.querySelector('[data-codex-grouped-call="command"]')).toBeNull()
  })

  it.each([false, true])('restores the native row after a rendering failure (previously mounted: %s)', previouslyMounted => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const failure = new Error('Fixture attachment renderer failed')
    const expectedError = (event: ErrorEvent) => { if (event.error === failure) event.preventDefault() }
    window.addEventListener('error', expectedError)
    onTestFinished(() => { window.removeEventListener('error', expectedError) })
    const state = processState([tool('command', reading('completed')),
      { key: 'image', seq: 2, step: 0, kind: 'image', attachment: attachment() },
    ], { status: 'completed' })
    const payload = { version: 1, threadId: 'thread', turnId: 'turn', itemId: 'command', phase: 'completed', activity: reading('completed') }
    const snapshot = { nodes: new Map([[conversationContextKey('tool-call', 'command'), {
      kind: 'tool-call', id: 'command',
      location: { kind: 'turn', turn: { data: new Map([['relay-codex-process', state]]) } },
    }]]) }
    const nativeProps = {
      sessionId: `failed-process-${previouslyMounted}`, callId: 'command', toolName: 'relay_codex_activity',
      block: { kind: 'tool-result', callId: 'command', subCalls: [], call: null, isError: false, meta: { codexActivity: payload } },
      useChat: selector => selector(snapshot as never),
    } as ToolCallViewProps
    const processProps = {
      node: { data: state, location: { kind: 'turn', turn: { status: 'closed' } } },
      sessionId: nativeProps.sessionId, useTurnData: () => undefined, fileMentions: () => undefined,
      useChat: useEmptySession,
    } as unknown as React.ComponentProps<typeof CodexProcessView>
    const caught = vi.fn()
    const tree = (fail: boolean, boundaryKey = 'first') => <>
      <GroupedCodexToolActivityView {...nativeProps} />
      <ProcessErrorBoundary key={boundaryKey} onError={caught}>
        <CodexProcessView {...processProps} renderMessageImages={() => {
          if (fail) throw failure
          return <img alt="Replacement image" />
        }} />
      </ProcessErrorBoundary>
    </>
    const { rerender, container } = render(tree(!previouslyMounted))
    if (previouslyMounted) {
      expect(container.querySelector('[data-codex-grouped-call="command"]')).not.toBeNull()
      rerender(tree(true))
    }
    expect(caught).toHaveBeenCalledWith(failure)
    expect(screen.getByRole('status').textContent).toBe('Replacement unavailable')
    expect(screen.getByRole('button', { name: 'Read README.md' })).not.toBeNull()
    expect(container.querySelector('[data-codex-grouped-call="command"]')).toBeNull()
    rerender(tree(false, 'recovered'))
    expect(screen.getByRole('img', { name: 'Replacement image' })).not.toBeNull()
    expect(container.querySelector('[data-codex-grouped-call="command"]')).not.toBeNull()
  })
})

describe.each(['legacy', 'current'])('%s CodexProcessView legacy boundaries', generation => {
  it.each([10, 20, 30])('restores native rows and the hidden fallback when legacy activity arrives at seq %s', anchorSeq => {
    const { container, publishLegacy } = renderLegacyBoundaryFixture(generation)
    expect(container.querySelector('[data-codex-process-turn]')).not.toBeNull()
    expect(container.querySelector('[data-codex-grouped-call="command"]')).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Read README.md' })).toBeNull()

    publishLegacy(anchorSeq)
    expect(screen.getByRole('button', { name: 'Read README.md' })).not.toBeNull()
    expect(container.querySelector('[data-codex-grouped-call="command"]')).toBeNull()
    expect(container.querySelector('[data-codex-process-turn]')).toBeNull()
    expect(container.querySelector('[data-codex-process-fallback]')?.hasAttribute('hidden')).toBe(true)

    publishLegacy(undefined)
    expect(container.querySelector('[data-codex-process-fallback]')).toBeNull()
    expect(container.querySelector('[data-codex-process-turn]')).not.toBeNull()
    expect(container.querySelector('[data-codex-grouped-call="command"]')).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Read README.md' })).toBeNull()
  })

  it.each([9, 31])('ignores legacy activity from another turn outside the process range at seq %s', anchorSeq => {
    const { container, publishLegacy } = renderLegacyBoundaryFixture(generation)
    const process = container.querySelector('[data-codex-process-turn]')
    expect(process).not.toBeNull()
    publishLegacy(anchorSeq)
    expect(container.querySelector('[data-codex-process-turn]')).toBe(process)
    expect(container.querySelector('[data-codex-process-fallback]')).toBeNull()
    expect(container.querySelector('[data-codex-grouped-call="command"]')).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Read README.md' })).toBeNull()
  })
})

function renderLegacyBoundaryFixture(generation: string = 'current') {
  const state = processState([tool('command', reading('completed'))], {
    status: 'completed', firstVisibleSeq: 10, lastSeq: 30,
  })
  const payload = { version: 1, threadId: 'thread', turnId: 'turn', itemId: 'command', phase: 'completed', activity: reading('completed') }
  const nativeNodes = new Map<string, unknown>([[conversationContextKey('tool-call', 'command'), {
    kind: 'tool-call', id: 'command', anchorSeq: 15,
    location: { kind: 'step', turn: { data: new Map([['relay-codex-process', state]]) } },
  }]])
  let snapshot = { nodes: nativeNodes }
  const listeners = new Set<() => void>()
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }
  const getSnapshot = () => snapshot
  const useChat: React.ComponentProps<typeof CodexProcessView>['useChat'] = selector =>
    selector(useSyncExternalStore(subscribe, getSnapshot, getSnapshot) as never)
  const hooks = generation === 'current' ? { useChat } : { useSession: (selector: (snapshot: unknown) => unknown) =>
    selector({ chat: useSyncExternalStore(subscribe, getSnapshot, getSnapshot) }) }
  const nativeProps = {
    sessionId: 'legacy-boundary-session', callId: 'command', toolName: 'relay_codex_activity',
    block: { kind: 'tool-result', callId: 'command', subCalls: [], call: null, isError: false, meta: { codexActivity: payload } },
    ...hooks,
  } as ToolCallViewProps
  const processProps = {
    node: { data: state, location: { kind: 'turn', turn: { status: 'closed' } } },
    sessionId: nativeProps.sessionId, renderMessageImages: renderImages,
    ...hooks, useTurnData: () => undefined, fileMentions: () => undefined,
  } as unknown as React.ComponentProps<typeof CodexProcessView>
  const result = render(<>
    <GroupedCodexToolActivityView {...nativeProps} />
    <CodexProcessView {...processProps} />
  </>)
  return { ...result, setNativeFolding: (foldable: boolean) => {
    result.rerender(<>
      <GroupedCodexToolActivityView {...nativeProps} />
      <CodexProcessView {...processProps} turnProcess={{ foldable } as never} />
    </>)
  }, publishLegacy: (anchorSeq: number | undefined) => {
    act(() => {
      const nodes = new Map(nativeNodes)
      if (anchorSeq !== undefined) nodes.set('legacy-activity', {
        kind: 'relay-codex-activity', anchorSeq, visibility: 'visible', location: { kind: 'unresolved' },
        data: { ...payload, turnId: anchorSeq < 10 || anchorSeq > 30 ? 'other-turn' : 'turn', itemId: 'legacy-activity' },
      })
      snapshot = { nodes }
      for (const listener of listeners) listener()
    })
  } }
}

class ProcessErrorBoundary extends Component<{ children: React.ReactNode; onError: (error: Error) => void }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error: Error) { this.props.onError(error) }
  render() { return this.state.failed ? <div role="status">Replacement unavailable</div> : this.props.children }
}

function command(status: CodexActivityData['status'] = 'completed'): CodexActivityData {
  return { type: 'commandExecution', status, title: 'Ran commands', input: '$ npm test' }
}

function reading(status: CodexActivityData['status']): CodexActivityData {
  return { ...command(status), input: '$ cat README.md', commandActions: '[{"type":"read","name":"README.md"}]' }
}

function tool(key: string, activity = command()): CodexProcessSegment {
  return { key, seq: 1, step: 0, kind: 'activity', callId: key, activity, settled: activity.status !== 'running' }
}

function prose(key: string, text: string, kind: 'text' | 'reasoning' = 'text'): CodexProcessSegment {
  return { key, seq: 1, step: 0, kind, text, phase: kind === 'text' ? 'commentary' : undefined, settled: true }
}

function processState(segments: readonly CodexProcessSegment[], changes: Partial<CodexProcessState> = {}): CodexProcessState {
  return { ...initialCodexProcessState(4, startedAt), owned: true, ownedSteps: [0],
    takeoverSafe: true, takeoverReasons: [], firstVisibleSeq: 1, segments, ...changes }
}

function attachment(): NonNullable<CodexProcessSegment['attachment']> {
  return { attachmentId: 'fixture-image' as NonNullable<CodexProcessSegment['attachment']>['attachmentId'],
    mediaType: 'image/png', bytes: 64, width: 16, height: 16, name: 'fixture.png' }
}


it('restores native rows when official compact mode folds the Codex process container', () => {
  const { container, setNativeFolding } = renderLegacyBoundaryFixture()
  expect(container.querySelector('[data-codex-grouped-call="command"]')).not.toBeNull()
  setNativeFolding(true)
  expect(container.querySelector('[data-codex-process-turn]')).toBeNull()
  expect(container.querySelector('[data-codex-process-fallback]')).not.toBeNull()
  expect(screen.getByRole('button', { name: 'Read README.md' })).not.toBeNull()
  setNativeFolding(false)
  expect(container.querySelector('[data-codex-process-turn]')).not.toBeNull()
  expect(container.querySelector('[data-codex-grouped-call="command"]')).not.toBeNull()
})
