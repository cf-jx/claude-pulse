#!/usr/bin/env bun
/**
 * Combined statusline: ccusage costs + OAuth quota + claude-hud tools/agents/todos
 *
 * Line 1 (always):
 *   git:(main*) | ████░░░░░░ 18% | Sonnet 4.6 | $0.19 (订阅) | 周:$14 | 5h:3%@17:00 | 7d:11%@5.9d
 *
 * Line 2 (only when active):
 *   ◐ Edit: file.ts | ✓ Read ×3 | ▸ Fix bug (2/5)
 */

import { spawnSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, statSync, openSync, readSync, closeSync, createReadStream, readdirSync } from "fs";
import { createInterface } from "readline";
import * as path from "path";
import * as os from "os";

// ─── Types ───────────────────────────────────────────────────────────────────

interface StdinData {
  cwd?: string;
  transcript_path?: string;
  model?: { id?: string; display_name?: string };
  context_window?: {
    context_window_size?: number;
    used_percentage?: number | null;
    current_usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    } | null;
  };
}

interface OAuthUsage {
  five_hour?: { utilization?: number; resets_at?: string };
  seven_day?: { utilization?: number; resets_at?: string };
}

interface ToolEntry {
  id: string;
  name: string;
  target?: string;
  status: "running" | "completed" | "error";
  startTime: Date;
  endTime?: Date;
}

interface AgentEntry {
  id: string;
  type: string;
  model?: string;
  description?: string;
  status: "running" | "completed";
  startTime: Date;
  endTime?: Date;
}

interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

interface TranscriptData {
  tools: ToolEntry[];
  agents: AgentEntry[];
  todos: TodoItem[];
  sessionStart?: Date;
}

// ─── ANSI Colors ─────────────────────────────────────────────────────────────

const R = "\x1b[0m";

// Git (claude-hud style)
const gitWrap   = "\x1b[38;2;255;107;107m"; // red   — git:()
const gitBranch = "\x1b[38;2;255;159;67m";  // orange — branch name
const gitDirty  = "\x1b[38;2;255;205;86m";  // yellow — *

// Info
const model_c  = "\x1b[38;2;54;185;204m";   // cyan — model
const muted    = "\x1b[38;2;92;99;112m";    // slate — labels
const costDay  = "\x1b[38;2;99;102;241m";   // indigo — today cost
const costWeek = "\x1b[38;2;168;85;247m";   // violet — week cost
const quota_c  = "\x1b[38;2;255;107;107m";  // red — 5h/7d

// Activity (claude-hud style)
const yellow  = (s: string) => `\x1b[38;2;255;205;86m${s}${R}`;
const green_c = (s: string) => `\x1b[38;2;75;192;100m${s}${R}`;
const cyan_c  = (s: string) => `\x1b[38;2;54;185;204m${s}${R}`;
const magenta = (s: string) => `\x1b[38;2;168;85;247m${s}${R}`;
const dim_c   = (s: string) => `\x1b[38;2;92;99;112m${s}${R}`;

// ─── Context Bar with gradient ────────────────────────────────────────────────

/**
 * Renders a 10-char bar with a green→red gradient across positions.
 * Empty portion is dim gray. Percentage label color reflects usage level.
 */
function renderContextBar(pct: number, width = 10): string {
  const fill = Math.round((pct / 100) * width);
  let bar = "";

  for (let i = 0; i < width; i++) {
    if (i < fill) {
      // Interpolate color position across the full bar width
      const t = i / Math.max(width - 1, 1);
      const r = Math.round(75  + (255 - 75)  * t);
      const g = Math.round(192 + (107 - 192) * t);
      const b = Math.round(100 + (107 - 100) * t);
      bar += `\x1b[38;2;${r};${g};${b}m█`;
    } else {
      bar += `\x1b[38;2;60;65;75m░`;
    }
  }

  const pctColor =
    pct >= 90 ? "\x1b[38;2;255;107;107m" :
    pct >= 70 ? "\x1b[38;2;255;205;86m"  :
                "\x1b[38;2;75;192;100m";

  return `${bar}${R} ${pctColor}${pct}%${R}`;
}

