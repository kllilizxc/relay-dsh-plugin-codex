import { useSyncExternalStore, type ComponentType } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { StoredEntry, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { CodexProcessView } from './CodexProcessView.tsx'
import { canTakeOverCodexProcess, codexProcessDefinition } from './codex-process.ts'
import { useProcessPresence } from './process-presence.ts'
import type { AdvancedDebugSource } from './AdvancedDebug.tsx'
import { conversationEvents } from './compatible-runtime.ts'

type CompatibleNodeProps<K extends 'assistant-step' | 'context'> = Omit<ChatNodeViewProps<K>, 't'> & {
  t: TranslateNS<'chat'> | TranslateNS<'conversation'>
}

/** Reuse only leaf registrations; child-slot authorization stays with DSH. */
export function installProcessPresentation(ctx: ClientContext, debug: AdvancedDebugSource): void {
  conversationEvents(ctx).register(codexProcessDefinition)
  installContextPresentation(ctx, debug)
  ctx.slots.inject('conversation.chat.node', () => {
    const disposeProcess = ctx.slots.register({
      name: 'conversation.chat.node', key: 'relay-codex-process',
    }, CodexProcessView)
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
