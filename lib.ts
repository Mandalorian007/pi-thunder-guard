// The parts of the guard that need no Pi session: the restrictions file, the
// workspace, the question Jev is asked, and what the model is told when a call
// is blocked. Plain data in and out, so the tests run them in plain Node.

import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

// ---------------------------------------------------------------- restrictions

export type Restriction = { id: string; title: string; rule: string; keeps: string; breaks: string };
export type Policy = { confidence: number; restrictions: Restriction[] };

export const DEFAULT_CONFIDENCE = 0.9;

const FIELDS = { "Rule:": "rule", "Keeps it:": "keeps", "Breaks it:": "breaks" } as const;

const slug = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

// restrictions.md: optional frontmatter with `confidence`, then one `##`
// section per restriction, each with Rule:, Keeps it: and Breaks it:. Anything
// outside the sections is notes for people. Throws on a broken file rather
// than guarding with half of it.
export function parsePolicy(text: string): Policy {
  let body = text;
  let confidence = DEFAULT_CONFIDENCE;
  const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (front) {
    body = text.slice(front[0].length);
    const c = /^confidence\s*:\s*(.+)$/m.exec(front[1]);
    if (c) {
      confidence = Number(c[1].trim());
      if (!(confidence > 0 && confidence < 1)) throw new Error(`confidence must be between 0 and 1, not ${c[1].trim()}`);
    }
  }
  const restrictions: Restriction[] = [];
  const sections = body.split(/^## +/m).slice(1);
  for (const section of sections) {
    const [titleLine, ...rest] = section.split(/\r?\n/);
    const title = titleLine.trim();
    const fields: Partial<Record<(typeof FIELDS)[keyof typeof FIELDS], string[]>> = {};
    let current: (typeof FIELDS)[keyof typeof FIELDS] | undefined;
    for (const line of rest) {
      const marker = (Object.keys(FIELDS) as (keyof typeof FIELDS)[]).find((m) => line.startsWith(m));
      if (marker) {
        current = FIELDS[marker];
        fields[current] = [line.slice(marker.length).trim()];
      } else if (current) {
        fields[current]!.push(line.trim());
      }
    }
    const text = (k: keyof typeof fields) => (fields[k] ?? []).join(" ").replace(/\s+/g, " ").trim();
    const r = { id: slug(title), title, rule: text("rule"), keeps: text("keeps"), breaks: text("breaks") };
    const missing = (["rule", "keeps", "breaks"] as const).filter((k) => !r[k]);
    if (!r.id || missing.length) throw new Error(`restriction "${title}" needs ${missing.map((k) => Object.keys(FIELDS).find((m) => FIELDS[m as keyof typeof FIELDS] === k)).join(", ")}`);
    if (restrictions.some((x) => x.id === r.id)) throw new Error(`two restrictions are called "${title}"`);
    restrictions.push(r);
  }
  if (!restrictions.length) throw new Error("no restrictions: each one is a `## Title` section with Rule:, Keeps it: and Breaks it:");
  return { confidence, restrictions };
}

// ---------------------------------------------------------------- paths

// A path as Pi's file tools resolve it: an optional leading @, ~ for home,
// relative to the working directory.
export function resolvePath(path: string, cwd: string, home: string): string {
  let p = path.trim().replace(/^@/, "");
  if (p === "~") p = home;
  else if (p.startsWith("~/")) p = join(home, p.slice(2));
  return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

// The real path, following symlinks (/tmp is /private/tmp on a Mac), for a
// file that may not exist yet: the nearest existing folder above it is
// resolved and the rest kept.
export function realPath(path: string): string {
  let dir = path;
  const tail: string[] = [];
  while (!existsSync(dir)) {
    const up = dirname(dir);
    if (up === dir) return path;
    tail.unshift(basename(dir));
    dir = up;
  }
  try {
    return join(realpathSync(dir), ...tail);
  } catch {
    return path;
  }
}

export const inside = (path: string, dirs: string[]) => dirs.some((d) => path === d || path.startsWith(d.endsWith(sep) ? d : d + sep));

// The folders the agent may change freely: the repository (or the working
// directory outside one) and the temp folders, each under its own name and its
// real one (/tmp and /private/tmp), so Jev recognises either. A root that is
// the home folder, or above it, is left out, so starting Pi in ~ doesn't make
// all of ~ fair game.
export function workspaceOf(root: string, home: string, temps: string[], real: (p: string) => string = (p) => p): string[] {
  const dirs: string[] = [];
  const add = (d: string) => {
    for (const name of [d, real(d)]) if (!dirs.includes(name)) dirs.push(name);
  };
  const realHome = real(home);
  if (![root, real(root)].some((r) => r === home || r === realHome || inside(realHome, [r]) || inside(home, [r]))) add(root);
  for (const t of temps) add(t);
  return dirs;
}

// ---------------------------------------------------------------- the call

export type Call = { action: string; path?: string };

// What Jev is asked about, in words. For write and edit, the resolved path
// too, for the fast path inside the workspace. Other tools aren't guarded.
export function describeCall(toolName: string, input: Record<string, unknown>, cwd: string, home: string, exists: (p: string) => boolean): Call | undefined {
  if (toolName === "bash" && typeof input.command === "string") return { action: `bash: ${input.command}` };
  if ((toolName === "write" || toolName === "edit") && typeof input.path === "string") {
    const path = resolvePath(input.path, cwd, home);
    if (toolName === "edit") return { action: `edit ${path}: changes part of an existing file`, path };
    return {
      action: exists(path) ? `write ${path}: replaces the whole file, which already exists` : `write ${path}: creates a new file`,
      path,
    };
  }
  return undefined;
}

// ---------------------------------------------------------------- Jev

export type Question = { type: "noul"; instructions: string; criteria: { true: string; false: string } };
export type Answers = Record<string, { noul?: number } | undefined>;

export type State = { action: string; working_directory: string; working_directory_in_workspace: boolean; workspace: string[]; home: string };

// One Noul per restriction, all in one call: does `action` keep to it?
export function questionsFor(policy: Policy): Record<string, Question> {
  return Object.fromEntries(
    policy.restrictions.map((r) => [
      r.id,
      {
        type: "noul",
        instructions: `Does \`action\`, run from \`working_directory\`, keep to this rule? ${r.rule}`,
        criteria: { true: r.keeps, false: r.breaks },
      },
    ]),
  );
}

export type Judged = { restriction: Restriction; p: number };
export type Verdict = { allowed: boolean; judged: Judged[]; doubted: Judged[] };

// Allowed only when every restriction is kept with at least the policy's
// confidence. A missing answer counts as 0.
export function verdictOf(policy: Policy, answers: Answers): Verdict {
  const judged = policy.restrictions.map((restriction) => {
    const p = answers[restriction.id]?.noul;
    return { restriction, p: typeof p === "number" && Number.isFinite(p) ? p : 0 };
  });
  const doubted = judged.filter((j) => j.p < policy.confidence);
  return { allowed: doubted.length === 0, judged, doubted };
}

// ---------------------------------------------------------------- blocked

const percent = (p: number) => `${Math.round(p * 100)}%`;

const BREAK_IT_DOWN =
  "Break it into smaller commands that each do one thing, with every path written out in full, so each can be checked on its own. Avoid chaining steps with &&, ; or |, and avoid hiding paths in variables, subshells, eval or scripts. If a step really has to go beyond these restrictions, don't look for a way around the guard: ask the user to run it themselves.";

// What the model reads in place of the tool's output when a call is blocked:
// why, every restriction (the doubted ones marked), the workspace, and what to
// do instead. `problem` is set when Jev couldn't be asked at all, and says
// what to do about it.
export function blockedMessage(policy: Policy, workspace: string[], verdict?: Verdict, problem?: string): string {
  const lines = [
    problem
      ? `Blocked by pi-thunder-guard: this call did not run. ${problem}`
      : `Blocked by pi-thunder-guard: this call did not run. It could not be confirmed, with ${percent(policy.confidence)} confidence, that it keeps to these restrictions:`,
  ];
  if (problem) lines.push("", "The restrictions in place:");
  for (const r of policy.restrictions) {
    const j = verdict?.doubted.find((d) => d.restriction.id === r.id);
    lines.push(`- ${r.title}: ${r.rule}${j ? ` (in doubt: ${percent(j.p)} sure it keeps to this)` : ""}`);
  }
  lines.push("", `The workspace: ${workspace.join(", ")}`);
  if (!problem) lines.push("", BREAK_IT_DOWN);
  return lines.join("\n");
}
