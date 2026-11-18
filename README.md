# @greatyingzi/dsh-monitor

**Hardened fork** of [`dsh-monitor`](https://github.com/AbnerAI/dsh-monitor) for DeepSeek Harness.

This fork fixes a class of bugs where a monitor callback could silently lose its notice,
wake an archived/dead agent, storm an agent with wake-ups, or park a notice forever —
leaving the owning session stuck in `running` with no way for new messages to wake it.

## How it works

The model calls the `monitor` tool to arm a watcher on a source:

- **`source: file`** — an append-only NDJSON inbox. New lines are delivered as they land.
- **`source: command`** — a shell command re-run on an interval. Its output delta is delivered.

On each new message the plugin wakes the owning agent:

| Agent state | Behavior |
|---|---|
| **idle** (within wake budget) | `agent.followup()` — opens a new turn |
| **busy** or budget exhausted | `agent.inject()` — queued, then re-offered as a follow-up at idle |

## Delivery hardening (v0.2.0)

Modeled on the official `dsh-schedule` and `dsh-tool-jobs` delivery contracts:

- owner is stored as `agent.id` and resolved live via `ctx.get("agents").get(id)`;
  archived or missing owners are disarmed, never woken;
- every delivery must be acknowledged by `ctx.sessions.flush(agent.session)` before the
  source cursor advances — a failed wake is retried, never silently lost;
- `maxConsecutiveWakes` (default 2) + `minDeliveryIntervalMs` (default 5000) bound wake storms;
- notices injected into a busy agent are tracked and re-offered as a follow-up at idle;
- timers run under `agents.withoutInitiator()` and ticks are re-entrancy guarded;
- identical consecutive content is de-duplicated by fingerprint.

## Install

```bash
npx @deepseek-ai/dsh@latest plugin --profile web add @greatyingzi/dsh-monitor
```

Or, before npm publish, install straight from git:

```bash
npx @deepseek-ai/dsh@latest plugin --profile web add https://github.com/greatyingzi/dsh-monitor.git
```

## Tools

- `monitor(source, path|command, cwd?, poll_interval_ms?, name?)` — arm a watcher; returns `{ id, source, description }`.
- `monitor_list` — list armed watchers with delivery counts.
- `monitor_stop(id)` — disarm a watcher.

## Config

Set via the bundle config block in your profile patch:

| Key | Default | Meaning |
|---|---|---|
| `maxNoticeBytes` | 4096 | max wake-up message bytes |
| `defaultPollIntervalMs` | 2000 | default poll interval |
| `minDeliveryIntervalMs` | 5000 | minimum ms between two deliveries per watcher |
| `maxConsecutiveWakes` | 2 | consecutive wakes before falling back to inject |
| `parkedNoticeTimeoutMs` | 30000 | how long a parked notice may wait before re-offer |

## License

MIT (inherited from upstream).
