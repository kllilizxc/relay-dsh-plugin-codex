import { expect, it, vi } from 'vitest'
import { CodexCardController } from '../src/client/codex-card-controller.ts'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'

it('keeps refused settings drafts visible and releases its host subscription', async () => {
  const unsubscribe = vi.fn()
  const scope = {
    getSnapshot: () => ({ status: 'ready', value: { codexCommand: 'auto' }, writable: true, user: {} }),
    subscribe: () => unsubscribe, set: vi.fn(async () => false), unset: vi.fn(),
  } as unknown as ConfigForm<{ codexCommand?: string }>
  const card = new CodexCardController(scope)
  card.setMode('bundled')
  card.save()
  await vi.waitFor(() => expect(card.inject().hooks.codexCard.getSnapshot().saving).toBe(false))
  expect(card.inject().hooks.codexCard.getSnapshot()).toMatchObject({ dirty: true, failed: true, mode: 'bundled' })
  card.dispose()
  expect(unsubscribe).toHaveBeenCalledTimes(1)
})
