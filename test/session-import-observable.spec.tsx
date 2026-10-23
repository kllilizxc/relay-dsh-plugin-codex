// @vitest-environment jsdom
import { Component as ReactComponent, useSyncExternalStore, type ErrorInfo, type ReactNode } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/client/native-skills.ts', () => ({ installNativeSkills() {} }))
vi.mock('../src/client/CodexRuntimeSettings.tsx', () => ({ installRuntimeSettings() {} }))
vi.mock('../src/client/compatible-runtime.ts', () => ({ withConversationRuntime: () => () => {}, conversationEvents: () => ({ register() {} }) }))
vi.mock('../src/client/CodexActivityView.tsx', () => ({ CodexActivityView: () => null, GroupedCodexToolActivityView: () => null }))
vi.mock('../src/client/process-presentation.tsx', () => ({ installProcessPresentation() {} }))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ Button: () => null, Modal: () => null }))

import { apply } from '../src/client/index.ts'

afterEach(cleanup)

function registeredImport() {
  const sessions = { byId: { alpha: { id: 'alpha', retainedBy: { mainView: 1 } } } }
  const workspaces = { items: [{ workspaceId: 'workspace', title: 'Workspace', path: '/work', sessionIds: ['alpha'] }] }
  let registration: any
  let Component: any
  const ctx = {
    sessions: { list: { getSnapshot: () => sessions, subscribe: () => () => {} } },
    workspaces: { list: { getSnapshot: () => workspaces, subscribe: () => () => {} } },
    locale: { bind: () => (key: string) => key },
    effect() {},
    slots: {
      inject(name: string, install: () => void) { if (name === 'relay.session-import.provider') install() },
      register(options: any, component: any) { registration = options; Component = component; return () => {} },
    },
  }
  apply(ctx as never)
  return { ctx, registration, Component }
}

describe('registered session import observable', () => {
  it('mounts the registered provider with real React external-store subscriptions', () => {
    const { ctx, registration, Component } = registeredImport()
    const injected = registration.inject()
    const hooks = Object.fromEntries(Object.entries(injected.hooks ?? {}).map(([name, source]: any) => [
      'use' + name[0].toUpperCase() + name.slice(1),
      (select: (state: any) => unknown) => select(useSyncExternalStore(source.subscribe, source.getSnapshot)),
    ]))
    const registerProvider = vi.fn(() => () => {})
    const useSessions = (select: (state: any) => unknown) => select(useSyncExternalStore(ctx.sessions.list.subscribe, ctx.sessions.list.getSnapshot))
    const useWorkspaces = (select: (state: any) => unknown) => select(useSyncExternalStore(ctx.workspaces.list.subscribe, ctx.workspaces.list.getSnapshot))
    let caught: Error | undefined
    class Capture extends ReactComponent<{children: ReactNode}, {failed: boolean}> {
      state = {failed: false}
      static getDerivedStateFromError() { return {failed: true} }
      componentDidCatch(error: Error, info: ErrorInfo) { caught = error; console.error('SESSION_IMPORT_COMPONENT_STACK', info.componentStack) }
      render() { return this.state.failed ? null : this.props.children }
    }
    render(<Capture><Component {...injected} {...hooks} registerProvider={registerProvider} useSessions={useSessions} useWorkspaces={useWorkspaces} t={(key: string) => key} /></Capture>)
    expect(caught).toBeUndefined()
    expect(registerProvider).toHaveBeenCalledTimes(1)
  })
})
