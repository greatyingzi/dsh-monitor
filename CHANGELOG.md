# Changelog

## 0.2.0 (2026-11-19)

- Hardened delivery layer modeled on dsh-schedule / dsh-tool-jobs:
  - resolve owner Agent by id at delivery time; disarm archived/missing owners;
  - require `sessions.flush()` ack before advancing source cursor;
  - enforce per-watcher min delivery interval and consecutive-wake budget;
  - re-offer parked notices as follow-ups when the owner reaches idle;
  - detach watcher timers from the arming agent via `agents.withoutInitiator()`;
  - guard ticks against re-entrancy; de-duplicate identical consecutive content;
  - upgraded peer compatibility to the 0.2.x host runtime.
- Forked from AbnerAI/dsh-monitor v0.1.1; renamed to `@greatyingzi/dsh-monitor`.
