import type { ClientKeyEvent, ClientModule } from 'claude-code'

// Switchboard's message box on the desktop, drawn by this surface module: the desktop's own
// text field keeps a fixed width, so this one is drawn and edited here, full width.
// Click it to type; Enter sends, Shift+Enter starts a new line, Escape leaves it.
// Typing @ opens the list of sessions: arrows pick, Tab or Enter makes that session the
// recipient (shown as the To chip), a click on a row does the same.

export type ComposerMention = { id: string; label: string; hint: string; color: string }
export type ComposerProps = { placeholder: string; color: string; to?: string; mentions: ComposerMention[] }
// closedAt: where the @ sits whose list Escape closed, so it stays closed while that word is typed.
export type ComposerState = { text: string; cursor: number; focused: boolean; pick: number; closedAt?: number }

const EMPTY: ComposerState = { text: '', cursor: 0, focused: false, pick: 0 }

// Keys the surface names rather than types; anything else longer than one character is a paste.
const NAMED = new Set(['up', 'down', 'left', 'right', 'return', 'enter', 'tab', 'backspace', 'delete', 'pageup', 'pagedown', 'home', 'end', 'escape', 'insert'])

// The @word the caret is in, if any: where its @ is and what follows it so far.
export function mentionQuery(text: string, cursor: number): { start: number; query: string } | undefined {
  const m = /(^|\s)@([^\s@]*)$/.exec(text.slice(0, cursor))
  if (!m) return undefined
  const query = m[2] ?? ''
  return { start: cursor - query.length - 1, query: query.toLowerCase() }
}

// The mentions the list shows for this state: none when no @word is open or Escape closed it.
export function openMentions(state: ComposerState, mentions: readonly ComposerMention[]): ComposerMention[] {
  const q = mentionQuery(state.text, state.cursor)
  if (!q || q.start === state.closedAt) return []
  return mentions.filter(m => m.label.toLowerCase().includes(q.query)).slice(0, 6)
}

// Picking a session removes the @word typed to find it; the session becomes the recipient.
export function complete(state: ComposerState): ComposerState {
  const q = mentionQuery(state.text, state.cursor)
  if (!q) return state
  const rest = state.text.slice(state.cursor).replace(/^ /, '')
  return { ...state, text: state.text.slice(0, q.start) + rest, cursor: q.start, pick: 0, closedAt: undefined }
}

export function edit(state: ComposerState, key: ClientKeyEvent, mentions: readonly ComposerMention[] = []): { state: ComposerState; send?: string; to?: string } {
  const { text, cursor } = state
  const list = openMentions(state, mentions)
  if (list.length > 0) {
    const pick = Math.min(state.pick, list.length - 1)
    if (key.key === 'down') return { state: { ...state, pick: (pick + 1) % list.length } }
    if (key.key === 'up') return { state: { ...state, pick: (pick - 1 + list.length) % list.length } }
    if (key.key === 'tab' || ((key.key === 'return' || key.key === 'enter') && !key.shift)) return { state: complete(state), to: list[pick]!.id }
    if (key.key === 'escape') return { state: { ...state, closedAt: mentionQuery(text, cursor)?.start } }
  }
  const at = (next: string, move: number) => ({ state: { ...state, text: next, cursor: move, pick: 0 } })
  if (key.key === 'escape') return { state: { ...state, focused: false } }
  if (key.key === 'return' || key.key === 'enter') {
    if (key.shift || key.meta) return at(`${text.slice(0, cursor)}\n${text.slice(cursor)}`, cursor + 1)
    return text.trim() ? { state: { ...EMPTY, focused: state.focused }, send: text.trim() } : { state }
  }
  if (key.key === 'backspace') return cursor > 0 ? at(text.slice(0, cursor - 1) + text.slice(cursor), cursor - 1) : { state }
  if (key.key === 'delete') return at(text.slice(0, cursor) + text.slice(cursor + 1), cursor)
  if (key.key === 'left') return { state: { ...state, cursor: Math.max(0, cursor - 1) } }
  if (key.key === 'right') return { state: { ...state, cursor: Math.min(text.length, cursor + 1) } }
  if (key.key === 'home' || (key.ctrl && key.key === 'a')) return { state: { ...state, cursor: 0 } }
  if (key.key === 'end' || (key.ctrl && key.key === 'e')) return { state: { ...state, cursor: text.length } }
  if (key.ctrl && key.key === 'u') return at(text.slice(cursor), 0)
  if (key.ctrl || key.meta || NAMED.has(key.key)) return { state }
  const typed = key.key === 'space' ? ' ' : key.key.replace(/\r\n?/g, '\n')
  return at(text.slice(0, cursor) + typed + text.slice(cursor), cursor + typed.length)
}

// The listeners are set once; they read the props of the latest draw from here.
let latest: ComposerProps = { placeholder: '', color: 'gray', mentions: [] }

const Composer: ClientModule<ComposerProps, ComposerState> = (props, surface) => {
  const { Box, Text, Button } = surface.elements
  latest = props
  if (surface.state === undefined) {
    surface.onPointer(event => {
      if (event.type !== 'down') return
      const now = surface.state ?? EMPTY
      // The list's rows sit just under the box's top border: a click on one picks that session.
      const list = openMentions(now, latest.mentions)
      const row = list[event.y - 1]
      if (row) surface.post({ type: 'to', name: row.id })
      surface.setState(row ? complete({ ...now, focused: true }) : { ...now, focused: true })
    })
    surface.onKey(key => {
      const result = edit(surface.state ?? { ...EMPTY, focused: true }, key, latest.mentions)
      if (result.to) surface.post({ type: 'to', name: result.to })
      if (result.send) surface.post({ type: 'send', text: result.send })
      surface.setState(result.state)
    })
  }
  const state = surface.state ?? EMPTY
  const list = state.focused ? openMentions(state, props.mentions) : []
  const pick = Math.min(state.pick, Math.max(0, list.length - 1))
  const shown = state.focused ? `${state.text.slice(0, state.cursor)}▏${state.text.slice(state.cursor)}` : state.text
  const send = () => {
    if (!state.text.trim()) return
    surface.post({ type: 'send', text: state.text.trim() })
    surface.setState({ ...EMPTY, focused: state.focused })
  }

  return (
    <Box flexDirection="column" width="100%">
      <Box flexDirection="column" width="100%" borderStyle="round" borderColor={state.focused ? props.color : 'gray'} paddingX={1}>
        {list.map((mention, i) => (
          <Box key={`mention-${mention.id}`} width="100%" gap={1}>
            <Text color={props.color}>{i === pick ? '▸' : ' '}</Text>
            <Text color={mention.color}>●</Text>
            <Text bold={i === pick} dimColor={i !== pick}>{mention.label}</Text>
            <Text dimColor>{mention.hint}</Text>
          </Box>
        ))}
        <Box minHeight={2} width="100%" marginTop={list.length ? 1 : 0}>
          {state.text || state.focused ? <Text>{shown}</Text> : <Text dimColor>{props.placeholder}</Text>}
        </Box>
        <Box width="100%" justifyContent="space-between" alignItems="center">
          <Box gap={1} alignItems="center">
            {props.to ? (
              <Button key="to-clear" label={`To ${props.to}  ✕`} variant="secondary" onPress={() => surface.post({ type: 'to', name: null })} />
            ) : (
              <Text dimColor>Type @ to pick a session</Text>
            )}
          </Box>
          <Button key="send" label="Send ↵" variant="primary" onPress={send} />
        </Box>
      </Box>
    </Box>
  )
}

export default Composer
