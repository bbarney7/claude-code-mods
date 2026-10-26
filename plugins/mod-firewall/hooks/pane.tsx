import type { ClientElements, ClientModule } from 'claude-code'

// The firewall pane's body, one layout for both surfaces. On the desktop this module draws it: a
// Button the pane's render hook draws keeps its handle only until the next redraw, and the pane
// redraws on every call a mod makes, so a click there can be lost ("ui_press not handled" in the
// app's log); a Button here keeps its own handler, and what it does reaches the hooks as a post.
// The terminal draws the same body from the render hook, its Buttons calling the hooks directly.

export type PaneMod = { name: string; color: string; summary: string; badges: string[]; trusted: boolean; blocked: boolean; refused: boolean }
export type PaneEntry = { id: string; color: string; dim: boolean; text: string }
export type PaneProps = { header: string; mods: PaneMod[]; feed: PaneEntry[] }
export type PaneAction = { type: 'trust' | 'untrust' | 'block' | 'unblock'; mod: string } | { type: 'clear' }
// pressed: the action last pressed on each mod, shown until the hooks' next props say it took.
export type PaneState = { pressed: Record<string, string> }

export function paneBody(el: Pick<ClientElements, 'Box' | 'Text' | 'Button'>, p: PaneProps, act: (a: PaneAction) => void, pressed: Record<string, string> = {}) {
  const { Box, Text, Button } = el
  return (
    <Box flexDirection="column">
      <Text dimColor>{p.header}</Text>
      {p.mods.length === 0 && <Text dimColor>No other mods have done anything yet.</Text>}
      {p.mods.map(mod => (
        <Box key={mod.name} flexDirection="column" marginTop={1}>
          <Text>
            <Text bold color={mod.color}>{mod.name}</Text>
            <Text dimColor>{`  ${mod.summary}`}</Text>
          </Text>
          {mod.badges.length > 0 && <Text dimColor>{`  ${mod.badges.join(' · ')}`}</Text>}
          {pressed[mod.name] ? (
            <Text color="warning">{`  ${pressed[mod.name]}…`}</Text>
          ) : (
            !mod.refused && (
              <Box>
                {!mod.trusted && <Button key={`trust-${mod.name}`} label="Trust" onPress={() => act({ type: 'trust', mod: mod.name })} />}
                {mod.trusted && <Button key={`untrust-${mod.name}`} label="Untrust" onPress={() => act({ type: 'untrust', mod: mod.name })} />}
                {!mod.blocked && <Button key={`block-${mod.name}`} label="Block" onPress={() => act({ type: 'block', mod: mod.name })} />}
                {mod.blocked && <Button key={`unblock-${mod.name}`} label="Unblock" onPress={() => act({ type: 'unblock', mod: mod.name })} />}
              </Box>
            )
          )}
        </Box>
      ))}
      <Text bold>{'\nActivity'}</Text>
      {p.feed.length === 0 && <Text dimColor>Nothing yet.</Text>}
      {p.feed.map(entry => (
        <Text key={entry.id} color={entry.color} dimColor={entry.dim}>
          {entry.text}
        </Text>
      ))}
      {p.feed.length > 0 && <Button key="clear" label="Clear activity" onPress={() => act({ type: 'clear' })} />}
    </Box>
  )
}

const PRESSED: Record<PaneAction['type'], string> = { trust: 'Trusting', untrust: 'Untrusting', block: 'Blocking', unblock: 'Unblocking', clear: 'Clearing' }

// What each mod showed when its button was pressed: a press is done once that changes.
let shown: Record<string, string> = {}

const Pane: ClientModule<PaneProps, PaneState> = (props, surface) => {
  const now = Object.fromEntries(props.mods.map(m => [m.name, `${m.trusted}${m.blocked}`]))
  const pressed = Object.fromEntries(Object.entries(surface.state?.pressed ?? {}).filter(([name]) => now[name] === shown[name]))
  const act = (a: PaneAction) => {
    if (a.type !== 'clear') {
      shown = { ...shown, [a.mod]: now[a.mod] ?? '' }
      surface.setState({ pressed: { ...pressed, [a.mod]: PRESSED[a.type] } })
    }
    surface.post(a)
  }
  return paneBody(surface.elements, props, act, pressed)
}

export default Pane
