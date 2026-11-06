// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import type React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  MarkdownText: ({text}: {text:string}) => <div>{text}</div>,
  DisclosureRow: ({children}: {children:React.ReactNode}) => <div>{children}</div>,
  StateDot: () => null,
}))
import { CodexProcessView } from '../src/client/CodexProcessView.tsx'
import { initialCodexProcessState } from '../src/client/codex-process.ts'
afterEach(cleanup)
it('keeps early Relay text mounted while native tool envelopes make the active turn foldable', () => {
  const state = {...initialCodexProcessState(1, Date.now()), owned:true, ownedSteps:[1],
    takeoverSafe:true, takeoverReasons:[], firstVisibleSeq:1,
    segments:[{key:'block:1:0',seq:1,step:1,index:0,kind:'text' as const,text:'I will hand this off.',phase:'commentary' as const,settled:true}]}
  const props = {
    node:{data:state,location:{kind:'turn',turn:{status:'running'}}},sessionId:'live-relay-fold',
    renderFactorySlot:()=>null,openFile:()=>{},useTurnData:()=>undefined,
    useChat:(select:(value:unknown)=>unknown)=>select({nodes:new Map()}),fileMentions:()=>undefined,
  } as unknown as React.ComponentProps<typeof CodexProcessView>
  const {container,rerender}=render(<CodexProcessView {...props}/>)
  expect(screen.getByText('I will hand this off.')).not.toBeNull()
  rerender(<CodexProcessView {...props} turnProcess={{foldable:true} as never}/>)
  expect(screen.getByText('I will hand this off.')).not.toBeNull()
  expect(container.querySelector('[data-codex-process-turn]')).not.toBeNull()
  rerender(<CodexProcessView {...props} turnProcess={{foldable:true} as never} node={{...props.node,data:{...state,status:'completed'}}}/>)
  expect(container.querySelector('[data-codex-process-turn]')).toBeNull()
})
