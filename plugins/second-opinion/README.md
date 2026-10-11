# second-opinion

Bring OpenAI Codex, Cursor and a second Claude into Claude Code.

- **Agent room:** one chat in a side pane with Codex, Cursor and a separate Claude agent. `@mention` an agent to pick who answers. Agents can `@mention` each other to hand work off, and `@main` brings in your main Claude session.
- **One-shot reviews:** `/second-opinion` has Codex and/or Cursor review your uncommitted changes (or the last commit). One button sends their findings to Claude.
- **Delegation:** `/delegate` has Codex or Cursor implement a task in your repo.
- **Tools for Claude:** your main Claude can talk to the room (`ask_agent`) or hand off a task (`delegate_task`) on its own.

## Install

```
/plugin install second-opinion --marketplace bbarney7/claude-code-mods
```

The install may say "4 userConfig options not yet set". That's fine: the defaults apply, and you can change them any time in `/config` (see [Context settings](#context-settings-config)).

### Requirements

- **Claude Code 2.1.291 or newer.** Mods shipped in 2.1.287. This mod is developed and tested on 2.1.291.
- **Node.js 18 or newer** on `PATH`. The room runs a small Node bridge.
- **The agents you want in the room.** Each is optional; a missing one shows an install hint in the room.

| Agent | Room adapter | One-shot commands use |
| --- | --- | --- |
| Codex | `npm i -g @agentclientprotocol/codex-acp`, then `codex login` | `codex` CLI |
| Cursor | `curl https://cursor.com/install -fsS \| bash`, then `cursor-agent login` | `cursor-agent` CLI |
| Claude | `npm i -g @agentclientprotocol/claude-agent-acp` | — |

Every agent uses its own subscription or login. Nothing here asks for an API key.

## Commands

| Command | What it does |
| --- | --- |
| `/room` | Open the agent room (also `/second-opinion:room`, which the desktop app lists from the start) |
| `/room model [agent] [model] [effort]` | Show each agent's model, or pick one (`/room model codex gpt-6-luna low`); `/room model codex reset` forgets the pick |
| `/ask [@codex\|@cursor\|@claude\|@main] <message>` | Say something in the room (opens the pane if needed) |
| `/second-opinion [codex\|cursor\|both] [focus]` | Review the current changes; results in the *Second opinion* pane |
| `/delegate <codex\|cursor> <task>` | Have an outside agent implement a task |
| `/opinions` | Reopen the *Second opinion* pane |

Tools Claude can call: `ask_agent` (talk to Codex, Cursor or the room's Claude, and get the reply) and `delegate_task` (one-shot implementation).

## How the room works

```
Claude Code ── mod (panes, routing, @mentions) ──spawn── node bridge ──ACP/stdio── codex-acp
                     ▲  events on stdout                                ├──────── cursor-agent acp
                     └─ commands over a Unix socket ───────────────────└──────── claude-agent-acp
```

- **Long-lived sessions.** The bridge keeps one adapter process per agent and talks to it over the [Agent Client Protocol](https://agentclientprotocol.com). Follow-ups don't start a new process, agents remember the conversation, and replies stream into the pane along with the tools each agent uses.
- **Routing happens in code.** A message goes to the agents it `@mentions`. With no mention it goes to whoever you addressed last. Mentions inside backticks or code fences don't count.
- **Hand-offs.** When an agent's reply `@mentions` another participant, that participant gets a turn. Chains stop at 3 hops, and a bare "thanks" ends one. A reply to whoever asked is just an answer, not a hand-off.
- **Permissions follow your session.** The room's agents get the permission mode of the session you opened the room from, and it changes when that mode changes (it's picked up from your next prompt, tool call or turn end):

  | Main session | Codex | Cursor | Room's Claude |
  | --- | --- | --- | --- |
  | bypass permissions | `agent-full-access`; the room answers anything it still asks | `agent`; the room answers its questions | `bypassPermissions` |
  | auto | `agent` (auto review) | `agent` | `auto` |
  | accept edits | `workspace-write` (asks outside the repo) | `agent` | `acceptEdits` |
  | default | `read-only` (asks before edits) | `ask` (only reads) | `default` |
  | plan | `read-only`, told to only plan | `ask` | `plan` |

  The room's header shows the level in use. Set **Room: what agents may do** in `/config` to `allow` (always edit) or `ask` (always ask first) to pin it. When an agent asks, the question appears above the message box with short buttons (Codex's "Yes, and don't ask again for commands that start with `npm test`" becomes **Always allow npm test**); your answer is noted in the room. Codex needs `@agentclientprotocol/codex-acp` 2.x for the gpt-6 models.
- **Pick each agent's model.** The model button in the message box (desktop) or `/room model` lists the selected agent's models and effort levels, as the agent reports them; the pick is remembered across sessions. Without one, Codex and Claude use their own default model at medium effort.
- **Short replies.** Agents are asked to answer first and briefly. Their narration between tool calls ("I'll check the tests…") is folded away under the answer, which is also all that `ask_agent` hands back to Claude.
- **Something is always visibly happening.** While an agent works, a line under the transcript shows a spinner, how long it has been working and what it's running, with **Interrupt**. Pressed buttons change at once (**Stopping…**, **Allow · telling Codex…**). On the desktop these controls are drawn by the mod's own surface modules, so a click is never lost to a redraw while agents stream.
- **The room's Claude is separate from your main session.** It's its own Claude Code session and loads your plugins. This mod notices when it's running there and stays inactive, so there's no room inside the room.

## Context settings (`/config`)

How much crosses between your main session and the room:

| Setting | Values | Default |
| --- | --- | --- |
| Room: context from the main Claude session | `none` · `recent` (last N turns) · `summary` (a briefing your main Claude writes, from its cached transcript) · `full` (capped at 60,000 characters) | `recent` |
| Room: turns to share when seeding `recent` | number | 10 |
| Room: context sent back to the main session (on `@main` or **Send room to main**) | `message` · `recent` · `summary` (Haiku) · `full` (capped at 30,000 characters) | `message` |
| Room: messages to send back for `recent` | number | 8 |

**Privacy note:** in `summary` mode, the briefing is written by your main Claude, so it can include anything that Claude sees, including your instruction files (`CLAUDE.md`). Codex and Cursor also load their own configuration (`~/.codex/config.toml`, Cursor rules, the project's `AGENTS.md`).

## Limits

- **The room lasts as long as the session.** Agent processes run until Claude Code exits or you click **New chat**. The room isn't saved across restarts.
- **The room Claude is a full Claude Code session:** expect roughly 35k tokens of standing context and about 600 MB of memory. It only starts the first time someone mentions `@claude`.
- **The `full` and `recent` seeds are snapshots taken when an agent's session starts.** Use **New chat** to re-seed after a lot has changed.

## Development

```
claude --plugin-dir plugins/second-opinion
claude plugin validate plugins/second-opinion
claude plugin test plugins/second-opinion
```

To test the bridge on its own: `node bridge/acp-bridge.mjs --socket /tmp/x.sock --cwd <repo>`, then `curl --unix-socket /tmp/x.sock -X POST http://b/prompt -d '{"agent":"cursor","turn":"t1","text":"hi"}'`. Events print to stdout. See the header of `bridge/acp-bridge.mjs` for the protocol.
