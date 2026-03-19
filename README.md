# claude-pulse

A Claude Code statusline that combines real-time session vitals with cost tracking.

```
git:(main*) | ████░░░░░░ 42% | Sonnet 4.6 | 2 CLAUDE.md | 6 MCPs | ⏱ 5m | $0.80 (订阅) 5h:9%@17:00 | 7d:12%@5.9d | 日:$0.80 周:$14
◐ Edit: src/index.ts | ✓ Read ×4 | ✓ Bash ×11
✓ Explore [haiku]: Finding relevant files (5s)
▸ Fix auth bug (2/5)
```

**Line 1** — always visible:
- `git:(branch*)` — current branch + dirty indicator
- `████░░░░░░ 42%` — context window usage with green→red gradient
- `Sonnet 4.6` — actual model in use (reads from transcript)
- `2 CLAUDE.md | 6 MCPs | 4 hooks | ⏱ 5m` — config counts + session duration
- `$0.80 (订阅) 5h:9%@17:00` — today's cost + 5h quota with reset time
- `7d:12%@5.9d` — 7-day quota with days until reset
- `日:$0.80 周:$14` — daily and weekly cost summary

**Lines 2+** — only when active:
- Tools being used / recently completed
- Subagents (with type, description, elapsed time)
- Todo progress

## Requirements

- **bun** ≥ 1.0 — [bun.sh](https://bun.sh)
- **ccusage** — `npm install -g ccusage` or `bun add -g ccusage`
- Claude Code subscription (OAuth) for quota data; API mode shows costs only

## Installation

```
/plugin marketplace add cf-jx/claude-pulse
/plugin install claude-pulse
/claude-pulse:setup
```
