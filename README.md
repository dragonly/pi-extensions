# pi-extensions

Personal [pi coding agent](https://github.com/mariozechner/pi-coding-agent) extensions.

## Extensions

### `current-model.ts`

Exposes the currently active pi model to the agent via a `get_current_model` tool and a `/current-model` slash command.

Useful for automatically populating the `Co-authored-by` trailer in git commit messages without asking the user for the model name.

### `loop.ts`

Schedules recurring prompts in the current pi session.

```
/loop 10m check for new PR comments
/loop 30s ping me a haiku
/loop 10m --max=5 summarize latest logs
/loop list
/loop stop <id>
/loop           # interactive manage panel
```

- Ticks are skipped (not queued) when the agent is busy, keeping the cadence clean.
- Default fire cap is 10; use `--max=0` for unlimited.
- Active task count and time-to-next-tick are shown in the footer status bar.

### `last-assistant-time.ts`

Shows the timestamp of the most recent assistant response in the footer status bar (e.g. `last reply: 14:32:07 (2m ago)`).

- Reads the current branch's last assistant message via `SessionManager.getBranch()`, so `/tree` navigation and `/fork` are handled correctly.
- Refreshes on `session_start`, on each assistant `message_end`, and every 30s to keep the relative "Xm ago" fresh.

## Usage

Drop `.ts` files into your pi extensions directory (typically `~/.pi/agent/extensions/`) and restart pi or reload extensions.

See the [pi extensions docs](https://github.com/mariozechner/pi-coding-agent) for the full `ExtensionAPI` reference.
