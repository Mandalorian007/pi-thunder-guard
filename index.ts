// A guard for Pi's happy path: before a bash call, or a write or edit outside
// the workspace, Jev is asked whether it keeps to each restriction in
// restrictions.md. Below the file's confidence on any of them, the call is
// blocked and the model is told the rules and to break the command down.
//
// It guards against mistakes, not against an agent that sets out to get around
// it. The key is Pi's own: `typesafe` in ~/.pi/agent/auth.json, or
// TYPESAFE_API_KEY. PI_THUNDER_GUARD=off turns it off for a run.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { blockedMessage, describeCall, inside, parsePolicy, questionsFor, realPath, verdictOf, workspaceOf, type Answers, type Policy, type Question, type State } from "./lib.ts";

export const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const TIMEOUT_MS = 10_000;
const ATTEMPTS = 3;

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");

// Your own copy replaces the shipped one. Read on every call, so an edit
// applies at once.
export const POLICY_FILES = [join(AGENT_DIR, "guard.md"), join(PACKAGE_DIR, "restrictions.md")];

export function loadPolicy(): { policy: Policy; file: string } {
  const file = POLICY_FILES.find((f) => existsSync(f))!;
  return { policy: parsePolicy(readFileSync(file, "utf8")), file };
}

type Ask = (state: State, questions: Record<string, Question>, signal?: AbortSignal) => Promise<{ answers: Answers; inputTokens: number }>;

// One call to Jev, retried on 429, 5xx and timeouts.
export function jevClient(apiKey: string, doFetch: typeof fetch = fetch): Ask {
  return async (state, questions, signal) => {
    for (let attempt = 1; ; attempt++) {
      const timeout = AbortSignal.timeout(TIMEOUT_MS);
      let response: Response;
      try {
        response = await doFetch(JEV_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: "jev-latest", state, questions }),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch (error) {
        if (signal?.aborted || attempt >= ATTEMPTS) throw error;
        continue;
      }
      const body = await response.json().catch(() => ({}));
      if (response.ok) return { answers: body.answers ?? {}, inputTokens: body.usage?.input_tokens ?? 0 };
      if ((response.status !== 429 && response.status < 500) || attempt >= ATTEMPTS) throw new Error(body.error?.message ?? `HTTP ${response.status}`);
      await new Promise((r) => setTimeout(r, 300 * attempt * (0.5 + Math.random())));
    }
  };
}

const roots = new Map<string, string>();

// The repository the working directory is in, or the directory itself.
function rootOf(cwd: string): string {
  let root = roots.get(cwd);
  if (!root) {
    try {
      root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      root = cwd;
    }
    roots.set(cwd, root);
  }
  return root;
}

const TEMPS = [...new Set(["/tmp", tmpdir(), process.env.TMPDIR].filter((t): t is string => !!t).map((t) => t.replace(/\/+$/, "")))];

export default function thunderGuard(pi: ExtensionAPI) {
  if (process.env.PI_THUNDER_GUARD === "off") return;

  let ask: Ask | undefined;
  pi.on("session_start", async (_event, ctx) => {
    const apiKey = await ctx.modelRegistry.getApiKeyForProvider("typesafe");
    ask = apiKey ? jevClient(apiKey) : undefined;
  });

  pi.on("tool_call", async (event, ctx) => {
    const home = homedir();
    const call = describeCall(event.toolName, event.input as Record<string, unknown>, ctx.cwd, home, existsSync);
    if (!call) return;
    const workspace = workspaceOf(rootOf(ctx.cwd), home, TEMPS, realPath);

    // A write or edit inside the workspace needs no question.
    if (call.path && inside(realPath(call.path), workspace)) return;

    let policy: Policy;
    let file: string;
    try {
      ({ policy, file } = loadPolicy());
    } catch (error) {
      const why = `The guard's restrictions file is broken (${(error as Error).message}). Tell the user.`;
      return { block: true, reason: `Blocked by pi-thunder-guard: this call did not run. ${why}` };
    }

    const blocked = (verdict?: ReturnType<typeof verdictOf>, problem?: string) => {
      if (ctx.hasUI) ctx.ui.notify(`Guard blocked: ${call.action.slice(0, 120)}`, "warning");
      return { block: true, reason: blockedMessage(policy, workspace, verdict, problem) };
    };

    if (!ask) return blocked(undefined, "The guard has no Jev key, so it cannot check commands. Tell the user to add `typesafe` to ~/.pi/agent/auth.json.");

    const state: State = {
      action: call.action,
      working_directory: ctx.cwd,
      working_directory_in_workspace: inside(realPath(ctx.cwd), workspace),
      workspace,
      home,
    };
    const started = Date.now();
    let answers: Answers;
    let inputTokens: number;
    try {
      ({ answers, inputTokens } = await ask(state, questionsFor(policy), ctx.signal));
    } catch (error) {
      pi.appendEntry("thunder-guard", { action: call.action, error: (error as Error).message, ms: Date.now() - started });
      return blocked(undefined, `Jev couldn't be asked (${(error as Error).message}). Try once more; if it keeps failing, tell the user.`);
    }
    const verdict = verdictOf(policy, answers);
    pi.appendEntry("thunder-guard", {
      action: call.action,
      allowed: verdict.allowed,
      scores: Object.fromEntries(verdict.judged.map((j) => [j.restriction.id, Number(j.p.toFixed(3))])),
      confidence: policy.confidence,
      policy: file,
      ms: Date.now() - started,
      inputTokens,
    });
    if (!verdict.allowed) return blocked(verdict);
  });
}
