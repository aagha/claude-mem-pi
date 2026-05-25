# claude-mem for pi

Pi extension that shares [claude-mem](https://github.com/thedotmack/claude-mem)'s persistent memory store with Claude Code. Observations, context injection, and session summaries all flow through the same local worker — both harnesses read from and write to one shared memory.

## What claude-mem does

[claude-mem](https://github.com/thedotmack/claude-mem) is a persistent memory compression system for AI coding assistants. It captures what you do in each session, extracts learnings via an AI agent, stores them locally (SQLite + ChromaDB), and injects relevant context back into future sessions automatically.

Without it, every session starts from scratch. With it, your agent remembers what you built last week, which bugs you fixed yesterday, and what architectural decisions you made.

## What this extension adds

Claude Code has native claude-mem support via hooks. Pi doesn't — until now. This extension gives pi the same memory capabilities, writing to and reading from the exact same store.

| Feature | How it works |
|---|---|
| **Context injection** | At session start, fetches observations and summaries from past sessions and prepends them to pi's system prompt |
| **Observation capture** | Every tool call (read, write, bash, edit, search) is sent to the worker for AI extraction |
| **Session summaries** | On `/quit` or `/exit`, the session is summarized and stored for future context |
| **Exclusion respect** | Reads `~/.claude-mem/settings.json` — excluded projects are skipped, same as Claude Code |

Everything appears in the claude-mem web viewer at `http://127.0.0.1:37700` with a green **PI** source pill.

## How it works

```
pi session start
  ├── Read ~/.claude-mem/settings.json (port, exclusions, skip-tools)
  ├── Check if cwd is excluded → skip if so
  ├── Generate contentSessionId (pi-{uuid})
  ├── Fetch context from worker: GET /api/context/inject?project=<name>
  └── Prepend context to first system prompt

each user prompt
  └── POST /api/sessions/init (registers prompt for observation tracking)

each tool call
  └── POST /api/sessions/observations (tool name, args, flattened result)

session end (/quit, /exit)
  └── POST /api/sessions/summarize (last assistant message)
```

The worker (Express HTTP server on `127.0.0.1:37700`) handles all storage, AI processing, and search. It runs as a daemon started by Claude Code and stays alive across sessions. Pi never starts or stops it — it just calls the REST API.

## Install

```bash
pi install npm:claude-mem
```

Or via git:

```bash
pi install git:github.com/aagha/claude-mem-pi@v1.0.0
```

## Requirements

- [claude-mem](https://github.com/thedotmack/claude-mem) v13+ installed in Claude Code
- Claude Code opened at least once since boot (starts the worker daemon at `127.0.0.1:37700`)
- `~/.claude-mem/settings.json` must exist (created automatically by claude-mem)

## Pros and cons

**Pros:**
- Shared memory with Claude Code — observations from either harness pool together
- Zero configuration — reads existing claude-mem settings
- Graceful degradation — if the worker is down, pi runs normally without errors
- Green PI source pill in the web viewer distinguishes pi-sourced entries

**Cons:**
- Requires claude-mem to be installed and the worker running (no standalone mode)
- Context injection adds tokens to the first prompt (controlled by claude-mem's `CLAUDE_MEM_CONTEXT_OBSERVATIONS` setting)
- Observation extraction quality depends on the model configured in claude-mem (default: haiku)

## Proof it works

Here's a real session showing cross-harness memory. A script was created in Claude Code, then pi remembered it in a new session via context injection:

**Claude Code session** (2:30 PM):
```
> create a goodbye world script and run it
```
→ claude-mem extracted observation #444: "Created goodbye_world.py script"

**Pi session** (2:31 PM, same project, fresh start):
```
> what scripts did I create in this session?
```
→ pi answered from claude-mem context without listing files:

> Two scripts, both created today:
>
> | Script | Created | Size |
> |---|---|---|
> | goodbye_world.py | 2:30 PM | 25 bytes |
> | farewell_world.py | 2:31 PM | 26 bytes |

Both harnesses, one memory.

## License

MIT
