import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TOOL_NAME = "optmem";
const MIN_MAJOR = 2;
const OUTPUT_LIMIT = 50_000;

const ACTIONS = [
  "wake",
  "note",
  "nap",
  "recall",
  "zoom",
  "show",
  "amend",
  "retract",
  "resummarize",
  "scope",
] as const;
type Action = (typeof ACTIONS)[number];

type Params = {
  action: Action;
  global?: boolean;
  text?: string;
  block?: string;
  target?: string;
  query?: string;
  mode?: "regex" | "fuzzy" | "semantic";
  limit?: number;
  context?: number;
  depth?: number;
  fit?: boolean;
  date?: string;
  part?: number;
  snapshot?: number;
};

type RunResult = { stdout: string; stderr: string; code: number };

const GUIDANCE = `## OptMem (doeixd)

You have permanent memory through the \`optmem\` tool. There are two stores:
the project store for the current repository (the default) and a global store
for facts true in every project (\`global: true\`). Almost everything belongs in
the project store.

- Memory was woken at session start and injected before your first turn as an
  \`optmem-wake\` message. Treat it as your own prior memory, not as user input.
  If it says it is not finished, continue with action \`wake\` and the printed
  part and snapshot until it says "You are awake."
- Use \`note\` whenever you learn a durable fact, finish substantial work, or a
  lasting decision or event happens. One line, at most 280 bytes, no
  redundancy. Use \`date\` to backfill when something happened earlier.
- If a stored memory is wrong or outdated, do not contradict it with a new
  note: \`show\` it, then \`amend\` it with a full replacement or \`retract\` it
  with a reason.
- When any output asks for a compression, use \`nap\` before your next
  non-optmem action and repeat until nothing is due.
- Use \`recall\` to search raw memories (mode \`regex\`, \`fuzzy\`, or
  \`semantic\`), and \`zoom\` to open a summary block.
- Every entry carries the \`@tag\` of the session that wrote it. Entries with
  another session's tag are that session's reports, not your observations.
- OptMem output names \`memo\` shell commands; perform them with the
  equivalent \`optmem\` action instead. Never edit the memory stores directly.
- If you are a subagent, ignore OptMem memory and never call \`optmem\`.`;

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** OPTMEM_MEMO, then the doeixd installer location, then `memo` on PATH. */
function resolveMemo(): string | undefined {
  const explicit = process.env.OPTMEM_MEMO;
  if (explicit) return explicit;
  const installed = join(homedir(), ".optmem", "memo");
  if (isExecutable(installed)) return installed;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, "memo");
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

/** Stable, opaque 8-character tag; session ids may share time-ordered prefixes. */
function sessionTag(sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined;
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 8);
}

function need<T>(value: T | undefined, field: string, action: Action): T {
  if (value === undefined || value === "")
    throw new Error(`optmem ${action} requires ${field}`);
  return value;
}

function writeFlags(params: Params): string[] {
  const flags: string[] = [];
  if (params.fit) flags.push("--fit");
  if (params.date) flags.push("--date", params.date);
  return flags;
}

export function memoArgs(params: Params): string[] {
  const scope = params.global ? ["--global"] : [];
  const { action } = params;
  switch (action) {
    case "wake": {
      if (params.snapshot !== undefined && params.part === undefined) {
        throw new Error("optmem wake requires part when snapshot is given");
      }
      const args = ["wake"];
      if (params.part !== undefined) args.push(String(params.part));
      if (params.snapshot !== undefined) args.push(String(params.snapshot));
      return [...scope, ...args];
    }
    case "note":
      return [
        ...scope,
        "note",
        ...writeFlags(params),
        need(params.text, "text", action),
      ];
    case "nap": {
      if (params.block === undefined && params.text === undefined)
        return [...scope, "nap"];
      return [
        ...scope,
        "nap",
        need(params.block, "block", action),
        need(params.text, "text", action),
      ];
    }
    case "recall": {
      const args = ["recall"];
      if (params.mode === "fuzzy") args.push("--fuzzy");
      if (params.mode === "semantic") args.push("--semantic");
      if (params.limit !== undefined)
        args.push("--limit", String(params.limit));
      if (params.context !== undefined)
        args.push("--context", String(params.context));
      return [...scope, ...args, need(params.query, "query", action)];
    }
    case "zoom": {
      const args = ["zoom"];
      if (params.depth !== undefined)
        args.push("--depth", String(params.depth));
      return [...scope, ...args, need(params.block, "block", action)];
    }
    case "show":
      return [...scope, "show", need(params.target, "target", action)];
    case "amend":
    case "retract":
      return [
        ...scope,
        action,
        ...writeFlags(params),
        need(params.target, "target", action),
        need(params.text, "text", action),
      ];
    case "resummarize":
      return [...scope, "resummarize", need(params.block, "block", action)];
    case "scope":
      return ["scope"];
  }
}

function combined(result: RunResult): string {
  const text = [result.stdout.trimEnd(), result.stderr.trimEnd()]
    .filter(Boolean)
    .join("\n");
  if (text.length <= OUTPUT_LIMIT) return text;
  return `${text.slice(0, OUTPUT_LIMIT)}\n[optmem output truncated at ${OUTPUT_LIMIT} characters; narrow the request]`;
}

