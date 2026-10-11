import type { ClientModule } from 'claude-code'

// The agent room's controls on the desktop, drawn by this surface module: an agent's questions
// and their answers, who is working (a spinner and a clock that run here, with no redraw from the
// hooks), and the room's actions. A Button the room's render hook draws keeps its handle only
// until the next redraw, and the room redraws as agents stream, so a click there can be lost;
// a Button here keeps its own handler, and what it does reaches the hooks as a post.

export type ControlsChoice = { id: string; label: string; kind: string }
export type ControlsQuestion = { id: string; who: string; color: string; question: string; choices: ControlsChoice[] }
export type ControlsWorking = { id: string; who: string; color: string; elapsedMs: number; doing: string }
export type ControlsProps = { questions: ControlsQuestion[]; working: ControlsWorking[]; canInterrupt: boolean; canShare: boolean; canReset: boolean }
// answered: what was pressed on each question still showing; base: the tick each working clock was
// last set from props, so it counts on between redraws; sharedAt: the tick Send to main was pressed.
export type ControlsState = {
  tick: number
  answered: Record<string, string>
  stopping: boolean
  sharedAt?: number
  base: Record<string, { elapsedMs: number; tick: number }>
}

export const TICK_MS = 150
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const SHARED_TICKS = 20
const EMPTY: ControlsState = { tick: 0, answered: {}, stopping: false, base: {} }

export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`
}

// The next frame: clocks re-based on new props; answers, a stop and a "sent" forgotten once done.
export function advance(state: ControlsState, props: ControlsProps): ControlsState {
  const tick = state.tick + 1
  const base: ControlsState['base'] = {}
  for (const w of props.working) {
    const was = state.base[w.id]
    base[w.id] = was && was.elapsedMs === w.elapsedMs ? was : { elapsedMs: w.elapsedMs, tick: state.tick }
  }
  const answered = Object.fromEntries(Object.entries(state.answered).filter(([id]) => props.questions.some(q => q.id === id)))
  const stopping = state.stopping && props.working.length > 0
  const sharedAt = state.sharedAt !== undefined && tick - state.sharedAt < SHARED_TICKS ? state.sharedAt : undefined
  return { tick, base, answered, stopping, ...(sharedAt !== undefined ? { sharedAt } : {}) }
}

// How long an agent has worked: what the hooks last drew, plus the ticks counted here since.
export function elapsed(state: ControlsState, w: ControlsWorking): number {
  const b = state.base[w.id]
  return b && b.elapsedMs === w.elapsedMs ? w.elapsedMs + (state.tick - b.tick) * TICK_MS : w.elapsedMs
}

function isMoving(state: ControlsState, props: ControlsProps): boolean {
  return props.working.length > 0 || state.stopping || state.sharedAt !== undefined || Object.keys(state.answered).length > 0
}

// The timer is set once; it reads the props of the latest draw from here.
let latest: ControlsProps = { questions: [], working: [], canInterrupt: false, canShare: false, canReset: false }

const Controls: ClientModule<ControlsProps, ControlsState> = (props, surface) => {
  const { Box, Text, Button } = surface.elements
  latest = props
  if (surface.state === undefined) {
    surface.setState(EMPTY)
    surface.every(TICK_MS, () => {
      const now = surface.state ?? EMPTY
      if (isMoving(now, latest)) surface.setState(advance(now, latest))
    })
  }
  const state = surface.state ?? EMPTY
  const spin = SPINNER[state.tick % SPINNER.length] ?? '•'
  const answer = (question: ControlsQuestion, choice: ControlsChoice) => () => {
    const now = surface.state ?? EMPTY
    surface.setState({ ...now, answered: { ...now.answered, [question.id]: choice.label } })
    surface.post({ type: 'answer', id: question.id, optionId: choice.id })
  }
  const stop = () => {
    const now = surface.state ?? EMPTY
    if (now.stopping) return
    surface.setState({ ...now, stopping: true })
    surface.post({ type: 'interrupt' })
  }
  const share = () => {
    const now = surface.state ?? EMPTY
    surface.setState({ ...now, sharedAt: now.tick })
    surface.post({ type: 'share' })
  }
  const interruptButton = (
    <Button key="interrupt" label={state.stopping ? 'Stopping…' : 'Interrupt'} variant="secondary" dimColor={state.stopping} onPress={stop} />
  )

  return (
    <Box flexDirection="column" width="100%">
      {props.questions.map(q =>
        state.answered[q.id] ? (
          <Box key={`q-${q.id}`} width="100%" marginBottom={1}>
            <Text color="green">{`${spin} ${state.answered[q.id]} · telling ${q.who}…`}</Text>
          </Box>
        ) : (
          <Box key={`q-${q.id}`} flexDirection="column" width="100%" borderStyle="round" borderColor="yellow" paddingX={1} marginBottom={1}>
            <Text>
              <Text bold color={q.color}>
                {q.who}
              </Text>
              {` wants to ${q.question}`}
            </Text>
            <Box width="100%" gap={1} flexWrap="wrap" marginTop={1}>
              {q.choices.map(choice => (
                <Button
                  key={`${q.id}-${choice.id || 'deny'}`}
                  label={choice.label}
                  variant={choice.kind === 'allow_once' ? 'primary' : 'secondary'}
                  onPress={answer(q, choice)}
                />
              ))}
            </Box>
          </Box>
        ),
      )}
      {props.working.map((w, i) => (
        <Box key={`w-${w.id}`} width="100%" justifyContent="space-between" alignItems="center">
          <Text wrap="truncate-end">
            <Text color={w.color}>{spin}</Text>
            <Text bold color={w.color}>{` ${w.who}`}</Text>
            <Text dimColor>{` · ${clock(elapsed(state, w))} · ${w.doing}`}</Text>
          </Text>
          {i === 0 && props.canInterrupt ? interruptButton : null}
        </Box>
      ))}
      {props.working.length === 0 && (props.canInterrupt || props.canShare || props.canReset) ? (
        <Box width="100%" justifyContent="flex-end" gap={1}>
          {props.canInterrupt ? interruptButton : null}
          {props.canShare ? (
            <Button key="share" label={state.sharedAt !== undefined ? 'Sent to main ✓' : 'Send to main'} variant="secondary" dimColor onPress={share} />
          ) : null}
          {props.canReset ? <Button key="reset" label="New chat" variant="secondary" dimColor onPress={() => surface.post({ type: 'reset' })} /> : null}
        </Box>
      ) : null}
    </Box>
  )
}

export default Controls
