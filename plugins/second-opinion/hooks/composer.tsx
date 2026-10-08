import type { ClientKeyEvent, ClientModule } from 'claude-code'

// The agent room's message box on the desktop, drawn by this surface module: the desktop's
// own text field keeps a fixed width, so this one is drawn and edited here, full width.
// Click it to type; Enter sends, Shift+Enter starts a new line, Escape leaves it.

export type ComposerChip = { id: string; label: string; selected: boolean }
export type ComposerProps = { placeholder: string; color: string; chips: ComposerChip[] }
type ComposerState = { text: string; cursor: number; focused: boolean }

// Keys the surface names rather than types; anything else longer than one character is a paste.
const NAMED = new Set(['up', 'down', 'left', 'right', 'return', 'enter', 'tab', 'backspace', 'delete', 'pageup', 'pagedown', 'home', 'end', 'escape', 'insert'])

export function edit(state: ComposerState, key: ClientKeyEvent): { state: ComposerState; send?: string } {
  const { text, cursor } = state
  const at = (next: string, move: number) => ({ state: { ...state, text: next, cursor: move } })
  if (key.key === 'escape') return { state: { ...state, focused: false } }
  if (key.key === 'return' || key.key === 'enter') {
    if (key.shift || key.meta) return at(`${text.slice(0, cursor)}\n${text.slice(cursor)}`, cursor + 1)
    return text.trim() ? { state: { ...state, text: '', cursor: 0 }, send: text.trim() } : { state }
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

const Composer: ClientModule<ComposerProps, ComposerState> = (props, surface) => {
  const { Box, Text, Button } = surface.elements
  if (surface.state === undefined) {
    surface.onPointer(event => {
      if (event.type === 'down') surface.setState({ ...(surface.state ?? { text: '', cursor: 0 }), focused: true })
    })
    surface.onKey(key => {
      const result = edit(surface.state ?? { text: '', cursor: 0, focused: true }, key)
      if (result.send) surface.post({ type: 'send', text: result.send })
      surface.setState(result.state)
    })
  }
  const state = surface.state ?? { text: '', cursor: 0, focused: false }
  const shown = state.focused ? `${state.text.slice(0, state.cursor)}▏${state.text.slice(state.cursor)}` : state.text
  const send = () => {
    if (!state.text.trim()) return
    surface.post({ type: 'send', text: state.text.trim() })
    surface.setState({ ...state, text: '', cursor: 0 })
  }

  return (
    <Box flexDirection="column" width="100%">
      <Box flexDirection="column" width="100%" borderStyle="round" borderColor={state.focused ? props.color : 'gray'} paddingX={1}>
        <Box minHeight={2} width="100%">
          {state.text || state.focused ? <Text>{shown}</Text> : <Text dimColor>{props.placeholder}</Text>}
        </Box>
        <Box width="100%" justifyContent="space-between" alignItems="center">
          <Box gap={1} alignItems="center">
            {props.chips.map(chip => (
              <Button
                key={`to-${chip.id}`}
                label={chip.label}
                variant={chip.selected ? 'primary' : 'secondary'}
                dimColor={!chip.selected}
                onPress={() => surface.post({ type: 'to', agent: chip.id })}
              />
            ))}
          </Box>
          <Button key="send" label="Send ↵" variant="primary" onPress={send} />
        </Box>
      </Box>
      {!state.focused && !state.text ? <Text dimColor>{'  click to type · Enter sends · Shift+Enter for a new line'}</Text> : null}
    </Box>
  )
}

export default Composer
