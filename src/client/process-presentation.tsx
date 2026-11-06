import { useSyncExternalStore, type ComponentType } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { StoredEntry, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { CodexProcessView, type ConversationToolPresentation } from './CodexProcessView.tsx'
import { canTakeOverCodexProcess, createCodexProcessDefinition } from './codex-process.ts'
import { useProcessPresence } from './process-presence.ts'
import type { AdvancedDebugSource } from './AdvancedDebug.tsx'
import { conversationEvents } from './compatible-runtime.ts'

type CompatibleNodeProps<K extends 'assistant-step' | 'context'> = Omit<ChatNodeViewProps<K>, 't'> & {
  t: TranslateNS<'chat'> | TranslateNS<'conversation'>
}

/** Optional host policy is independent of relay and may appear or disappear at runtime. */
export function conversationToolPresentation(ctx: ClientContext): ConversationToolPresentation {
  const current = () => (ctx as unknown as { get(name: string): ConversationToolPresentation | undefined }).get('conversationToolPresentation')
  return {
    hideToolRows: sessionId => current()?.hideToolRows(sessionId) ?? false,
    projectAssistantText: (sessionId, turn, text) => current()?.projectAssistantText?.(sessionId, turn, text) ?? text,
    subscribe: listener => {
      let disposePolicy = current()?.subscribe(listener)
      const disposeService = ctx.on('internal/service', name => {
        if (name !== 'conversationToolPresentation') return
        disposePolicy?.()
        disposePolicy = current()?.subscribe(listener)
        listener()
      }, { global: true })
      return () => { disposeService(); disposePolicy?.() }
    },
  }
}

/** Reuse only leaf registrations; child-slot authorization stays with DSH. */
export function installProcessPresentation(ctx: ClientContext, debug: AdvancedDebugSource): void {
  const toolPresentation = conversationToolPresentation(ctx)
  const events = conversationEvents(ctx) as ReturnType<typeof conversationEvents> & {
    registerDisplayProjection?(projection: { id: string; subscribe(listener: () => void): () => void }): () => void
  }
  events.register(createCodexProcessDefinition(toolPresentation.projectAssistantText))
  // Hosts with the shared display boundary can rebuild already materialized
  // turns when this optional service arrives, leaves, or learns their scope.
  events.registerDisplayProjection?.({ id: 'relay-codex-host-presentation', subscribe: toolPresentation.subscribe })
  installContextPresentation(ctx, debug)
  ctx.slots.inject('conversation.chat.node', () => {
    const disposeProcess = ctx.slots.register({
      name: 'conversation.chat.node', key: 'relay-codex-process',
    }, props => <CodexProcessView {...props} toolPresentation={toolPresentation} />)
    let previous: StoredEntry | undefined
    let disposeAssistant: (() => void) | undefined
    const reconcile = (): void => {
      const original = ctx.slots.entries('conversation.chat.node').find(entry =>
        entry.options.key === 'assistant-step' && (entry.options.priority ?? 0) >= 0)
      if (original === previous) return
      disposeAssistant?.()
      disposeAssistant = undefined
      previous = original
      // Fail open on a changed official contract, rather than losing native UI.
      if (!original || original.children || original.store || original.inject
        || (original.locale !== 'chat' && original.locale !== 'conversation')) return
      const Original = original.component as ComponentType<CompatibleNodeProps<'assistant-step'>>
      disposeAssistant = ctx.slots.register({
        name: 'conversation.chat.node', key: 'assistant-step', priority: -20, locale: original.locale,
      }, function CodexAssistantBoundary(props: CompatibleNodeProps<'assistant-step'>) {
        const process = props.useTurnData('relay-codex-process')
        const mounted = useProcessPresence(props.sessionId, process?.turn ?? -1)
        if (mounted && canTakeOverCodexProcess(process) && process?.ownedSteps.includes(props.node.data.step)) return <span hidden data-codex-native-assistant />
        return <Original {...props} />
      })
    }
    const unsubscribe = ctx.slots.subscribe('conversation.chat.node', reconcile)
    reconcile()
    return () => { unsubscribe(); disposeAssistant?.(); disposeProcess() }
  })
}

function installContextPresentation(ctx: ClientContext, debug: AdvancedDebugSource): void {
  ctx.slots.inject('conversation.chat.node', () => {
    let previous: StoredEntry | undefined
    let dispose: (() => void) | undefined
    const reconcile = (): void => {
      const original = ctx.slots.entries('conversation.chat.node').find(entry =>
        entry.options.key === 'context' && (entry.options.priority ?? 0) >= 0)
      if (original === previous) return
      dispose?.(); dispose = undefined; previous = original
      if (!original || original.children || original.store || original.inject || (original.locale !== 'chat' && original.locale !== 'conversation')) return
      const Original = original.component as ComponentType<CompatibleNodeProps<'context'>>
      dispose = ctx.slots.register({
        name: 'conversation.chat.node', key: 'context', priority: -20, locale: original.locale,
      }, function CodexInternalContext(props: CompatibleNodeProps<'context'>) {
        const enabled = useSyncExternalStore(debug.subscribe, debug.getSnapshot, debug.getSnapshot)
        const process = props.useTurnData('relay-codex-process')
        const mounted = useProcessPresence(props.sessionId, process?.turn ?? -1)
        const source = props.node.data.source as { kind?: string; plugin?: string } | null
        if (mounted && canTakeOverCodexProcess(process) && !enabled && source?.kind === 'plugin' && source.plugin === '@deepseek-ai/dsh-system-prompt') {
          return <span hidden data-codex-internal-context />
        }
        return <Original {...props} />
      })
    }
    const unsubscribe = ctx.slots.subscribe('conversation.chat.node', reconcile)
    reconcile()
    return () => { unsubscribe(); dispose?.() }
  })
}
