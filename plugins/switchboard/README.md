# switchboard

See and talk to your other Claude Code sessions from inside the one you're in.

```
/plugin install switchboard --marketplace bbarney7/claude-code-mods
```

Claude Code can already message other sessions on the same machine: its `SendMessage` tool reaches any session that `ListAgents` lists. Switchboard adds the parts for you as the human: a view of every session, messages you send yourself, an inbox that controls what reaches Claude, and warnings when two sessions edit the same file.

## What it does

| | |
|---|---|
| `/switchboard` | A pane listing every running session: busy or idle, and for sessions that also run Switchboard, their repository, branch, Syntaur ticket and the file they last edited. Each one has a **Message** button. |
| `/dm <session> <message>` | Message a session yourself. Its replies show up in the pane. |
| `/broadcast <message>` | Message every session that runs Switchboard ("main is frozen for 10 minutes"). |
| `/handoff <session>` | Claude writes a handoff of this session (goal, done, in progress, decisions, open problems, next step) and sends it to another session. |
| **Inbox** | Messages from other sessions can wait in the pane until you choose **Pass to Claude**, **Reply** or **Dismiss**. A held message is never shown to Claude. |
| **Collision warnings** | Before Claude edits a file, Switchboard checks whether another session edited the same file recently: "⚠ src/auth/session.ts was edited by run-0f (2m ago)". |

## Settings (`/config`)

| Setting | Values | Default |
| --- | --- | --- |
| Messages from other sessions | `deliver` (Claude Code's normal behavior), `hold-other-repos` (deliver from sessions in the same repository, hold the rest), `hold` (hold everything) | `hold-other-repos` |
| When another session edited the same file | `warn` (warning, edit goes ahead), `ask` (ask before the edit; Cancel refuses it and tells Claude to coordinate), `off` | `warn` |
| How recent counts as a collision | minutes | 30 |

## Why hold messages?

A message from another session arrives in Claude's conversation much like a prompt. A session that is confused, or working from a poisoned web page or file, could tell your other sessions what to do. Holding messages from sessions outside the current repository by default means a stranger session can't steer this one without you seeing it first.

## How it works

- **The session list** comes from Claude Code's own `ListAgents` tool, called by the mod.
- **Presence** (repository, branch, ticket, busy or idle, recently edited files) is shared through the mod's store. Sessions running Switchboard see each other's; other sessions show just their name and state. No files are written outside Claude Code's own storage.
- **Messages** go through Claude Code's cross-session messaging (`$.session.send`), the same channel `SendMessage` uses. Incoming ones are recognised by their `<cross-session-message from-name="…">` envelope.

## Limits

- **Edits only through Claude's editing tools count.** Edits made through Edit, Write, MultiEdit and NotebookEdit are tracked. Edits made by shell commands (`sed -i`, scripts) are not.
- **Branch and ticket only appear for sessions running Switchboard.** Other sessions show only what `ListAgents` reports.
- **Session names are Claude Code's.** They're often generated from the folder (`shared-56`), and the pane shows them as they are.

## Development

```
claude --plugin-dir plugins/switchboard
claude plugin validate plugins/switchboard
claude plugin test plugins/switchboard
```
