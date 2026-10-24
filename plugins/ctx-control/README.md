# ctx-control

`ctx-control` hides selected startup context and blocks selected tools per
working folder before the next model request. It covers instruction files,
memory, skill listings, MCP server instructions, SessionStart hook output, the
subagent type list, built-in tools, deferred tools, and whole MCP servers.

Run `/ctx` to open the tabbed pane. Included items are marked `●`; press an
item or group to change it. Skills, tools, files, and other startup context have
separate tabs with filtering and paging. Eager tool rows cycle through Sent,
On demand, and Blocked. Deferred tools remain searchable until blocked. Each tool
group has a Block all / Unblock all button; unblocking keeps each tool's Sent or
On demand choice. Blocking an MCP server also covers tools that server adds later. Hover a row whose name
or description is cut off to see all of it, with its token count.

Profiles are named sets of what's on, on demand, hidden, and blocked, such as a
Coding profile without vidIQ or Tella and an Editing one without rea or
Playwright. The Profile row at the top of the pane picks one for this folder;
`+ New` saves what's on and off now under a name. Change things after picking a
profile and the row offers Save to it or Revert. A folder's profile is applied
again each session, so saving to a profile reaches every folder that uses it,
and unsaved changes last until the session ends.

Token counts come from Claude Code's own context breakdown (the numbers `/context`
and the desktop app's Context panel show), read in the background when a session
starts, when the pane opens and after turns. Built-in tools and MCP server docs are
reported only as totals, so the pane shares those out and marks the shares "about".
The grey "Fixed" part of the bar is the system prompt and the conversation, which
no switch reaches; with it, the headline equals Claude Code's figure until you hide
something. Claude Code's own panel keeps counting hidden items, since it can't see
what a mod removes; the pane's headline drops.

Commands:

```text
/ctx
/ctx list
/ctx tools
/ctx profile [<name>|save <name>|rename <name> <new-name>|delete <name>|none]
/ctx hide <id-or-pattern> [...]
/ctx show <id-or-pattern> [...]
/ctx only <pattern> [...]
/ctx block <tool|server>
/ctx unblock <tool|server>
/ctx reset
/ctx save-default
/ctx help
```

Patterns may end in `*`, such as `skill:superpowers:*` or `mcpdoc:*`. A block
target may be a full tool name, `mcp__<server>__*`, or a server label shown in
the pane (for example `vidiq`). Folder settings take precedence over the default
preset. Changes apply from the next message and rewrite the prompt cache once if
made mid-session.
