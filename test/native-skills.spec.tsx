import { describe, it, expect } from 'vitest'
import { nativeSkillSource } from '../src/client/native-skills.ts'
const session = { sessionId: 's' } as any
const req = (query = '', signal = new AbortController().signal) => ({ query, signal, position: 'leading', drilled: false }) as any

describe('native skill menu', () => {
  it('shares discovery while filtering keystrokes and preserves native invocation syntax', async () => {
    for (const backend of ['codex', 'claude'] as const) {
      let calls = 0
      const source = nativeSkillSource(backend, () => true, (async () => {
        calls++; return new Response(JSON.stringify({ skills: [{ name: 'review-code', description: 'Review', path: '/tmp/skill/SKILL.md' }] }))
      }) as typeof fetch)
      const [all, matches] = await Promise.all([source.candidates(session, req()), source.candidates(session, req('rc'))])
      expect(calls).toBe(1); expect(matches).toEqual(all)
      expect(await source.candidates(session, req('zzz'))).toEqual([])
      expect(source.onPick!({ candidate: all[0] } as any)).toEqual({ text: backend === 'codex'
        ? '$review-code ' : '/review-code ' })
    }
  })
  it('qualifies duplicate skill names using the full catalog, even after filtering', async () => {
    const source = nativeSkillSource('codex', () => true, (async () => new Response(JSON.stringify({ skills: [
      { name: 'review', description: 'Project', path: '/project/SKILL.md' },
      { name: 'review', description: 'User', path: '/user/SKILL.md' },
      { name: 'handoff', description: 'Handoff', path: '/user/handoff/SKILL.md' },
    ] }))) as typeof fetch)
    const rows = await source.candidates(session, req('review'))
    expect(rows.map(candidate => source.onPick!({ candidate } as any))).toEqual([
      { text: '[$review](/project/SKILL.md) ' }, { text: '[$review](/user/SKILL.md) ' },
    ])
    const [handoff] = await source.candidates(session, req('handoff'))
    expect(source.onPick!({ candidate: handoff } as any)).toEqual({ text: '$handoff ' })
  })
  it('does not fetch for other modes and drops a response after switching modes', async () => {
    let active = false; let calls = 0; let resolve!: (value: Response) => void
    const source = nativeSkillSource('codex', () => active, (() => { calls++; return new Promise(r => { resolve = r }) }) as typeof fetch)
    expect(await source.candidates(session, req())).toEqual([]); expect(calls).toBe(0)
    active = true; const pending = source.candidates(session, req()); active = false
    resolve(new Response(JSON.stringify({ skills: [{ name: 'example' }] })))
    expect(await pending).toEqual([])
  })
  it('retries failed discovery and discards cancelled keystrokes', async () => {
    let calls = 0
    const source = nativeSkillSource('claude', () => true, (async () => ++calls === 1
      ? new Response('', { status: 503 })
      : new Response(JSON.stringify({ skills: [{ name: 'example' }] }))) as typeof fetch)
    await expect(source.candidates(session, req())).rejects.toThrow('503')
    const cancel = new AbortController(); cancel.abort()
    expect(await source.candidates(session, req('', cancel.signal))).toEqual([])
    expect((await source.candidates(session, req())).length).toBe(1)
    expect(calls).toBe(2)
  })
})
