export type Readiness = 'ready' | 'after-deploy' | 'waiting-decision'

export type Item = {
  id: number
  title: string
  project?: string | null
  readiness: Readiness
  done: boolean
  done_by: string | null
}

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
  status: 'sent' | 'taken' | 'done' | 'rejected' | 'closed' | 'needs-changes'
  assignee: string | null
  replies: number
  closed_by?: string | null
  readiness: Readiness
  readiness_note?: string | null
  items_total?: number
  items_done?: number
  projects?: string[]
  items_here_total?: number | null
  items_here_done?: number | null
  delivery?: 'local' | 'pushed' | 'pr' | 'merged' | null
  related?: number[]
}

export type Thread = Row & { unread: number; last_reply_by: string; last_reply_excerpt: string }

export type Detail = Row & {
  text: string
  note: string | null
  delivery_refs?: string[]
  items: Item[]
  replies: { id: number; team: string; user: string; text: string; created_at: string }[]
}

export type View = { id: number | null; detail: Detail | null; problem: string; fresh: number }

export type Inbox = {
  isLoaded: boolean
  isOffline: boolean
  user: string
  team: string
  project: string
  projects: string[]
  waiting: number
  waitingForProject: number
  overdue: number
  takenByMe: number
  returned: number
  rows: Row[]
  returnedRows: Row[]
  hiddenRows: Row[]
  unreadReplies: number
  threads: Thread[]
}

export type HandoffEvent = {
  type: 'new' | 'edited' | 'taken' | 'reply' | 'done' | 'rejected' | 'needs-changes' | 'closed' | 'withdrawn' | 'progress' | 'ready' | 'reopened' | 'delivered'
  id: number
  title: string
  project: string
  priority: Row['priority']
  by_team: string
  by_user: string
  from_user?: string
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
      confirming: number | null
      selected: number[]
      showHidden: boolean
      lastClosed: number | null
    }
  }
}