// ─── Git (claude-hud style) ───────────────────────────────────────────────────

function getGitInfo(dir: string): string {
  const check = spawnSync("git", ["--no-optional-locks", "-C", dir, "rev-parse", "--git-dir"], {
    stdio: "ignore",
  });
  if (check.status !== 0) return "";

  const branchResult = spawnSync(
    "git", ["--no-optional-locks", "-C", dir, "branch", "--show-current"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
  );
  const branch = branchResult.stdout?.trim() || "HEAD";

  const hasDirty =
    spawnSync("git", ["--no-optional-locks", "-C", dir, "diff", "--quiet"], { stdio: "ignore" }).status !== 0 ||
    spawnSync("git", ["--no-optional-locks", "-C", dir, "diff", "--cached", "--quiet"], { stdio: "ignore" }).status !== 0;

  const dirtyMark = hasDirty ? `${gitDirty}*${R}` : "";
  return `${gitWrap}git:(${R}${gitBranch}${branch}${R}${gitWrap})${R}${dirtyMark}`;
}

// ─── Transcript parsing (adapted from claude-hud) ────────────────────────────

interface TranscriptLine {
  timestamp?: string;
  message?: { content?: ContentBlock[] };
}

interface ContentBlock {
  type: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean;
}

async function parseTranscript(transcriptPath: string | undefined): Promise<TranscriptData> {
  const empty: TranscriptData = { tools: [], agents: [], todos: [] };
  if (!transcriptPath || !existsSync(transcriptPath)) return empty;

  const toolMap  = new Map<string, ToolEntry>();
  const agentMap = new Map<string, AgentEntry>();
  let latestTodos: TodoItem[] = [];
  const taskIdToIndex = new Map<string, number>();
  let sessionStart: Date | undefined;

  try {
    const rl = createInterface({ input: createReadStream(transcriptPath), crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as TranscriptLine;
        const ts = entry.timestamp ? new Date(entry.timestamp) : new Date();
        if (!sessionStart && entry.timestamp) sessionStart = ts;

        const content = entry.message?.content;
        if (!Array.isArray(content)) continue;

        for (const block of content) {
          if (block.type === "tool_use" && block.id && block.name) {
            if (block.name === "Task") {
              const inp = block.input as Record<string, unknown>;
              agentMap.set(block.id, {
                id: block.id,
                type: (inp?.subagent_type as string) ?? "unknown",
                model: inp?.model as string | undefined,
                description: inp?.description as string | undefined,
                status: "running",
                startTime: ts,
              });
            } else if (block.name === "TodoWrite") {
              const inp = block.input as { todos?: TodoItem[] };
              if (Array.isArray(inp?.todos)) {
                latestTodos = [...inp.todos];
                taskIdToIndex.clear();
              }
            } else if (block.name === "TaskCreate") {
              const inp = block.input as Record<string, unknown>;
              const c2  = (inp.subject as string) || (inp.description as string) || "Untitled";
              const st  = normalizeStatus(inp.status) ?? "pending";
              latestTodos.push({ content: c2, status: st });
              const taskId = String(inp.taskId ?? block.id);
              if (taskId) taskIdToIndex.set(taskId, latestTodos.length - 1);
            } else if (block.name === "TaskUpdate") {
              const inp = block.input as Record<string, unknown>;
              const idx = resolveTaskIdx(inp.taskId, taskIdToIndex, latestTodos);
              if (idx !== null) {
                const st = normalizeStatus(inp.status);
                if (st) latestTodos[idx].status = st;
                const c2 = (inp.subject as string) || (inp.description as string);
                if (c2) latestTodos[idx].content = c2;
              }
            } else {
              toolMap.set(block.id, {
                id: block.id,
                name: block.name,
                target: extractTarget(block.name, block.input),
                status: "running",
                startTime: ts,
              });
            }
          }

          if (block.type === "tool_result" && block.tool_use_id) {
            const tool = toolMap.get(block.tool_use_id);
            if (tool) { tool.status = block.is_error ? "error" : "completed"; tool.endTime = ts; }
            const agent = agentMap.get(block.tool_use_id);
            if (agent) { agent.status = "completed"; agent.endTime = ts; }
          }
        }
      } catch { /* skip malformed lines */ }
    }
  } catch { /* return partial */ }

  return {
    tools:  Array.from(toolMap.values()).slice(-20),
    agents: Array.from(agentMap.values()).slice(-10),
    todos:  latestTodos,
    sessionStart,
  };
}

function extractTarget(name: string, input?: Record<string, unknown>): string | undefined {
  if (!input) return undefined;
  switch (name) {
    case "Read": case "Write": case "Edit":
      return (input.file_path as string) ?? (input.path as string);
    case "Glob": case "Grep":
      return input.pattern as string;
    case "Bash": {
      const cmd = input.command as string;
      return cmd ? cmd.slice(0, 30) + (cmd.length > 30 ? "..." : "") : undefined;
    }
  }
  return undefined;
}

function resolveTaskIdx(taskId: unknown, map: Map<string, number>, todos: TodoItem[]): number | null {
  if (typeof taskId === "string" || typeof taskId === "number") {
    const key = String(taskId);
    const mapped = map.get(key);
    if (typeof mapped === "number") return mapped;
    if (/^\d+$/.test(key)) {
      const i = parseInt(key, 10) - 1;
      if (i >= 0 && i < todos.length) return i;
    }
  }
  return null;
}

function normalizeStatus(s: unknown): TodoItem["status"] | null {
  switch (s) {
    case "pending": case "not_started":               return "pending";
    case "in_progress": case "running":               return "in_progress";
    case "completed": case "complete": case "done":   return "completed";
    default: return null;
  }
}

// ─── Activity lines ───────────────────────────────────────────────────────────

function renderToolsLine(tools: ToolEntry[]): string | null {
  if (!tools.length) return null;
  const parts: string[] = [];

  for (const t of tools.filter(t => t.status === "running").slice(-2)) {
    const target = t.target ? truncatePath(t.target) : "";
    parts.push(`${yellow("◐")} ${cyan_c(t.name)}${target ? dim_c(`: ${target}`) : ""}`);
  }

  const counts = new Map<string, number>();
  for (const t of tools.filter(t => t.status === "completed" || t.status === "error")) {
    counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
  }
  for (const [name, count] of Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 4)) {
    parts.push(`${green_c("✓")} ${name} ${dim_c(`×${count}`)}`);
  }

  return parts.length ? parts.join(" | ") : null;
}

