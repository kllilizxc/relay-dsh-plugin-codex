import { Fragment, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { ChevronRight, ChevronDown, LoaderCircle, Brain, TriangleAlert } from 'lucide-react'
import { MarkdownText, DisclosureRow } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatNodeOwnerProps, TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { describeActivity, summarizeActivities } from '../../codex-activity-labels.mjs'
import { ActivityIcon, ActivityRow } from './CodexActivityView.tsx'
import { canTakeOverCodexProcess, codexProcessAnswerSegments, type CodexProcessSegment, type CodexProcessState } from './codex-process.ts'
import { mountProcess } from './process-presence.ts'
import { codexProducedFileMentions } from './process-files.ts'
import css from './CodexProcessView.module.css'
import { useCompatibleChat } from './compatible-chat.ts'

type ProcessProps = PropsRuntime<'conversation.chat.node', 'relay-codex-process'>
type Item = { key: string; activities: CodexProcessSegment[] } | CodexProcessSegment
const markdownLabels = { code: { copyLabel: 'Copy', copiedLabel: 'Copied' }, footnotes: 'Footnotes' }
const compatibleMarkdownLabels = { labels: markdownLabels, codeLabels: markdownLabels.code }
type CompatibleProcessProps = Omit<ProcessProps, 'useChat'> & {
  useChat?: ProcessProps['useChat']
}

export function groupProcessSegments(segments: readonly CodexProcessSegment[]): Item[] {
  const items: Item[] = []
  for (const segment of segments) {
    if (segment.kind === 'reasoning') continue
    if (segment.kind === 'text' && !segment.text?.trim()) continue
    if (segment.kind !== 'activity') { items.push(segment); continue }
    const last = items.at(-1)
    if (last && 'activities' in last) last.activities.push(segment)
    else items.push({ key: segment.key, activities: [segment] })
  }
  return items
}

export function CodexProcessView({ node, sessionId, renderMessageImages, useTurnData, useChat, useSession, openFile, fileMentions, turnProcess }: CompatibleProcessProps) {
  // Legacy activity has no numeric turn in its payload. Its visible anchor still
  // proves an intervening native row; do not move grouped prose across that row.
  const legacyBoundary = useCompatibleChat({ useChat, useSession }, snapshot => [...snapshot.nodes.values()].some(candidate =>
    candidate.kind === 'relay-codex-activity' && candidate.anchorSeq >= (node.data.firstVisibleSeq ?? Infinity)
      && candidate.anchorSeq <= (node.data.lastSeq ?? -1)))
  // Native compact mode controls the containing row. Yield ownership so its
  // final assistant answer remains visible outside the folded process range.
  const safe = canTakeOverCodexProcess(node.data) && !legacyBoundary && !turnProcess?.foldable
  useLayoutEffect(() => safe ? mountProcess(sessionId, node.data.turn) : undefined, [sessionId, node.data.turn, safe])
  const tail = useTurnData('turn-tail')
  const turn = node.location.kind === 'turn' || node.location.kind === 'step' ? node.location.turn : undefined
  const mentions = useMemo(() => {
    if (turn?.status !== 'closed' || !tail?.closing) return undefined
    const owner: TurnTailOwnerProps = { turn, seq: tail.closing.finalNode.seq, openFile }
    return codexProducedFileMentions(node.data.segments, openFile, fileMentions(owner))
  }, [turn, tail, node.data.segments, openFile, fileMentions])
  return safe ? <ProcessBody state={node.data} renderMessageImages={renderMessageImages} fileMentions={mentions} />
    : <span hidden data-codex-process-fallback />
}

export function ProcessBody({ state, renderMessageImages, fileMentions }: {
  state: CodexProcessState
  renderMessageImages: ChatNodeOwnerProps['renderMessageImages']
  fileMentions?: ReturnType<ChatNodeOwnerProps['fileMentions']>
}) {
  const [expanded, setExpanded] = useState<boolean | null>(null)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (state.status !== 'running') return
    const timer = setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { clearInterval(timer) }
  }, [state.status])
  const answerKeys = new Set(codexProcessAnswerSegments(state).map(segment => segment.key))
  const finalIndex = state.segments.findIndex(segment => answerKeys.has(segment.key))
  const process = finalIndex < 0 ? state.segments : state.segments.slice(0, finalIndex)
  const answer = finalIndex < 0 ? [] : state.segments.slice(finalIndex)
  const deliverables = process.filter(segment => segment.kind === 'image')
  const hasProcess = process.some(segment => segment.kind !== 'text' || Boolean(segment.text?.trim()))
  const open = expanded ?? (state.status === 'running' || (answer.length === 0 && deliverables.length === 0))
  // Preserve inline image order when expanded, and keep deliverables visible
  // when earlier work collapses. Image-view tool rows are not deliverables.
  const visibleAnswer = [...(open ? [] : deliverables), ...answer]
  const seconds = Math.max(0, Math.floor(((state.endedAt ?? now) - state.startedAt) / 1000))
  const elapsed = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  const status = state.status === 'running' ? 'Working' : state.status === 'error' ? 'Stopped' : 'Worked'
  return (
    <section className={css.process} data-codex-process-turn={state.turn} data-status={state.status}>
      {hasProcess && <>
        <button className={css.processToggle} type="button" aria-expanded={open}
          onClick={() => { setExpanded(!open) }}>
          <span>{status} for {elapsed}</span>
          {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </button>
        <div className={css.flow} hidden={!open} data-codex-process-content>
          <ProcessItems segments={process} renderMessageImages={renderMessageImages} running={state.status === 'running'} showImages={open} />
          <ReasoningSummary segments={process} />
          {state.error && <div className={css.error} role="status">{state.error}</div>}
        </div>
      </>}
      {visibleAnswer.length > 0 && <div className={css.answer} data-codex-final-answer>
        <ProcessItems segments={visibleAnswer} renderMessageImages={renderMessageImages} running={state.status === 'running'} fileMentions={fileMentions} />
      </div>}
    </section>
  )
}

