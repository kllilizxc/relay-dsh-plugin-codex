import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { ChatSnapshot, UseChat } from '@deepseek-ai/dsh-client-ui-chat/client'

type ChatOwner = { useChat?: UseChat; useSession: ToolCallViewProps['useSession'] }

/** New DSH exposes chat directly; the older session snapshot contains it. */
export function useCompatibleChat<T>(owner: ChatOwner, selector: (chat: ChatSnapshot) => T): T {
  if (owner.useChat) return owner.useChat(selector)
  return owner.useSession((snapshot: unknown) => {
    const legacy = snapshot as { chat?: ChatSnapshot }
    if (!('chat' in legacy)) throw new Error('DSH legacy chat state is unavailable')
    return selector(legacy.chat as ChatSnapshot)
  })
}