function renderAgentsLine(agents: AgentEntry[]): string | null {
  const toShow = [
    ...agents.filter(a => a.status === "running"),
    ...agents.filter(a => a.status === "completed").slice(-2),
  ].slice(-3);
  if (!toShow.length) return null;

  return toShow.map(a => {
    const icon    = a.status === "running" ? yellow("◐") : green_c("✓");
    const type    = magenta(a.type);
    const modelLbl = a.model ? ` ${dim_c(`[${a.model}]`)}` : "";
    const desc    = a.description
      ? dim_c(`: ${a.description.slice(0, 40)}${a.description.length > 40 ? "..." : ""}`)
      : "";
    return `${icon} ${type}${modelLbl}${desc} ${dim_c(`(${formatElapsed(a.startTime, a.endTime)})`)}`;
  }).join("\n");
}

function renderTodosLine(todos: TodoItem[]): string | null {
  if (!todos.length) return null;
  const inProgress = todos.find(t => t.status === "in_progress");
  const done  = todos.filter(t => t.status === "completed").length;
  const total = todos.length;
  if (!inProgress) {
    return done === total && total > 0
      ? `${green_c("✓")} All todos complete ${dim_c(`(${done}/${total})`)}`
      : null;
  }
  const label = inProgress.content.length > 50
    ? inProgress.content.slice(0, 47) + "..."
    : inProgress.content;
  return `${yellow("▸")} ${label} ${dim_c(`(${done}/${total})`)}`;
}

function truncatePath(p: string, max = 20): string {
  const norm = p.replace(/\\/g, "/");
  if (norm.length <= max) return norm;
  const parts = norm.split("/");
  const file  = parts.pop() || norm;
  return file.length >= max ? file.slice(0, max - 3) + "..." : ".../" + file;
}