function ProcessItems({ segments, renderMessageImages, running, fileMentions, showImages = true }: {
  segments: readonly CodexProcessSegment[]
  renderMessageImages: ChatNodeOwnerProps['renderMessageImages']
  running: boolean
  fileMentions?: ReturnType<ChatNodeOwnerProps['fileMentions']>
  showImages?: boolean
}) {
  return groupProcessSegments(segments).map(item => 'activities' in item
    ? <ActivityGroup key={item.key} segments={item.activities} />
    : item.kind === 'image' && item.attachment
      ? showImages ? <Fragment key={item.key}>{renderMessageImages({ images: [{ attachment: item.attachment }], align: 'start' })}</Fragment> : null
      : <div key={item.key} className={css.prose} data-codex-commentary={item.phase !== 'final_answer' || undefined}>
          <MarkdownText text={item.text ?? ''} streaming={running && !item.settled} {...compatibleMarkdownLabels} fileMentions={fileMentions} />
        </div>)
}

export function ActivityGroup({ segments }: { segments: readonly CodexProcessSegment[] }) {
  const [open, setOpen] = useState(false)
  const activities = segments.flatMap(segment => segment.activity ? [segment.activity] : [])
  const active = activities.filter(activity => activity.status === 'running')
  const failed = activities.filter(activity => activity.status === 'error').length
  const current = active.at(-1)
  const representative = current ?? activities.at(-1)
  if (!representative) return null
  const description = describeActivity(representative)
  const title = current ? description.title : summarizeActivities(activities)
  return (
    <div className={css.group} data-codex-activity-group data-count={activities.length}>
      <button type="button" className={css.groupToggle} aria-expanded={open} title={title}
        onClick={() => { setOpen(!open) }}>
        <ActivityIcon category={description.category} />
        <span className={css.groupTitle}>{title}</span>
        {active.length > 0 && <LoaderCircle size={14} className={css.spinner} aria-label="Running" />}
        {active.length > 1 && <span className={css.count}>{active.length} running</span>}
        {failed > 0 && current && <span className={css.error}>{failed} failed</span>}
        {failed > 0 && !current && <TriangleAlert size={14} className={css.error} aria-label="Failed" />}
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {open && <div className={css.activities}>
        {segments.map(segment => segment.activity
          ? <ActivityRow key={segment.key} activity={segment.activity} /> : null)}
      </div>}
    </div>
  )
}

function ReasoningSummary({ segments }: { segments: readonly CodexProcessSegment[] }) {
  const [open, setOpen] = useState(false)
  const text = segments.filter(segment => segment.kind === 'reasoning').map(segment => segment.text).filter(Boolean).join('\n\n')
  if (!text) return null
  return <DisclosureRow title="Thinking" icon={<Brain size={16} />} open={open} expandable expandOnRowClick
    onToggle={() => { setOpen(!open) }}>
    <div className={css.reasoning}><MarkdownText text={text} {...compatibleMarkdownLabels} /></div>
  </DisclosureRow>
}
