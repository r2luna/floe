// The agent's to-do list for the work in front of it, whichever harness answers.
//
// Two sources feed one shape. `set_checklist` (mcpServer.ts) is Floe's own tool,
// so every harness with the MCP server gets the same list. Claude's native
// TodoWrite and Task tools are folded in as well, because they are still the
// default on older models (and a model holding them may prefer them).

export type ChecklistStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'

export interface ChecklistItem {
  /** Only the Task tools have one: an update names its item by it. */
  id?: string
  text: string
  /** The present-tense label shown while the step runs: "Running the gate". */
  active?: string
  status: ChecklistStatus
}

const STATUSES: readonly string[] = ['pending', 'in_progress', 'completed', 'cancelled']

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : undefined

const statusOf = (value: unknown): ChecklistStatus =>
  STATUSES.includes(value as string) ? (value as ChecklistStatus) : 'pending'

/** Is there anything left to do? A finished list is a record, not a progress bar. */
export function checklistOpen(items: readonly ChecklistItem[]): boolean {
  return items.some((item) => item.status === 'pending' || item.status === 'in_progress')
}

/** `2 of 5 · Running the gate`, for the tool's reply and the transcript's row. */
export function checklistSummary(items: readonly ChecklistItem[]): string {
  const done = items.filter((item) => item.status === 'completed').length
  const now = items.find((item) => item.status === 'in_progress')
  const count = `${done} of ${items.length}`
  return now ? `${count} · ${now.active ?? now.text}` : count
}

/** What a call to a whole-list tool reads as in the transcript, or undefined for any other tool. */
export function checklistRow(name: unknown, input: unknown): string | undefined {
  if (name === 'TodoWrite') return checklistSummary(fromTodoWrite(input))
  if (typeof name !== 'string' || !name.endsWith('set_checklist')) return undefined
  const items = (input as { items?: unknown } | null)?.items
  return Array.isArray(items) ? checklistSummary(items as ChecklistItem[]) : undefined
}

/** TodoWrite sends the whole list on every call: `{ todos: [{ content, status, activeForm }] }`. */
export function fromTodoWrite(input: unknown): ChecklistItem[] {
  const todos = (input as { todos?: unknown } | null)?.todos
  if (!Array.isArray(todos)) return []
  return todos.flatMap((todo: Record<string, unknown>) => {
    const text = str(todo?.content)
    return text ? [{ text, active: str(todo.activeForm), status: statusOf(todo.status) }] : []
  })
}

/** TaskCreate adds one item. Its id only exists in the tool's result, hence the argument. */
export function addCreatedTask(
  items: readonly ChecklistItem[],
  id: string,
  input: unknown
): ChecklistItem[] {
  const task = (input ?? {}) as Record<string, unknown>
  const text = str(task.subject)
  if (!text) return [...items]
  return [...items, { id, text, active: str(task.activeForm) ?? str(task.active_form), status: 'pending' }]
}

/**
 * TaskUpdate patches one item. The stream carries the input as the model wrote
 * it, before the CLI repairs near-miss keys, so `id`, `task_id` and `active_form`
 * all have to be read as well.
 */
export function applyTaskUpdate(items: readonly ChecklistItem[], input: unknown): ChecklistItem[] {
  const patch = (input ?? {}) as Record<string, unknown>
  const id = str(patch.taskId) ?? str(patch.id) ?? str(patch.task_id)
  if (!id) return [...items]
  if (patch.status === 'deleted') return items.filter((item) => item.id !== id)
  return items.map((item) => {
    if (item.id !== id) return item
    return {
      ...item,
      text: str(patch.subject) ?? item.text,
      active: str(patch.activeForm) ?? str(patch.active_form) ?? item.active,
      status: STATUSES.includes(patch.status as string) ? (patch.status as ChecklistStatus) : item.status
    }
  })
}