function formatElapsed(start: Date, end?: Date): string {
  const ms = (end ?? new Date()).getTime() - start.getTime();
  if (ms < 1000)  return "<1s";
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m ${s}s`;
}

// ─── Config counts (adapted from claude-hud) ─────────────────────────────────

function countRulesDir(dir: string): number {
  if (!existsSync(dir)) return 0;
  try {
    let count = 0;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) count += countRulesDir(path.join(dir, e.name));
      else if (e.isFile() && e.name.endsWith(".md")) count++;
    }
    return count;
  } catch { return 0; }
}

function getMcpCount(filePath: string): number {
  if (!existsSync(filePath)) return 0;
  try {
    const cfg = JSON.parse(readFileSync(filePath, "utf8"));
    return cfg?.mcpServers ? Object.keys(cfg.mcpServers).length : 0;
  } catch { return 0; }
}

function getHooksCount(filePath: string): number {
  if (!existsSync(filePath)) return 0;
  try {
    const cfg = JSON.parse(readFileSync(filePath, "utf8"));
    return cfg?.hooks ? Object.keys(cfg.hooks).length : 0;
  } catch { return 0; }
}

interface ConfigCounts { claudeMd: number; rules: number; mcps: number; hooks: number; }

function countConfigs(cwd: string): ConfigCounts {
  const home = os.homedir();
  const claudeDir = path.join(home, ".claude");
  let claudeMd = 0, rules = 0, mcps = 0, hooks = 0;

  // User scope — ~/.claude/
  if (existsSync(path.join(claudeDir, "CLAUDE.md"))) claudeMd++;
  rules += countRulesDir(path.join(claudeDir, "rules"));
  mcps  += getMcpCount(path.join(claudeDir, "settings.json"));
  hooks += getHooksCount(path.join(claudeDir, "settings.json"));

  // ~/.claude.json (Claude Code stores MCPs here on some platforms)
  mcps += getMcpCount(path.join(home, ".claude.json"));

  // Project scope
  if (cwd) {
    if (existsSync(path.join(cwd, "CLAUDE.md")))       claudeMd++;
    if (existsSync(path.join(cwd, "CLAUDE.local.md"))) claudeMd++;
    rules += countRulesDir(path.join(cwd, ".claude", "rules"));
    mcps  += getMcpCount(path.join(cwd, ".claude", "settings.json"));
    mcps  += getMcpCount(path.join(cwd, ".mcp.json"));
    hooks += getHooksCount(path.join(cwd, ".claude", "settings.json"));
    hooks += getHooksCount(path.join(cwd, ".claude", "settings.local.json"));
  }

  return { claudeMd, rules, mcps, hooks };
}

function formatSessionDuration(start: Date | undefined): string {
  if (!start) return "";
  const ms = Date.now() - start.getTime();
  if (ms < 60000)   return "<1m";
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m`;
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

// ─── Cache / run helpers ──────────────────────────────────────────────────────

function readCache(file: string, maxAge: number): string | null {
  try {
    if (!existsSync(file)) return null;
    if ((Date.now() - statSync(file).mtimeMs) / 1000 >= maxAge) return null;
    return readFileSync(file, "utf8").trim() || null;
  } catch { return null; }
}

function writeCache(file: string, content: string): void {
  try { writeFileSync(file, content, "utf8"); } catch {}
}

function runCmd(cmd: string, args: string[], timeout = 5000): string | null {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "ignore"] });
  return (r.status === 0 && !r.error) ? r.stdout?.trim() || null : null;
}

// ─── ccusage ─────────────────────────────────────────────────────────────────

const CACHE_TODAY  = "/tmp/cl_status_today.txt";
const CACHE_WEEKLY = "/tmp/cl_status_weekly.txt";
const CACHE_OAUTH  = "/tmp/cl_status_oauth.txt";

