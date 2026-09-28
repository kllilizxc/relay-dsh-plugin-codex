// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { CodexActivityData, CodexActivityEventData } from '../src/client/codex-activity.ts'


vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  DisclosureRow: ({ icon, title, open, expandable, onToggle, children, collapsedContent, titleClassName, rowClassName }: {
    icon: React.ReactNode
    title: string
    open: boolean
    expandable: boolean
    onToggle: () => void
    children: React.ReactNode
    collapsedContent?: React.ReactNode
    titleClassName?: string
    rowClassName?: string
  }) => (
    <div>
      <button className={rowClassName} aria-expanded={open} disabled={!expandable} onClick={onToggle}>
        {icon}
        <span className={titleClassName}>{title}</span>
        {collapsedContent}
      </button>
      {open ? <div>{children}</div> : null}
    </div>
  ),
  StateDot: ({ state }: { state: string }) => <span data-testid="state-dot" data-state={state} />,
}))

const conversationContextKey = (kind: string, id: string) => `${kind}:${id}`
import { CodexActivityView, CodexToolActivityView, GroupedCodexToolActivityView } from '../src/client/CodexActivityView.tsx'
import { initialCodexProcessState, type CodexProcessState } from '../src/client/codex-process.ts'
import { mountProcess } from '../src/client/process-presence.ts'

const disposers = new Set<() => void>()

afterEach(() => {
  cleanup()
  for (const dispose of disposers) dispose()
  disposers.clear()
  vi.clearAllMocks()
})

