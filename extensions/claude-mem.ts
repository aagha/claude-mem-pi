/**
 * claude-mem integration for pi
 *
 * Shares the same memory store as Claude Code — observations, context injection,
 * and session summaries all flow through the claude-mem worker at 127.0.0.1:37700.
 *
 * Reads ~/.claude-mem/settings.json for port, exclusions, and skip-tools list.
 * Uses the worker's HTTP API for all operations. Gracefully degrades if the
 * worker is not running (Claude Code hasn't been opened this boot).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync } from "node:fs";
import { basename } from "node:path";

// ── Worker settings (loaded lazily at first session_start) ──

interface MemSettings {
  WORKER_BASE_URL: string;
  EXCLUDED_PROJECTS: string[];
  EXCLUDED_PROJECTS_RAW: string; // for prefix matching
  SKIP_TOOLS: Set<string>;
}

let _settings: MemSettings | null = null;

function loadSettings(): MemSettings | null {
  const settingsPath = `${process.env.HOME}/.claude-mem/settings.json`;
  if (!existsSync(settingsPath)) return null;

  const raw = JSON.parse(readFileSync(settingsPath, "utf-8"));
  const port = raw.CLAUDE_MEM_WORKER_PORT || 37700;
  const host = raw.CLAUDE_MEM_WORKER_HOST || "127.0.0.1";

  const excluded = (raw.CLAUDE_MEM_EXCLUDED_PROJECTS || "")
    .split(",")
    .map((s: string) => s.trim())
    .filter(Boolean);

  const skipTools = new Set(
    (raw.CLAUDE_MEM_SKIP_TOOLS || "")
      .split(",")
      .map((s: string) => s.trim())
      .filter(Boolean)
  );

  return {
    WORKER_BASE_URL: `http://${host}:${port}`,
    EXCLUDED_PROJECTS: excluded,
    EXCLUDED_PROJECTS_RAW: raw.CLAUDE_MEM_EXCLUDED_PROJECTS || "",
    SKIP_TOOLS: skipTools,
  };
}

function getSettings(): MemSettings | null {
  if (!_settings) _settings = loadSettings();
  return _settings;
}

// ── Helpers ──

function isExcluded(cwd: string, excluded: string[]): boolean {
  // Replicates claude-mem's QL() logic: converts each exclusion to ^...$ regex,
  // tests against both full path and basename. Supports * globs.
  const normalized = cwd.replace(/\\/g, "/");
  const base = normalized.split("/").pop() || "";

  for (const ex of excluded) {
    // Convert exclusion string to regex (same logic as claude-mem's $_t function)
    let pattern = ex.replace(/\\/g, "/");
    // Escape regex special chars (except * and ? which are treated as globs)
    pattern = pattern.replace(/[.+^${}()|[\]\\\\]/g, "\\$&");
    // Convert glob patterns
    pattern = pattern.replace(/\\*\\*/g, ".*").replace(/\\*/g, "[^/]*").replace(/\\?/g, "[^/]");
    const re = new RegExp(`^${pattern}$`);
    if (re.test(normalized) || re.test(base)) return true;
  }
  return false;
}

async function fetchContext(
  baseUrl: string,
  project: string
): Promise<string> {
  try {
    const resp = await fetch(
      `${baseUrl}/api/context/inject?project=${encodeURIComponent(project)}&colors=false`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!resp.ok) return "";
    return await resp.text();
  } catch {
    return "";
  }
}

async function sendObservation(
  baseUrl: string,
  contentSessionId: string,
  toolName: string,
  toolInput: unknown,
  toolResult: unknown,
  cwd: string
): Promise<void> {
  try {
    await fetch(`${baseUrl}/api/sessions/observations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contentSessionId,
        tool_name: toolName,
        tool_input: toolInput,
        tool_response: toolResult,
        cwd,
        platformSource: "pi",
      }),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    // Never block on claude-mem unavailability
  }
}

async function sendSummary(
  baseUrl: string,
  contentSessionId: string,
  lastAssistantMessage: string
): Promise<void> {
  try {
    await fetch(`${baseUrl}/api/sessions/summarize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contentSessionId,
        last_assistant_message: lastAssistantMessage,
        platformSource: "pi",
      }),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    // Never block on claude-mem unavailability
  }
}

