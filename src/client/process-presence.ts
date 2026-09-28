import { useSyncExternalStore } from 'react'

const mounted = new Map<string, number>()
const listeners = new Set<() => void>()
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
const notify = (): void => { for (const listener of listeners) listener() }
const keyOf = (sessionId: string, turn: number): string => JSON.stringify([sessionId, turn])

/** Suppression is reversible and only active after the replacement mounts. */
export function mountProcess(sessionId: string, turn: number): () => void {
  const key = keyOf(sessionId, turn)
  mounted.set(key, (mounted.get(key) ?? 0) + 1)
  notify()
  return () => {
    const count = (mounted.get(key) ?? 1) - 1
    if (count === 0) mounted.delete(key)
    else mounted.set(key, count)
    notify()
  }
}

export function useProcessPresence(sessionId: string, turn: number): boolean {
  return useSyncExternalStore(subscribe, () => mounted.has(keyOf(sessionId, turn)), () => false)
}
