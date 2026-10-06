# mod-firewall

A firewall for Claude Code mods. Mods run inside Claude Code with your permissions and aren't sandboxed. This one watches what every other mod does and asks you, blocks the call, or logs it.

```
/plugin install mod-firewall --marketplace bbarney7/claude-code-mods
```

## What it watches

Every engine call another mod makes passes through the firewall first, labelled with the mod that made it:

| Kind of call | Info (logged, allowed) | Sensitive (ask, or block in strict) | Critical (always asks; strict blocks) |
| --- | --- | --- | --- |
| Network (`http.fetch`) | — | any request | a request whose URL, headers or body contain a value from your `.env` files or a known token shape (Anthropic, OpenAI, GitHub, AWS, Slack, Google keys, private keys) |
| Processes (`process.run`, `process.spawn`) | — | any program it starts | — |
| File reads | ordinary files | secrets files: `.env*`, SSH keys, `*.pem`/`*.key`, `.aws/credentials`, `.npmrc`, `.netrc`, `gh` hosts, `.docker/config.json`, `.kube/config`, `~/.claude.json`, Codex auth | — |
| File writes | inside the project, temp folders | outside the project, shell rc files, LaunchAgents, git hooks, `authorized_keys` | — |
| Environment variables | ordinary names | names with `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `AUTH`, `COOKIE`, `SESSION`… | — |
| Transcript (`session.messages`) | logged | — | — |

Calls made by Claude Code itself, by its built-in plugins, and by plugins your administrator manages aren't policed. The firewall never gets in Claude Code's own way.

## Modes (`/config`)

| Setting | Values | Default |
| --- | --- | --- |
| Mode | `ask`: sensitive calls open a dialog (Allow once / Allow for this session / Always trust this mod / Block). `strict`: sensitive calls are blocked unless the mod is trusted. `audit`: allow everything and log it. | `ask` |
| Trusted mods | comma-separated names; trusted mods skip the dialog for sensitive calls, but critical ones still ask | empty |
| Refuse risky mods at load | refuse to load an untrusted mod whose source pairs the network with processes, files, secret env vars or the transcript | off |

Mods you trust from the dialog or the pane are remembered across sessions. In a headless run (`claude -p`) nobody is there to answer, so `ask` behaves like `strict`. It fails closed.

## The pane

`/firewall` opens it. It lists every mod the firewall has seen, with a risk level and badges for what its source uses (network, processes, reads files, secret env, reads transcript, hooks tool calls, rewrites prompts, watches other mods), its counts of allowed and blocked calls, and **Trust** / **Block** buttons. Below that is a live activity feed. Blocked calls also show as a toast and a count in the status line.

## Limits

- **The load-time check only sees mods that load after the firewall.** Mods that loaded earlier are still guarded on every call, but their source scan isn't shown. To make the firewall load first, run it from a folder: add its path to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`. Mods loaded that way come before installed ones.
- **It guards what mods do through Claude Code's engine.** A mod that starts a program (once you've allowed it) has handed control to that program, and anything the program does is outside the firewall's view. That's why every process start is treated as sensitive.
- **Hooks are watched, not stopped.** A mod that hooks tool calls can auto-approve them or rewrite them. The firewall flags that capability in the pane ("hooks tool calls") but doesn't interfere with the hooks themselves.
- **Secret detection is pattern-based.** It catches `.env` values (8 characters or more), their URL-encoded forms, and common token shapes. It doesn't catch secrets that have been encrypted, split or base64-encoded first.

## Development

```
claude --plugin-dir plugins/mod-firewall
claude plugin validate plugins/mod-firewall
claude plugin test plugins/mod-firewall
```