function flattenToolResult(result: unknown): string {
  // Pi wraps results in {content: [...], details: {...}, isError: bool}.
  // The SDK agent works best with plain text, so flatten to match claude-cli.
  if (!result || typeof result !== "object") {
    return String(result ?? "");
  }

  const r = result as Record<string, unknown>;
  const parts: string[] = [];

  if (Array.isArray(r.content)) {
    for (const block of r.content as Array<{ type: string; text?: string }>) {
      if (block.type === "text" && block.text) parts.push(block.text);
    }
  }

  if (r.details && typeof r.details === "object") {
    const d = r.details as Record<string, unknown>;
    if (typeof d.exitCode === "number" && d.exitCode !== 0) {
      parts.push(`(exit code: ${d.exitCode})`);
    }
  }

  if (r.isError) parts.push("(error)");

  return parts.join("\n") || JSON.stringify(result);
}

async function initSession(
  baseUrl: string,
  contentSessionId: string,
  project: string,
  prompt: string
): Promise<boolean> {
  try {
    const resp = await fetch(`${baseUrl}/api/sessions/init`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contentSessionId,
        project,
        prompt,
        platformSource: "pi",
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return false;
    const data = await resp.json();
    return data?.status === "initialized";
  } catch {
    return false;
  }
}

// ── Extension ──

export default function (pi: ExtensionAPI) {
  // Per-session state
  let contentSessionId: string | null = null;
  let contextString = "";
  let contextInjected = false;
  let enabled = false;
  let project = "";
  let baseUrl = "";

  // Collect assistant message content for end-of-session summary
  let lastAssistantContent = "";

  // ── Session start ──
  pi.on("session_start", async (_event, ctx) => {
    const settings = getSettings();
    if (!settings) return; // no settings.json, nothing to do

    const cwd = ctx.cwd;
    if (isExcluded(cwd, settings.EXCLUDED_PROJECTS)) return;

    project = basename(cwd);
    baseUrl = settings.WORKER_BASE_URL;
    contentSessionId = `pi-${crypto.randomUUID()}`;
    contextInjected = false;
    enabled = true;

    // Fetch context from claude-mem
    contextString = await fetchContext(baseUrl, project);
  });

  // ── Inject context into system prompt (first prompt only) ──
  pi.on("before_agent_start", async (event, _ctx) => {
    if (!enabled || !contentSessionId) return;

    // Register every user prompt with the worker (like UserPromptSubmit hook)
    if (event.prompt) {
      await initSession(baseUrl, contentSessionId, project, event.prompt);
    }

    // Inject claude-mem context only on the first prompt of the session
    if (!contextInjected && contextString.trim()) {
      contextInjected = true;
      return {
        systemPrompt: contextString + "\n\n" + event.systemPrompt,
      };
    }
  });

  // ── Capture assistant text for session summary ──
  pi.on("message_end", async (event, _ctx) => {
    if (!enabled || event.message.role !== "assistant") return;

    const text = event.message.content
      .filter((c: { type: string; text?: string }) => c.type === "text")
      .map((c: { type: string; text?: string }) => c.text || "")
      .join("\n");
    if (text) lastAssistantContent = text;
  });

  // ── Per-tool observation ──
  pi.on("tool_execution_end", async (event, ctx) => {
    if (!enabled || !contentSessionId) return;

    const settings = getSettings();
    if (!settings) return;

    if (settings.SKIP_TOOLS.has(event.toolName)) return;

    await sendObservation(
      baseUrl,
      contentSessionId,
      event.toolName,
      event.args,
      flattenToolResult(event.result),
      ctx.cwd,
    );
  });

  // ── Session end ──
  pi.on("session_shutdown", async (event, _ctx) => {
    if (!enabled || !contentSessionId) return;
    if (event.reason !== "quit") return; // only summarize on real exit

    await sendSummary(baseUrl, contentSessionId, lastAssistantContent);

    // Reset
    contentSessionId = null;
    contextString = "";
    contextInjected = false;
    enabled = false;
    project = "";
    baseUrl = "";
    lastAssistantContent = "";
  });
}
