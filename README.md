# claude-mem for pi

Pi extension that shares [claude-mem](https://github.com/thedotmack/claude-mem)'s persistent memory store with Claude Code. Observations, context injection, and session summaries flow through the same worker — both harnesses contribute to and benefit from one shared memory.

## How it works

- Reads `~/.claude-mem/settings.json` for worker port, exclusions, and skip-tools
- At session start: fetches context from past sessions and injects it into the system prompt
- During session: sends every tool call as an observation to the worker
- On `/quit` or `/exit`: queues a session summary

Entries appear in the claude-mem web viewer (`http://127.0.0.1:37700`) with a green **PI** source pill.

## Requirements

- [claude-mem](https://github.com/thedotmack/claude-mem) installed and configured in Claude Code
- Claude Code opened at least once since boot (starts the worker daemon)

## Install

```bash
pi install npm:claude-mem
# or via git:
pi install git:github.com/aagha/claude-mem-pi
```

Or locally:

```bash
pi install ./path/to/claude-mem
```

## Verify

Check the viewer at `http://127.0.0.1:37700` — pi-sourced prompts and observations show with a green PI pill.
