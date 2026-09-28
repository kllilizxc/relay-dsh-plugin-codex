import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionEventMap } from '@deepseek-ai/dsh-session/types'

type SessionEventContractAnchor = SessionEventMap

export type CodexActivityStatus = 'running' | 'completed' | 'error'

export interface CodexActivityData {
  readonly type: string
  readonly status: CodexActivityStatus
  readonly title: string
  readonly summary?: string
  readonly input?: string
  readonly output?: string
  readonly exitCode?: string
  readonly commandActions?: string
  readonly provenance?: {
    readonly threadId: string
    readonly turnId: string
  }
}

export interface CodexActivityEventData {
  readonly version: 1
  readonly threadId: string
  readonly turnId: string
  readonly itemId: string
  readonly phase: 'started' | 'completed'
  readonly activity: CodexActivityData
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'relay-codex/activity': CodexActivityEventData
  }
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    'relay-codex-activity': CodexActivityData
  }
}

export const codexActivityDefinition: ConversationNodeDefinition<CodexActivityData> = {
  kind: 'relay-codex-activity',
  target: 'chat',
  match: event => event.type === 'relay-codex/activity'
    ? { id: event.data.itemId, role: event.data.phase === 'started' ? 'start' : 'update' }
    : null,
  start: (_context, match) => {
    if (match.event.type !== 'relay-codex/activity') {
      throw new Error('Codex activity start requires relay-codex/activity')
    }
    return {
      ...match.event.data.activity,
      provenance: {
        threadId: match.event.data.threadId,
        turnId: match.event.data.turnId,
      },
    }
  },
  update: (context, match) => match.event.type === 'relay-codex/activity'
    ? {
        ...match.event.data.activity,
        provenance: {
          threadId: match.event.data.threadId,
          turnId: match.event.data.turnId,
        },
      }
    : context.state,
  buildViewNode: (context): ChatConversationViewNode | null => {
    if (context.start === undefined || context.state === undefined) return null
    return {
      key: context.key,
      kind: 'relay-codex-activity',
      id: context.id,
      target: 'chat',
      anchorSeq: context.start.event.seq,
      location: context.start.location,
      visibility: 'visible',
      data: context.state,
    }
  },
}
