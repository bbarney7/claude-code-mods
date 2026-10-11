# claude-code-mods

Mods for [Claude Code](https://claude.com/claude-code): plugins of function hooks that add live panes, commands and tools inside a running Claude Code session, in the terminal or the desktop app's Code tab.

| Mod | What it does |
| --- | --- |
| [room](plugins/room) | An **agent room**: one chat with OpenAI Codex, Cursor and a second Claude, with `@mentions` and agent-to-agent hand-offs. Also one-shot `/second-opinion` reviews of your diff and `/delegate` implementations. |
| [mod-firewall](plugins/mod-firewall) | A firewall for mods. Every network request, program, secrets-file read and secret env var another mod touches goes through it: ask, block or log. It also catches a mod trying to send your `.env` values or API keys anywhere. |
| [switchboard](plugins/switchboard) | See and message your other Claude Code sessions: who's working on what, `/dm`, `/broadcast`, `/handoff`, an inbox that holds incoming messages for approval, and warnings when another session edited the same file. |
| [cache-keeper](plugins/cache-keeper) | Keeps an idle session's prompt cache warm while you're away, so coming back doesn't re-write the whole conversation. You choose for how long, and whether it then lets the cache expire, compacts, or clears with a handoff. A big conversation that went cold anyway gets its next message stopped once, with the price of re-writing it. |

## Install

In a Claude Code terminal session:

```
/plugin install room --marketplace bbarney7/claude-code-mods
```

Answer `y` to add the marketplace, pick a scope (user is the usual choice), and the mod is active in that session. Sessions started afterwards load it too, including the desktop app's Code tab.

While this repository is private, installing needs a GitHub login with access to it (Claude Code clones it with your git credentials).

Each mod's README lists what else it needs. `room`, for example, uses the Codex, Cursor and Claude ACP adapters.

**In the desktop app's empty chat**, mod commands only appear in their long form, such as `/switchboard:switchboard` or `/room:room`. A mod adds its short commands (`/switchboard`, `/room`) when a session starts, and an empty chat has no session yet. Once a chat is running, both forms work.

## Before you install any mod

A mod is code that runs inside Claude Code with your permissions. It isn't sandboxed: it can read files, run programs, rewrite tool calls and talk to the network. Read a mod's source before you install it, from this repo or any other. Or install [mod-firewall](plugins/mod-firewall) to watch them for you. `claude plugin validate <folder>` lists every event a mod hooks and every engine call it makes. That's a quick way to see what it can do.

## Developing

Each mod is a folder under `plugins/` with three files: `.claude-plugin/plugin.json`, `hooks/hooks.json`, and the hooks module `hooks/register.tsx`. A mod that keeps state adds `types/index.d.ts`. To work on one from a clone:

```
claude --plugin-dir plugins/<mod>          # run it from disk; saving a file reloads it
claude plugin validate plugins/<mod>       # what the engine will load, and anything it would refuse
claude plugin test plugins/<mod>           # its *.test.ts files
```

To add a mod, create its folder under `plugins/`, add an entry to `.claude-plugin/marketplace.json`, and run `claude plugin validate .` at the repository root.

## License

MIT
