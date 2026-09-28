// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentType } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlotCore, type StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { AdvancedDebugSource } from '../src/client/AdvancedDebug.tsx'

vi.mock('../src/client/CodexProcessView.tsx', () => ({ CodexProcessView: () => <div>Process fixture</div> }))

import { installProcessPresentation } from '../src/client/process-presentation.tsx'
import { mountProcess } from '../src/client/process-presence.ts'
import { codexProcessDefinition, initialCodexProcessState } from '../src/client/codex-process.ts'

const slot = 'conversation.chat.node'
const disposers: Array<() => void> = []

afterEach(async () => {
  cleanup()
  await act(async () => { while (disposers.length) disposers.pop()!() })
  vi.restoreAllMocks()
})

describe.each(['legacy', 'current'])('%s process presentation public slot wrappers', generation => {
const locale = generation === 'legacy' ? 'conversation' : 'chat'
  it('waits for native registrations and restores the exact originals on disposal', async () => {
    const harness = setup(generation)
    expect(harness.registerProjection).toHaveBeenCalledExactlyOnceWith(codexProcessDefinition)
    expect(harness.core.entries(slot).map(entry => entry.options.key)).toEqual(['relay-codex-process'])
    const Assistant = () => <div>Native assistant</div>
    const Context = () => <div>Native context</div>
    await act(async () => {
      harness.core.register({ name: slot, key: 'assistant-step', locale }, Assistant)
      harness.core.register({ name: slot, key: 'context', locale }, Context)
    })
    const originals = harness.core.entries(slot).filter(entry => entry.options.priority === undefined)
      .filter(entry => entry.options.key !== 'relay-codex-process')
    expect(winner(harness.core, 'assistant-step').options.priority).toBe(-20)
    expect(winner(harness.core, 'context').options.priority).toBe(-20)
    await act(async () => { harness.dispose() })
    expect(harness.core.entries(slot)).toEqual(originals)
    expect(winner(harness.core, 'assistant-step').component).toBe(Assistant)
    expect(winner(harness.core, 'context').component).toBe(Context)
    await act(async () => { harness.dispose() })
    expect(harness.core.entries(slot)).toEqual(originals)
  })

  it('reconciles a removed and reloaded native renderer without retaining a stale wrapper', async () => {
    const harness = setup(generation)
    let remove = () => {}
    await act(async () => {
      remove = harness.core.register({ name: slot, key: 'assistant-step', locale }, () => <div>First renderer</div>)
    })
    const originalWrapper = winner(harness.core, 'assistant-step')
    await act(async () => { remove() })
    expect(harness.core.entries(slot).some(entry => entry.options.key === 'assistant-step')).toBe(false)
    await act(async () => {
      harness.core.register({ name: slot, key: 'assistant-step', locale }, () => <div>Reloaded renderer</div>)
    })
    const Wrapper = winner(harness.core, 'assistant-step').component as ComponentType<ChatNodeViewProps<'assistant-step'>>
    expect(winner(harness.core, 'assistant-step')).not.toBe(originalWrapper)
    render(<Wrapper {...assistantProps()} />)
    expect(screen.getByText('Reloaded renderer')).not.toBeNull()
    expect(screen.queryByText('First renderer')).toBeNull()
  })

  it('gates only owned assistant steps on the matching session and turn presence', async () => {
    const native = vi.fn((props: ChatNodeViewProps<'assistant-step'>) => <button onClick={() => { props.inspectCall('fixture-call') }}>Native assistant</button>)
    const harness = setup(generation)
    await act(async () => {
      harness.core.register({ name: slot, key: 'assistant-step', locale }, native)
    })
    const Wrapper = winner(harness.core, 'assistant-step').component as ComponentType<ChatNodeViewProps<'assistant-step'>>
    const process = safeProcess()
    const inspectCall = vi.fn()
    const props = assistantProps({ node: { data: { step: 2 } }, useTurnData: () => process, inspectCall })
    const { rerender, container } = render(<Wrapper {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Native assistant' }))
    expect(inspectCall).toHaveBeenCalledExactlyOnceWith('fixture-call')
    expect(native.mock.calls.at(-1)?.[0].useTurnData).toBe(props.useTurnData)
    const otherSession = presence('other-session', 4)
    const otherTurn = presence(props.sessionId, 5)
    expect(screen.getByRole('button', { name: 'Native assistant' })).not.toBeNull()
    const mounted = presence(props.sessionId, 4)
    expect(screen.queryByRole('button', { name: 'Native assistant' })).toBeNull()
    expect(container.querySelector('[data-codex-native-assistant]')?.hasAttribute('hidden')).toBe(true)
    rerender(<Wrapper {...assistantProps({ ...props, node: { data: { step: 3 } } })} />)
    expect(screen.getByRole('button', { name: 'Native assistant' })).not.toBeNull()
    rerender(<Wrapper {...assistantProps({ ...props, useTurnData: () => undefined })} />)
    expect(screen.getByRole('button', { name: 'Native assistant' })).not.toBeNull()
    rerender(<Wrapper {...assistantProps({ ...props,
      useTurnData: () => ({ ...process, takeoverSafe: false, takeoverReasons: ['foreign-provider'] }),
    })} />)
    expect(screen.getByRole('button', { name: 'Native assistant' })).not.toBeNull()
    expect(container.querySelector('[data-codex-native-assistant]')).toBeNull()
    rerender(<Wrapper {...props} />)
    expect(screen.queryByRole('button', { name: 'Native assistant' })).toBeNull()
    act(mounted)
    expect(screen.getByRole('button', { name: 'Native assistant' })).not.toBeNull()
    act(() => { otherSession(); otherTurn() })
  })

  it.each(['children', 'store', 'inject', 'locale'] as const)('leaves native entries with a changed %s contract untouched', async contract => {
    const harness = setup(generation)
    const Native = () => <div>Unmodified native entry</div>
    const extra = contract === 'children' ? { children: {} }
      : contract === 'store' ? { store: () => ({}) }
        : contract === 'inject' ? { inject: () => ({}) } : { locale: 'changed-locale' }
    await act(async () => {
      for (const key of ['assistant-step', 'context'] as const) {
        harness.core.register({ name: slot, key, locale, ...extra } as never, Native)
      }
    })
    for (const key of ['assistant-step', 'context'] as const) {
      expect(winner(harness.core, key).component).toBe(Native)
      expect(harness.core.entries(slot).filter(entry => entry.options.key === key)).toHaveLength(1)
    }
  })

  it('hides only system-prompt context in simple mode after the matching process mounts', async () => {
    const harness = setup(generation)
    await act(async () => {
      harness.core.register({ name: slot, key: 'context', locale }, () => <div>Native context</div>)
    })
    const Wrapper = winner(harness.core, 'context').component as ComponentType<ChatNodeViewProps<'context'>>
    const process = safeProcess()
    const props = contextProps({ useTurnData: () => process })
    const { rerender, container } = render(<Wrapper {...props} />)
    expect(screen.getByText('Native context')).not.toBeNull()
    const unmount = presence(props.sessionId, process.turn)
    expect(screen.queryByText('Native context')).toBeNull()
    expect(container.querySelector('[data-codex-internal-context]')?.hasAttribute('hidden')).toBe(true)
    act(() => { harness.setDebug(true) })
    expect(screen.getByText('Native context')).not.toBeNull()
    act(() => { harness.setDebug(false) })
    expect(screen.queryByText('Native context')).toBeNull()
    for (const source of [null, { kind: 'user' }, { kind: 'plugin', plugin: 'another-plugin' }, { kind: 'model', plugin: '@deepseek-ai/dsh-system-prompt' }]) {
      rerender(<Wrapper {...contextProps({ ...props, node: { data: { source } } })} />)
      expect(screen.getByText('Native context')).not.toBeNull()
    }
    rerender(<Wrapper {...contextProps({ ...props, useTurnData: () => undefined })} />)
    expect(screen.getByText('Native context')).not.toBeNull()
    rerender(<Wrapper {...contextProps({ ...props,
      useTurnData: () => ({ ...process, takeoverSafe: false, takeoverReasons: ['unsupported-tool'] }),
    })} />)
    expect(screen.getByText('Native context')).not.toBeNull()
    expect(container.querySelector('[data-codex-internal-context]')).toBeNull()
    rerender(<Wrapper {...props} />)
    expect(screen.queryByText('Native context')).toBeNull()
    act(unmount)
    expect(screen.getByText('Native context')).not.toBeNull()
  })
})

// The actual public registry owns shadowing and notifications; only the Cordis
// inject lifetime is supplied by this fixture, not the browser slot renderer.
function setup(generation: string) {
  const core = new SlotCore()
  const disposeRoot = core.register({ name: 'root', children: {
    'conversation.chat.node': { kind: 'keyed', scope: 'session', inject: {
      hooks: { turnData: () => () => undefined },
    } },
  } }, (() => null) as never)
  const effects: Array<() => void> = []
  let enabled = false
  const listeners = new Set<() => void>()
  const debug: AdvancedDebugSource = {
    getSnapshot: () => enabled,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  const registerProjection = vi.fn(() => () => {})
  const ctx = {
    slots: {
      register: core.register.bind(core), entries: core.entries.bind(core), subscribe: core.subscribe.bind(core),
      inject: (name: string, effect: () => () => void) => {
        expect(name).toBe(slot)
        effects.push(effect())
      },
    },
    get: (name: string) => generation === 'current'
      ? name === 'uiConversation' ? { events: { register: registerProjection } } : undefined
      : name === 'conversationEvents' ? { register: registerProjection } : undefined,
  } as unknown as ClientContext
  installProcessPresentation(ctx, debug)
  const dispose = () => { while (effects.length) effects.pop()!() }
  disposers.push(() => { dispose(); disposeRoot() })
  return { core, registerProjection, dispose, setDebug: (value: boolean) => {
    enabled = value
    for (const listener of listeners) listener()
  } }
}

function winner(core: SlotCore, key: string): StoredEntry {
  const entry = core.entriesOfSlot(slot).find(value => value.options.key === key)
  if (!entry) throw new Error(`Missing slot entry: ${key}`)
  return entry
}

function safeProcess() {
  return { ...initialCodexProcessState(4, 1000), owned: true, ownedSteps: [2],
    takeoverSafe: true, takeoverReasons: [], firstVisibleSeq: 1 }
}

function presence(sessionId: string, turn: number) {
  let unmount: (() => void) | undefined
  act(() => { unmount = mountProcess(sessionId, turn) })
  const dispose = () => { unmount?.(); unmount = undefined }
  disposers.push(dispose)
  return dispose
}

function assistantProps(overrides: Record<string, unknown> = {}): ChatNodeViewProps<'assistant-step'> {
  return { sessionId: 'wrapper-session', node: { data: { step: 2 } }, useTurnData: () => undefined,
    ...overrides } as unknown as ChatNodeViewProps<'assistant-step'>
}

function contextProps(overrides: Record<string, unknown> = {}): ChatNodeViewProps<'context'> {
  return { sessionId: 'wrapper-session', node: { data: { source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' } } },
    useTurnData: () => undefined, ...overrides } as unknown as ChatNodeViewProps<'context'>
}
