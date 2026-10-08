export type Row = {
  id: number
  title: string
  project: string
  from_team: string
  from_user: string
  to_team: string
  to_user: string | null
  created_at: string
  version: number
  priority: 'low' | 'normal' | 'high' | 'urgent'
  due: string | null
  overdue: boolean
  status: 'sent' | 'taken' | 'done' | 'rejected' | 'needs-changes'
  assignee: string | null
  replies: number
}

export type Detail = Row & {
  text: string
  note: string | null
  replies: { id: number; team: string; user: string; text: string; created_at: string }[]
}

export type View = { id: number | null; detail: Detail | null; problem: string }

export type Inbox = {
  isLoaded: boolean
  user: string
  project: string
  waiting: number
  waitingForProject: number
  overdue: number
  takenByMe: number
  returned: number
  rows: Row[]
  returnedRows: Row[]
}

export type HandoffEvent = {
  type: 'new' | 'edited' | 'taken' | 'reply' | 'done' | 'rejected' | 'needs-changes' | 'withdrawn'
  id: number
  title: string
  project: string
  priority: Row['priority']
  by_team: string
  by_user: string
  note: string
  notify: boolean
}

declare module 'claude-code' {
  interface PluginState {
    handoff: {
      inbox: Inbox
      latest: HandoffEvent | null
      view: View
      seenBefore: number
      places: Record<string, string>
    }
  }
}