describe('CodexActivityView', () => {
  it('keeps the same expanded row when native tool metadata settles and replays', () => {
    const running = nativeBlock(readActivity('running'))
    const { rerender } = render(<CodexToolActivityView {...toolProps(running)} />)
    fireEvent.click(screen.getByRole('button', { name: 'Reading README.md' }))
    expect(screen.getByText('Running')).not.toBeNull()
    expect(screen.getByTestId('state-dot').getAttribute('data-state')).toBe('ongoing')
    const settled = nativeBlock({ ...readActivity('completed'), output: 'README contents\n', exitCode: '0' })
    rerender(<CodexToolActivityView {...toolProps(settled)} />)
    expect(screen.getByRole('button', { name: 'Read README.md' }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText(/README contents/)).not.toBeNull()
    expect(screen.getByText('Success')).not.toBeNull()
    expect(screen.queryByTestId('state-dot')).toBeNull()
    cleanup()
    render(<CodexToolActivityView {...toolProps({ ...settled, call: null } as ToolCallViewProps['block'])} />)
    fireEvent.click(screen.getByRole('button', { name: 'Read README.md' }))
    expect(screen.getByText(/README contents/)).not.toBeNull()
  })

  it('renders interrupted native calls as failed and malformed payloads without crashing', () => {
    const payload = { version: 1, threadId: 't', turnId: 'r', itemId: 'c', phase: 'started',
      activity: { type: 'commandExecution', status: 'running', title: 'Ran commands', input: '$ pwd' } }
    const { rerender } = render(<CodexToolActivityView {...toolProps({
      kind: 'tool-result', isError: true, call: { argsRaw: JSON.stringify(payload) },
    } as ToolCallViewProps['block'])} />)
    fireEvent.click(screen.getByRole('button', { name: 'Failed to run pwd' }))
    expect(screen.getByText('Failed')).not.toBeNull()
    expect(screen.getByTestId('state-dot').getAttribute('data-state')).toBe('error')
    rerender(<CodexToolActivityView {...toolProps({ argsRaw: '{invalid' } as ToolCallViewProps['block'])} />)
    expect(screen.getByText('Codex activity (running)')).not.toBeNull()
    rerender(<CodexToolActivityView {...toolProps({ kind: 'tool-result', isError: true, call: null } as ToolCallViewProps['block'])} />)
    expect(screen.getByText('Codex activity (failed)')).not.toBeNull()
  })

  it('renders command output as an expandable shell detail instead of markdown body text', () => {
    renderActivity({
      type: 'commandExecution',
      status: 'completed',
      title: 'Ran commands',
      summary: 'npm test',
      input: '$ npm test',
      output: 'PASS fixture\n',
      exitCode: '0',
      provenance: { threadId: 'thread-1234567890', turnId: 'turn-abcdef123456' },
    })

    const row = screen.getByRole('button', { name: 'Ran npm test' })
    expect(row.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('PASS fixture')).toBeNull()

    fireEvent.click(row)

    expect(row.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('Shell')).not.toBeNull()
    expect(screen.getByText(/\$ npm test/)).not.toBeNull()
    expect(screen.getByText(/PASS fixture/)).not.toBeNull()
    expect(screen.getByText('exit 0')).not.toBeNull()
    expect(screen.getByText('Success')).not.toBeNull()
    expect(row.querySelector('[data-activity-icon="command"]')).not.toBeNull()
    expect(screen.queryByTestId('state-dot')).toBeNull()
  })

  it('uses compact rows for file, image, search, and plan activities', () => {
    const cases: Array<[CodexActivityData, string, string]> = [
      [readActivity('running'), 'Reading README.md', 'read'],
      [{ type: 'fileChange', status: 'completed', title: 'Edited a file', summary: 'src/index.ts' }, 'Edited a file', 'edit'],
      [{ type: 'imageView', status: 'completed', title: 'Viewed an image', summary: 'screenshot.png' }, 'Viewed an image', 'image'],
      [{ type: 'webSearch', status: 'running', title: 'Searched web', summary: 'DSH Codex UI' }, 'Searching the web for "DSH Codex UI"', 'webSearch'],
      [{ type: 'plan', status: 'completed', title: 'Updated plan', summary: '2 steps' }, 'Updated the plan', 'plan'],
      [{ type: 'futureActivity', status: 'running', title: 'External task' }, 'External task (running)', 'unknown'],
    ]

    for (const [activity, title, icon] of cases) {
      const { unmount } = renderActivity(activity)
      const row = screen.getByRole('button', { name: title })
      expect(row.querySelector(`[data-activity-icon="${icon}"]`)).not.toBeNull()
      expect(row.closest('[data-codex-activity]')?.getAttribute('data-status')).toBe(activity.status)
      expect(screen.queryByTestId('state-dot') === null).toBe(activity.status === 'completed')
      unmount()
    }
  })

  it('keeps long command details intact behind a bounded semantic title', () => {
    const input = `$ npm test ${'long-argument'.repeat(30)}`
    renderActivity({ type: 'commandExecution', status: 'completed', title: 'Ran commands', input })
    const row = screen.getByRole('button')
    const title = row.textContent ?? ''
    expect(title.startsWith('Ran npm test ')).toBe(true)
    expect(title.endsWith('...')).toBe(true)
    expect(title.length).toBeLessThan(100)
    expect(row.closest('[data-codex-activity]')?.getAttribute('title')).toBe(title)
    fireEvent.click(row)
    expect(screen.getByText(input).tagName).toBe('PRE')
    // Layout ellipsis and overflow require a browser; jsdom only verifies content.
  })
})

describe('GroupedCodexToolActivityView', () => {
  it.each(['running', 'completed'] as const)('keeps a %s native row until its represented process mounts', status => {
    const process = representedProcess()
    const props = toolProps(nativeBlock(readActivity(status)), process)
    const { container } = render(<GroupedCodexToolActivityView {...props} />)
    const title = status === 'running' ? 'Reading README.md' : 'Read README.md'
    expect(screen.getByRole('button', { name: title })).not.toBeNull()
    const dispose = ready(props.sessionId, process.turn)
    expect(screen.queryByRole('button')).toBeNull()
    expect(container.querySelector('[data-codex-grouped-call="command"]')?.hasAttribute('hidden')).toBe(true)
    act(dispose)
    expect(screen.getByRole('button', { name: title })).not.toBeNull()
  })

  it('stays suppressed while a represented running root settles', () => {
    const process = representedProcess()
    const props = toolProps(nativeBlock(readActivity('running')), process)
    ready(props.sessionId, process.turn)
    const { rerender, container } = render(<GroupedCodexToolActivityView {...props} />)
    rerender(<GroupedCodexToolActivityView {...props} block={nativeBlock(readActivity('completed'))} />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(container.querySelector('[data-codex-grouped-call="command"]')).not.toBeNull()
  })

  it('requires both the matching session and turn to be ready', () => {
    const process = representedProcess()
    const props = toolProps(nativeBlock(readActivity('running')), process)
    ready('another-session', process.turn)
    ready(props.sessionId, process.turn + 1)
    render(<GroupedCodexToolActivityView {...props} />)
    expect(screen.getByRole('button', { name: 'Reading README.md' })).not.toBeNull()
  })

  it('leaves unrepresented calls, absent process data, and non-turn locations visible', () => {
    const process = representedProcess('another-call')
    ready('activity-session', process.turn)
    const block = nativeBlock(readActivity('running'))
    const { rerender } = render(<GroupedCodexToolActivityView {...toolProps(block, process)} />)
    expect(screen.getByRole('button', { name: 'Reading README.md' })).not.toBeNull()
    rerender(<GroupedCodexToolActivityView {...toolProps(block)} />)
    expect(screen.getByRole('button', { name: 'Reading README.md' })).not.toBeNull()
    rerender(<GroupedCodexToolActivityView {...toolProps(block, representedProcess(), 'session')} />)
    expect(screen.getByRole('button', { name: 'Reading README.md' })).not.toBeNull()
  })

  it.each(['running', 'completed'] as const)('preserves a represented %s root with subcalls', status => {
    const process = representedProcess()
    ready('activity-session', process.turn)
    const child = nativeBlock(readActivity('running'), 'child')
    const root = { ...nativeBlock(readActivity(status)), subCalls: [child] }
    render(<GroupedCodexToolActivityView {...toolProps(root, process)} />)
    expect(screen.getByRole('button', { name: status === 'running' ? 'Reading README.md' : 'Read README.md' })).not.toBeNull()
  })

  it('does not suppress a subcall by borrowing its parent root location', () => {
    const process = representedProcess('child')
    ready('activity-session', process.turn)
    const props = toolProps(nativeBlock(readActivity('running'), 'child'), process, 'step', 'root')
    render(<GroupedCodexToolActivityView {...props} />)
    expect(screen.getByRole('button', { name: 'Reading README.md' })).not.toBeNull()
  })

  it('keeps suppression until the last mounted process is removed', () => {
    const process = representedProcess()
    const props = toolProps(nativeBlock(readActivity('running')), process, 'turn')
    const first = ready(props.sessionId, process.turn)
    const second = ready(props.sessionId, process.turn)
    render(<GroupedCodexToolActivityView {...props} />)
    act(first)
    expect(screen.queryByRole('button')).toBeNull()
    act(second)
    expect(screen.getByRole('button', { name: 'Reading README.md' })).not.toBeNull()
  })
})

function readActivity(status: CodexActivityData['status']): CodexActivityData {
  return {
    type: 'commandExecution', status, title: 'Ran commands', input: '$ cat README.md',
    commandActions: JSON.stringify([{ type: 'read', name: 'README.md', path: '/workspace/README.md' }]),
  }
}

function nativeBlock(activity: CodexActivityData, callId = 'command'): ToolCallViewProps['block'] {
  const payload: CodexActivityEventData = {
    version: 1, threadId: 'thread', turnId: 'turn', itemId: callId,
    phase: activity.status === 'running' ? 'started' : 'completed', activity,
  }
  const call = { callId, name: 'relay_codex_activity', argsRaw: JSON.stringify(payload), subCalls: [],
    turn: 7, step: 0, time: 1000, callView: null }
  return activity.status === 'running' ? call : {
    kind: 'tool-result', seq: 2, time: 2000, callTime: 1000, callView: null, resultView: null,
    callId, isError: activity.status === 'error', content: [], call, meta: { codexActivity: payload }, subCalls: [],
  }
}

function representedProcess(callId = 'command'): CodexProcessState {
  return {
    ...initialCodexProcessState(7, 1000), owned: true, ownedSteps: [0],
    takeoverSafe: true, takeoverReasons: [], firstVisibleSeq: 1,
    segments: [{ key: callId, seq: 1, step: 0, kind: 'activity', callId, activity: readActivity('running') }],
  }
}

function toolProps(block: ToolCallViewProps['block'], process?: CodexProcessState, kind = 'step', rootId = block.callId): ToolCallViewProps {
  const turn = { data: new Map([['relay-codex-process', process]]) }
  const snapshot = { nodes: new Map([[conversationContextKey('tool-call', rootId), { kind: 'tool-call', id: rootId, location: { kind, turn } }]]) }
  return {
    sessionId: 'activity-session', callId: block.callId, toolName: 'relay_codex_activity', block,
    openFile: vi.fn(), useChat: selector => selector(snapshot as never),
  } as ToolCallViewProps
}

function ready(sessionId: string, turn: number): () => void {
  let dispose: () => void = () => {}
  act(() => { dispose = mountProcess(sessionId, turn) })
  disposers.add(dispose)
  return () => { disposers.delete(dispose); dispose() }
}

function renderActivity(activity: CodexActivityData) {
  const props: Partial<React.ComponentProps<typeof CodexActivityView>> = {
    node: {
      key: `node-${activity.type}`, kind: 'relay-codex-activity', id: `node-${activity.type}`,
      target: 'chat', anchorSeq: 1, location: { kind: 'unresolved' }, visibility: 'visible', data: activity,
    },
    openFile: vi.fn(), inspectCall: vi.fn(), forkAt: vi.fn(),
    renderMessageImages: () => null, fileMentions: () => undefined,
  }
  return render(<CodexActivityView {...props as React.ComponentProps<typeof CodexActivityView>} />)
}