function getDailyCost(): number | null {
  const cached = readCache(CACHE_TODAY, 60);
  if (cached && cached !== "null") return parseFloat(cached);
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const raw = runCmd("ccusage", ["daily", "--json", "--since", today, "-i"]);
  if (!raw) return null;
  try {
    const cost: number | null = JSON.parse(raw)?.totals?.totalCost ?? null;
    writeCache(CACHE_TODAY, cost !== null ? String(cost) : "null");
    return cost;
  } catch { return null; }
}

function getWeeklyCost(): number | null {
  const cached = readCache(CACHE_WEEKLY, 300);
  if (cached && cached !== "null") return parseFloat(cached);
  const raw = runCmd("ccusage", ["weekly", "--json"]);
  if (!raw) return null;
  try {
    const cost: number | null = JSON.parse(raw)?.weekly?.at(-1)?.totalCost ?? null;
    if (cost !== null) writeCache(CACHE_WEEKLY, String(cost));
    return cost;
  } catch { return null; }
}

// ─── OAuth quota ──────────────────────────────────────────────────────────────

function getOAuthToken(): string | null {
  try {
    const credFile = `${process.env.HOME || process.env.USERPROFILE}/.claude/.credentials.json`;
    if (existsSync(credFile)) {
      return JSON.parse(readFileSync(credFile, "utf8"))?.claudeAiOauth?.accessToken ?? null;
    }
  } catch {}
  return null;
}

async function getOAuthQuota(): Promise<OAuthUsage | null> {
  const cached = readCache(CACHE_OAUTH, 180);
  if (cached) {
    try { return cached === "{}" ? null : JSON.parse(cached) as OAuthUsage; } catch {}
  }
  const token = getOAuthToken();
  if (!token) return null;
  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 5000);
    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
      signal: controller.signal,
    });
    clearTimeout(tid);
    if (!res.ok) { writeCache(CACHE_OAUTH, "{}"); return null; }
    const data = await res.json() as OAuthUsage;
    writeCache(CACHE_OAUTH, JSON.stringify(data));
    return data;
  } catch { writeCache(CACHE_OAUTH, "{}"); return null; }
}

// ─── Model + context ──────────────────────────────────────────────────────────

const MODEL_DISPLAY: Record<string, string> = {
  "claude-opus-4-6":           "Opus 4.6",
  "claude-opus-4-5":           "Opus 4.5",
  "claude-sonnet-4-6":         "Sonnet 4.6",
  "claude-sonnet-4-5":         "Sonnet 4.5",
  "claude-haiku-4-5":          "Haiku 4.5",
  "claude-haiku-4-5-20251001": "Haiku 4.5",
};

function getActualModel(transcriptPath: string | undefined, fallback: string): string {
  if (!transcriptPath || !existsSync(transcriptPath)) return fallback;
  try {
    const { size } = statSync(transcriptPath);
    const fd  = openSync(transcriptPath, "r");
    const buf = Buffer.alloc(Math.min(8192, size));
    readSync(fd, buf, 0, buf.length, Math.max(0, size - 8192));
    closeSync(fd);
    for (const line of buf.toString("utf8").split("\n").reverse()) {
      try {
        const obj = JSON.parse(line);
        if (obj?.type === "assistant") {
          const id: string | undefined = obj?.message?.model;
          if (id) return MODEL_DISPLAY[id] ?? id.replace(/^claude-/, "");
        }
      } catch {}
    }
  } catch {}
  return fallback;
}

function getContextPercent(data: StdinData): number | null {
  const cw = data.context_window;
  if (!cw) return null;
  if (cw.used_percentage != null) return Math.round(cw.used_percentage);
  const size  = cw.context_window_size;
  const usage = cw.current_usage;
  if (!size || !usage) return null;
  const total = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  return Math.round((total / size) * 100);
}

function formatResetTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  } catch { return ""; }
}

// ─── Stdin ────────────────────────────────────────────────────────────────────

