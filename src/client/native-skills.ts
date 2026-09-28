import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { sessionPreset } from '../../dsh-client-compat.mjs'

type Skill = { name: string; description: string; path?: string; argumentHint?: string }

export function nativeSkillSource(
  backend: 'codex' | 'claude',
  isActive: (id: SessionId) => boolean,
  request: typeof fetch = fetch,
): InputTriggerSource {
  // Share catalog reads across keystrokes; expire so newly installed skills appear.
  const catalogs = new Map<SessionId, { at: number; value: Promise<Skill[]> }>()
  return {
    trigger: '/', name: `relay-${backend}-skills`, order: 2, showGroupTitle: false,
    async candidates(session, { query, signal, position }) {
      const id = session.sessionId
      if (!isActive(id) || (backend === 'claude' && position !== 'leading')) return []
      let cached = catalogs.get(id)
      if (!cached || Date.now() - cached.at > 30_000) {
        const value = request(`/api/relay/${backend}/skills?sessionId=${encodeURIComponent(id)}`)
          .then(async response => {
            if (!response.ok) throw new Error(`Native skills unavailable (${response.status})`)
            return (await response.json() as { skills: Skill[] }).skills
          })
        cached = { at: Date.now(), value }
        catalogs.set(id, cached)
        const entry = cached
        void value.catch(() => { if (catalogs.get(id) === entry) catalogs.delete(id) })
      }
      const skills = await cached.value
      if (signal.aborted || !isActive(id)) return []
      const nameCounts = new Map<string, number>()
      for (const skill of skills) nameCounts.set(skill.name, (nameCounts.get(skill.name) ?? 0) + 1)
      const needle = query.toLowerCase()
      return skills.filter(skill => {
        let offset = 0
        for (const char of needle) {
          const next = skill.name.toLowerCase().indexOf(char, offset)
          if (next < 0) return false
          offset = next + 1
        }
        return true
      }).sort((a, b) => Number(b.name.toLowerCase().startsWith(needle)) - Number(a.name.toLowerCase().startsWith(needle)))
        .map(skill => ({ name: skill.name, description: skill.description,
          section: backend === 'codex' ? 'Codex skills' : 'Claude Code skills',
          hint: skill.argumentHint,
          // Plain native mentions keep both the draft and persisted user message readable.
          // Codex cannot resolve duplicate names, so only those need path qualification.
          value: nameCounts.get(skill.name) === 1
            ? `$${skill.name}` : `[$${skill.name}](${skill.path})` }))
    },
    onPick({ candidate }) {
      // Send native mentions directly; do not expose transport syntax for unique skills.
      return { text: backend === 'codex'
        ? `${candidate.value} `
        : `/${candidate.name} ` }
    },
  }
}

export function installNativeSkills(ctx: Context, backend: 'codex' | 'claude'): void {
  ctx.effect(() => ctx.inputTriggers.registerSource(nativeSkillSource(backend, id =>
    sessionPreset(ctx.sessions.list.getSnapshot().byId[id]) === `relay-${backend}`,
  )), `relay-${backend}: native skills`)
}
