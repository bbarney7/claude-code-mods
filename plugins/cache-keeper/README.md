# cache-keeper

Keeps an idle session's prompt cache warm while you're away, for as long as you choose, then lets it expire, compacts it, or clears it with a handoff, before the cache goes cold.

```
/plugin install cache-keeper --marketplace bbarney7/claude-code-mods
```

Claude Code caches the conversation on Anthropic's side. A message within the cache's lifetime (an hour on Claude subscriptions) reads it for a small fraction of the input price (a twentieth on Opus 5.5, a tenth on most models). A message after it expires writes the whole conversation again at twice the input price. Come back from lunch to a 300k-token session and the first message is the most expensive one of the day.

Cache-keeper watches the clock. Shortly before the cache would expire, and while the session is idle, it asks Claude a one-word side question over the conversation. That request reads the cache, and a read restarts its lifetime.

## Tested

One session per arm on Haiku 4.5, the second message sent 65 minutes after the first, on a 63k-token conversation:

| | Cache read on the 2nd message | Cache written | |
| --- | --- | --- | --- |
| No keep-warm | 16,532 (the shared system prompt only) | 50,632 | expired: the conversation was written again |
| One keep-warm at 50 minutes | 62,931 | 3,953 | still warm |

The keep-warm itself read 62,931 cached tokens and wrote 177.

## Settings (`/config`)

| Setting | Values | Default |
| --- | --- | --- |
| Keep the cache warm while you're away | on / off | on |
| Keep it warm for | hours after Claude's last answer | 2 |
| Before the cache finally expires | `nothing` (let it expire), `compact` (compact while the cache is still warm, so the next message re-caches only the summary), `handoff` (Claude writes a handoff, the conversation is cleared, and the handoff is kept for your next message) | `nothing` |
| Cache lifetime | minutes: 60 on Claude subscriptions, 5 for most API-key sessions | 60 |
| Act this many minutes before expiry | minutes, at most half the lifetime | 5 |

With keep-warm on for 2 hours and `compact`, a session you walk away from stays warm for at least 2 hours, then compacts a few minutes before the cache would have expired. With keep-warm off, the expiry action runs before the first expiry.

## `/keepwarm`

`/keepwarm` shows the cache's time left and what will happen. With arguments it changes this session only:

```
/keepwarm off              stop keeping this session warm
/keepwarm 4h               keep it warm for 4 hours
/keepwarm 90m handoff      keep it warm for 90 minutes, then clear with a handoff
/keepwarm now              keep-warm right away and show what it read from the cache
```

The status line shows `🔥 cache 42m · kept warm 2× · then compact`, or `❄ cache cold`.

## What it costs

A keep-warm reads the conversation from the cache (0.05× the input price on Opus 5.5, 0.1× on most models) plus a few output tokens. Letting a 1-hour cache expire means writing the conversation again at 2× the input price: 20 to 40 times as much. At Opus 5.5's API prices ($4 per million input tokens) a 300k-token session costs about $0.06 per keep-warm against $2.40 for the cold restart. On a subscription it is a small amount of usage instead.

Keep-warms are only worth it for a session you will come back to, which is why they stop after the hours you choose.

## Limits

- **It only counts requests it can see.** A turn or a keep-warm restarts its timer. A side request another mod makes also refreshes the cache but isn't counted, so cache-keeper may keep-warm a little earlier than it needed to.
- **A sleeping computer misses its keep-warm.** If the machine sleeps through the expiry, the cache expires and nothing happens; the status line shows it cold.
- **A model switch starts a new cache.** After `/model`, the next keep-warm writes the conversation again for the new model.
- **A plugin reload forgets the clock** until the next answer.

## Development

```
claude --plugin-dir plugins/cache-keeper
claude plugin validate plugins/cache-keeper
claude plugin test plugins/cache-keeper
```