async function readStdin(): Promise<StdinData> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const input = await readStdin();
  const cwd   = input.cwd ?? process.cwd();
  const isApi = !!process.env.ANTHROPIC_BASE_URL;

  const [transcript, oauthData, dailyCost, weeklyCost] = await Promise.all([
    parseTranscript(input.transcript_path),
    isApi ? Promise.resolve(null) : getOAuthQuota(),
    Promise.resolve(getDailyCost()),
    Promise.resolve(getWeeklyCost()),
  ]);

  const modelName  = getActualModel(input.transcript_path, input.model?.display_name ?? "");
  const ctxPct     = getContextPercent(input);
  const gitInfo    = getGitInfo(cwd);
  const cfgCounts  = countConfigs(cwd);
  const sessionDur = formatSessionDuration(transcript.sessionStart);

  // ── Line 1 ────────────────────────────────────────────────────────────────

  const seg: string[] = [];

  if (gitInfo)         seg.push(gitInfo);
  if (ctxPct !== null) seg.push(renderContextBar(ctxPct));
  if (modelName)       seg.push(`${model_c}${modelName}${R}`);

  // Config counts: 2 CLAUDE.md | 8 rules | 6 MCPs | 6 hooks | ⏱ 5m
  {
    const cfgParts: string[] = [];
    if (cfgCounts.claudeMd > 0) cfgParts.push(`${dim_c(`${cfgCounts.claudeMd} CLAUDE.md`)}`);
    if (cfgCounts.rules    > 0) cfgParts.push(`${dim_c(`${cfgCounts.rules} rules`)}`);
    if (cfgCounts.mcps     > 0) cfgParts.push(`${dim_c(`${cfgCounts.mcps} MCPs`)}`);
    if (cfgCounts.hooks    > 0) cfgParts.push(`${dim_c(`${cfgCounts.hooks} hooks`)}`);
    if (sessionDur)             cfgParts.push(`${dim_c(`⏱ ${sessionDur}`)}`);
    if (cfgParts.length > 0)    seg.push(cfgParts.join(" | "));
  }

  // Group 1: $cost(label) 5h:X%@T  — space-joined, no | inside
  {
    const label = isApi
      ? ` (${process.env.ANTHROPIC_BASE_URL!.replace(/^https?:\/\//, "").replace(/\/.*$/, "")})`
      : " (订阅)";
    const costStr = (dailyCost !== null && dailyCost > 0)
      ? `${costDay}$${dailyCost.toFixed(2)}${muted}${label}${R}`
      : "";

    let fhStr = "";
    if (!isApi && oauthData?.five_hour?.utilization !== undefined) {
      const t = oauthData.five_hour.resets_at ? `@${formatResetTime(oauthData.five_hour.resets_at)}` : "";
      fhStr = `${quota_c}5h:${oauthData.five_hour.utilization}%${t}${R}`;
    }

    const group1 = [costStr, fhStr].filter(Boolean).join(" ");
    if (group1) seg.push(group1);
  }

  // Group 2: 7d:X%@Xd — standalone segment
  if (!isApi && oauthData?.seven_day?.utilization !== undefined) {
    const days = oauthData.seven_day.resets_at
      ? `@${((new Date(oauthData.seven_day.resets_at).getTime() - Date.now()) / 86400000).toFixed(1)}d`
      : "";
    seg.push(`${quota_c}7d:${oauthData.seven_day.utilization}%${days}${R}`);
  }

  // Group 3: 日:$X | 周:$X — pipe-separated, one segment
  {
    const dailyStr  = (dailyCost !== null && dailyCost > 0)
      ? `${costDay}日:$${dailyCost.toFixed(2)}${R}` : "";
    const weeklyStr = (weeklyCost !== null && weeklyCost > 0)
      ? `${costWeek}周:$${Math.round(weeklyCost)}${R}` : "";

    const group3 = [dailyStr, weeklyStr].filter(Boolean).join(" | ");
    if (group3) seg.push(group3);
  }

  process.stdout.write(seg.join(" | "));

  // ── Lines 2+: each activity type on its own line ─────────────────────────

  const toolsLine  = renderToolsLine(transcript.tools);
  const agentsLine = renderAgentsLine(transcript.agents);
  const todosLine  = renderTodosLine(transcript.todos);

  if (toolsLine)  process.stdout.write("\n" + toolsLine);
  if (agentsLine) process.stdout.write("\n" + agentsLine);
  if (todosLine)  process.stdout.write("\n" + todosLine);

  process.stdout.write("\n");
}

main().catch(() => process.exit(1));
