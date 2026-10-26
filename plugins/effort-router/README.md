# effort-router

Sets the reasoning effort of each turn from how demanding its prompt is. "Thanks" and "rename this variable" go out at low effort, an ordinary fix at medium, and a hard design or debugging prompt at xhigh, instead of every turn paying for the session's one setting.

```
/plugin install effort-router --marketplace bbarney7/claude-code-mods
```

Effort sets how much Claude thinks before it answers, and thinking is billed as output, the most expensive tokens. A session left at xhigh thinks just as hard about "yes, do it" as about the bug it was asked to find.

At the first request of each turn, effort-router sends the prompt, with the end of Claude's last reply, to TypeSafe's Jev classifier (`typesafe/jev-1.13` on OpenRouter). The reply is there so a bare "yes" is rated by what it agrees to. Jev answers how likely the turn is to be trivial, standard or hard, and every request of that turn goes out at the matching effort. If Jev has no key, fails, or takes more than 2 seconds, Haiku rates the prompt instead.

## Tested

Changing effort keeps the prompt cache, so routing every turn costs nothing in cache writes. On Opus 5.5, in a 357k-token session, with requests sent at one effort and then another:

| Switch | Read from the cache | Previous prompt | Written to the cache |
| --- | --- | --- | --- |
| xhigh to low | 357,365 | 357,367 | 231 |
| low to xhigh | 357,732 | 357,734 | 189 |

Requests with no switch read 100% and wrote 39 to 231 tokens, so a switch looks like any other request. Across the router's own six switches since, the median read was 99.9996% of the previous prompt. Switching models instead starts a new cache and writes the whole conversation again, which is why this routes effort and not models.

Jev answered in 115 to 340 ms in testing. Some of its ratings:

| Prompt | Rating | Effort |
| --- | --- | --- |
| "thanks!" | trivial, 100% | low |
| "rename cnt to count in utils.ts" | trivial, 95% | low |
| "add a --verbose flag to the CLI" | standard, 87% | medium |
| "find the root cause of a production-only memory leak" | hard, 98% | xhigh |
| "yes", answering "fix that typo?" | trivial, 97% | low |
| "yes", answering an offer to build a whole mod | hard, 50% | xhigh |

## How a turn is rated

- **Hard** once Jev gives hard at least a 40% chance: a fair chance of hard is enough.
- **Trivial** only once Jev gives trivial at least 70%.
- **Standard** when standard is the likeliest answer.
- **Unsure** otherwise: the turn goes out at the **when unsure** effort, which by default is the session's own.

Haiku answers with one word (trivial, standard or hard). When neither Jev nor Haiku answers, the turn goes out at the when-unsure effort.

Every request of a turn goes out at the same effort. A turn with no prompt of its own, such as a continuation, keeps the effort of the turn before it. Subagents keep their own effort, and a model that takes no effort setting is left alone.

After each prompt the status line shows the decision, such as `effort medium · standard · jev trivial 13%, standard 87%, hard 0%`.

## Settings (plugin settings)

| Setting | Values | Default |
| --- | --- | --- |
| OpenRouter API key | your OpenRouter key | empty: reads `OPENROUTER_API_KEY` |
| TypeSafe API key | your TypeSafe key | empty: reads `TYPESAFE_API_KEY` |
| Preferred Jev service | `openrouter`, `typesafe`: used when keys for both are found | `openrouter` |
| Effort for trivial turns | `low`, `medium`, `high`, `xhigh`, `max` | `low` |
| Effort for standard turns | `low`, `medium`, `high`, `xhigh`, `max` | `medium` |
| Effort for hard turns | `low`, `medium`, `high`, `xhigh`, `max` | `xhigh` |
| Effort when unsure | `session` (the session's own effort), or any effort | `session` |
| Rate hard from | 5 to 95% | 40% |
| Rate trivial from | 5 to 99% | 70% |

The key is looked for in that order: the plugin settings, the environment, a key pasted into the settings pane (kept in the macOS Keychain under `effort-router`), then your login shell. The desktop app doesn't start Claude Code from a shell, so a key exported in `~/.zshrc` isn't in its environment; the router asks the shell once per load.

## `/effort-router`

```
/effort-router                  open the settings pane
/effort-router stats            decisions, the key in use, cache reads at switches, output per effort
/effort-router try <prompt>     rate a prompt without changing anything
/effort-router off              send every turn at the session's own effort
/effort-router on               route again
/effort-router reset            clear the stats
```

`/effort-router stats` prints where things stand: on or off, the current turn's rating, the mapping and thresholds, where the key came from, decisions by classifier and by effort, Jev's median decision time and its recent failures, how much of the previous prompt the cache read at effort switches compared with elsewhere, and the median output tokens per request at each effort. It keeps the last 300 decisions and requests across sessions.

`/effort-router` opens the effort router pane (beside the conversation on the desktop, in a pane in the terminal):

- **Enabled**: the same switch as `/effort-router on` and `off`.
- **Routing rules**: the effort for trivial, standard and hard turns, and when unsure.
- **Classifier**: whether Jev is connected and how fast it answered, where the key came from, a choice of service when both have keys, and a field to paste a key, which is saved to your Keychain and checked.

The pane saves its changes in the mod's own store, so they hold in every session and win over the plugin settings above. (Plugin settings are not `/config` rows, so a mod cannot write them.) `/effort-router try <prompt>` shows how a prompt would be rated; the thresholds are changed in the plugin settings. On a phone the pane shows the switch and the current turn only.

## Limits

- **Jev needs an OpenRouter or TypeSafe key.** Without one, Haiku rates every turn. Haiku is a model call on your own Claude account and can take a few seconds (at most 8) before the turn's first request goes out; the pane shows `○ No key · Haiku rates every turn`.
- **The rating comes before the first request.** Jev adds a fraction of a second to each turn, at most 2 seconds, before the router gives up on it.
- **The classifier sees only the prompt and the end of the last reply** (16,000 and 2,000 characters), not the files or the rest of the conversation. A short prompt about a hard problem from much earlier can be rated trivial.
- **One effort per turn.** The router can't raise effort partway through a turn that turns out harder than its prompt looked.
- **The cache is measured; the savings aren't yet.** Lower effort writes less output, but whether routing a realistic mix of work saves usage without hurting results hasn't been tested. `/effort-router stats` logs median output per effort so you can watch it in your own sessions.
- **A pasted key is kept in the macOS Keychain.** Elsewhere, set the key in `/config` or the environment.

## Development

```
claude --plugin-dir plugins/effort-router
claude plugin validate plugins/effort-router
claude plugin test plugins/effort-router
```
