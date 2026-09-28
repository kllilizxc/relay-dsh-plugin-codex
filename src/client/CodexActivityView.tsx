import { memo, useState } from 'react'
import { BookOpen, FilePenLine, FolderOpen, Image, ListChecks, Search, Terminal, Wrench } from 'lucide-react'
import {
  DisclosureRow,
  StateDot,
  type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { readActivityPayload } from '../../codex-activity-wire.mjs'
import { describeActivity, type ActivityCategory } from '../../codex-activity-labels.mjs'
import type { CodexActivityData } from './codex-activity.ts'
import css from './CodexActivityView.module.css'
import { useProcessPresence } from './process-presence.ts'
import { useCompatibleChat } from './compatible-chat.ts'
import { canTakeOverCodexProcess } from './codex-process.ts'

type CodexActivityViewProps = PropsRuntime<'conversation.chat.node', 'relay-codex-activity'>

function dotState(status: CodexActivityData['status']): StateDotState {
  if (status === 'running') return 'ongoing'
  if (status === 'error') return 'error'
  return 'done'
}

export function ActivityIcon({ category }: { category: ActivityCategory }) {
  const Icon = category === 'read' ? BookOpen
    : category === 'search' || category === 'webSearch' ? Search
      : category === 'listFiles' ? FolderOpen
        : category === 'edit' ? FilePenLine
          : category === 'image' || category === 'imageGeneration' ? Image
            : category === 'plan' ? ListChecks
              : category === 'command' ? Terminal : Wrench
  return <Icon size={16} strokeWidth={1.6} aria-hidden="true" data-activity-icon={category} />
}

export const CodexActivityView = memo(function CodexActivityView({ node }: CodexActivityViewProps) {
  const activity = node.data as CodexActivityData
  return <ActivityRow activity={activity} />
})

export function GroupedCodexToolActivityView(props: ToolCallViewProps) {
  const process = useCompatibleChat(props, snapshot => {
    const native = [...snapshot.nodes.values()].find(node => node.kind === 'tool-call' && node.id === props.callId)
    const location = native?.location
    if (location?.kind !== 'turn' && location?.kind !== 'step') return undefined
    return location.turn.data.get('relay-codex-process')
  })
  const mounted = useProcessPresence(props.sessionId, process?.turn ?? -1)
  const represented = process?.segments.some(segment => segment.callId === props.callId)
  if (mounted && canTakeOverCodexProcess(process) && represented && props.block.subCalls.length === 0) {
    return <span hidden data-codex-grouped-call={props.callId} />
  }
  return <CodexToolActivityView {...props} />
}

export function CodexToolActivityView({ block }: ToolCallViewProps) {
  let payload = 'kind' in block && block.meta && typeof block.meta === 'object'
    ? readActivityPayload((block.meta as Record<string, unknown>).codexActivity)
    : null
  if (payload === null) {
    const args = 'kind' in block ? block.call?.argsRaw : block.argsRaw
    try { payload = readActivityPayload(JSON.parse(args ?? 'null')) } catch { /* Malformed history uses a safe fallback. */ }
  }
  const activity: CodexActivityData = payload === null
    ? { type: 'unknown', title: 'Codex activity', status: 'kind' in block ? (block.isError ? 'error' : 'completed') : 'running' }
    : {
        ...payload.activity,
        ...('kind' in block ? { status: block.isError ? 'error' as const : 'completed' as const } : {}),
        provenance: { threadId: payload.threadId, turnId: payload.turnId },
      }
  return <ActivityRow activity={activity} />
}

export function ActivityRow({ activity }: { activity: CodexActivityData }) {
  const [open, setOpen] = useState(false)
  const description = describeActivity(activity)
  const expandable = activity.input !== undefined || activity.output !== undefined || activity.provenance !== undefined
  const commandTranscript = activity.type === 'commandExecution'
    ? [activity.input, activity.output].filter((value): value is string => value !== undefined && value !== '').join('\n\n')
    : undefined
  return (
    <div className={css.activity} data-codex-activity={activity.type} data-status={activity.status} title={description.title}>
      <DisclosureRow
        icon={<ActivityIcon category={description.category} />}
        title={description.title}
        titleClassName={css.title}
        rowClassName={css.row}
        open={open}
        expandable={expandable}
        onToggle={() => { setOpen(value => !value) }}
        expandOnRowClick
        collapsedContent={(
          <span className={css.summary}>
            {activity.status !== 'completed' ? <StateDot state={dotState(activity.status)} size={8} /> : null}
          </span>
        )}
      >
        <div className={css.detail}>
          {activity.provenance !== undefined ? (
            <div
              className={css.provenance}
              title={`Codex App Server · Thread ${activity.provenance.threadId} · Turn ${activity.provenance.turnId}`}
            >
              Codex App Server · Thread {shortId(activity.provenance.threadId)} · Turn {shortId(activity.provenance.turnId)}
            </div>
          ) : null}
          {commandTranscript !== undefined && commandTranscript !== '' ? (
            <DetailBlock label="Shell" text={commandTranscript} />
          ) : (
            <>
              {activity.input !== undefined ? <DetailBlock label="Input" text={activity.input} /> : null}
              {activity.output !== undefined ? <DetailBlock label="Output" text={activity.output} /> : null}
            </>
          )}
          <div className={css.footer}>
            {activity.exitCode !== undefined ? <span>exit {activity.exitCode}</span> : <span />}
            <span>{statusLabel(activity.status)}</span>
          </div>
        </div>
      </DisclosureRow>
    </div>
  )
}

function DetailBlock({ label, text }: { label: string; text: string }) {
  return (
    <section className={css.detailBlock}>
      <div className={css.detailLabel}>{label}</div>
      <pre>{text}</pre>
    </section>
  )
}

function statusLabel(status: CodexActivityData['status']): string {
  if (status === 'running') return 'Running'
  if (status === 'error') return 'Failed'
  return 'Success'
}

function shortId(value: string): string {
  return value.length > 15 ? `${value.slice(0, 8)}...${value.slice(-4)}` : value
}