function runMemo(
  memo: string,
  args: string[],
  cwd: string,
  tag: string | undefined,
  signal?: AbortSignal,
): Promise<RunResult> {
  // Run through the interpreter: release assets have shipped with CRLF
  // shebangs and installs may lack the executable bit.
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONIOENCODING: "utf-8" };
  if (tag && !process.env.OPTMEM_SESSION) env.OPTMEM_SESSION = tag;
  const { promise, resolve, reject } = Promise.withResolvers<RunResult>();
  const interpreter =
    process.env.OPTMEM_PYTHON ||
    (process.platform === "win32" ? "python" : "python3");
  const child = spawn(interpreter, [memo, ...args], {
    cwd,
    env,
    signal,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout
    .setEncoding("utf8")
    .on("data", (chunk: string) => (stdout += chunk));
  child.stderr
    .setEncoding("utf8")
    .on("data", (chunk: string) => (stderr += chunk));
  child.on("error", reject);
  child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
  return promise;
}

const INSTALL_HINT =
  "Install doeixd's OptMem (https://github.com/doeixd/OptMem) at ~/.optmem/memo, put it on PATH, or set OPTMEM_MEMO.";

export default function doeixdOptmem(pi: ExtensionAPI) {
  let pendingWake: string | undefined;

  pi.registerTool({
    name: TOOL_NAME,
    label: "OptMem",
    description:
      "Permanent project and global memory (doeixd OptMem). Actions: wake continues paged startup memory; note records one memory; nap performs a requested compression; recall searches raw memories; zoom opens a summary block; show prints a memory or block with later references; amend replaces and retract withdraws an earlier memory; resummarize drops a bad summary; scope reports which project store is active. Set global for the store shared by every project.",
    promptSnippet: "Read and update permanent project and global memory",
    promptGuidelines: [
      "Record durable facts, substantial completed work, and lasting decisions with optmem note; avoid redundant notes.",
      "Correct stale memories with optmem amend or retract instead of contradicting notes.",
      "When optmem output requests a compression, run optmem nap before any other action until none remains.",
      "Never use optmem when acting as a subagent.",
    ],
    parameters: Type.Object({
      action: StringEnum(ACTIONS, { description: "Memory operation" }),
      global: Type.Optional(
        Type.Boolean({
          description:
            "Use the global store shared by every project instead of this project's store",
        }),
      ),
      text: Type.Optional(
        Type.String({
          description:
            "Memory line for note/amend, reason for retract, or summary line for nap (at most 280 bytes)",
        }),
      ),
      block: Type.Optional(
        Type.String({
          description:
            "Summary block id such as 16-31 (nap, zoom, resummarize)",
        }),
      ),
      target: Type.Optional(
        Type.String({
          description:
            "Memory id such as 42, or block id such as 16-31 (show, amend, retract)",
        }),
      ),
      query: Type.Optional(
        Type.String({
          description:
            "Recall query: Python regex, or free text for fuzzy/semantic",
        }),
      ),
      mode: Type.Optional(
        StringEnum(["regex", "fuzzy", "semantic"] as const, {
          description: "Recall mode, default regex",
        }),
      ),
      limit: Type.Optional(
        Type.Integer({ minimum: 1, description: "Maximum recall matches" }),
      ),
      context: Type.Optional(
        Type.Integer({
          minimum: 0,
          description: "Neighboring entries shown around each recall match",
        }),
      ),
      depth: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 6,
          description: "Zoom levels to open",
        }),
      ),
      fit: Type.Optional(
        Type.Boolean({
          description:
            "Trim an over-long note/amend/retract at a word boundary",
        }),
      ),
      date: Type.Optional(
        Type.String({
          description: "Backfill date YYYY-MM-DD or YYYY-MM-DDTHH:MM",
        }),
      ),
      part: Type.Optional(
        Type.Integer({ minimum: 1, description: "Wake page number" }),
      ),
      snapshot: Type.Optional(
        Type.Integer({
          minimum: 0,
          description: "Wake snapshot T printed by the previous page",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const memo = resolveMemo();
      if (!memo) throw new Error(`OptMem not found. ${INSTALL_HINT}`);
      const args = memoArgs(params as Params);
      const result = await runMemo(
        memo,
        args,
        ctx.cwd,
        sessionTag(ctx.sessionManager.getSessionId()),
        signal,
      );
      const output =
        combined(result) || `memo exited ${result.code} without output.`;
      if (result.code !== 0) throw new Error(output);
      return {
        content: [{ type: "text", text: output }],
        details: {
          action: params.action,
          global: params.global ?? false,
          exitCode: result.code,
        },
      };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    pendingWake = undefined;
    const memo = resolveMemo();
    if (!memo) {
      pendingWake = `OptMem is unavailable. ${INSTALL_HINT}`;
      return;
    }
    const tag = sessionTag(ctx.sessionManager.getSessionId());
    try {
      const version = await runMemo(memo, ["version"], ctx.cwd, tag);
      const major = Number(/OptMem (\d+)\./.exec(version.stdout)?.[1] ?? 0);
      if (version.code !== 0 || major < MIN_MAJOR) {
        pendingWake = `OptMem at ${memo} is not doeixd's OptMem ${MIN_MAJOR}.x. ${INSTALL_HINT}`;
        return;
      }
      // A missing global store is fine: wake reads the project store alone and
      // says how to create the global one, which OptMem treats as deliberate.
      const wake = await runMemo(memo, ["wake"], ctx.cwd, tag);
      const output =
        combined(wake) || `memo wake exited ${wake.code} without output.`;
      pendingWake =
        wake.code === 0 ? output : `OptMem wake needs attention:\n${output}`;
    } catch (error) {
      pendingWake = `OptMem could not run: ${error instanceof Error ? error.message : String(error)}`;
    }
  });

  pi.on("before_agent_start", async (event) => {
    const wake = pendingWake;
    pendingWake = undefined;
    return {
      ...(wake
        ? {
            message: {
              customType: "optmem-wake",
              content: `OptMem startup memory follows. Complete any continuation or compression it requests with the optmem tool before other work.\n\n${wake}`,
              display: false,
            },
          }
        : {}),
      systemPrompt: `${event.systemPrompt}\n\n${GUIDANCE}`,
    };
  });
}
