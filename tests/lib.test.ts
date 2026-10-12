import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { blockedMessage, describeCall, inside, parsePolicy, questionsFor, realPath, resolvePath, verdictOf, workspaceOf } from "../lib.ts";

const SHIPPED = readFileSync(new URL("../restrictions.md", import.meta.url), "utf8");

test("the shipped restrictions parse", () => {
  const policy = parsePolicy(SHIPPED);
  assert.equal(policy.confidence, 0.9);
  assert.deepEqual(
    policy.restrictions.map((r) => r.id),
    ["files_outside_the_workspace", "startup_and_access_files", "the_disk_and_the_system"],
  );
  for (const r of policy.restrictions) {
    assert.ok(r.rule.startsWith("Don't"), r.id);
    assert.ok(r.keeps.length > 20 && r.breaks.length > 20, r.id);
    assert.ok(!r.rule.includes("Keeps it"), r.id);
  }
  assert.match(policy.restrictions[1].breaks, /~\/\.zshrc/);
});

test("a restriction spans lines, and a broken file says what is wrong", () => {
  const policy = parsePolicy("# notes\n\n## No pets\n\nRule: Don't\nadopt a cat.\n\nKeeps it: no cat.\nBreaks it: a cat.\n");
  assert.equal(policy.confidence, 0.9);
  assert.deepEqual(policy.restrictions[0], { id: "no_pets", title: "No pets", rule: "Don't adopt a cat.", keeps: "no cat.", breaks: "a cat." });
  assert.throws(() => parsePolicy("## No pets\nRule: x\nKeeps it: y\n"), /needs Breaks it:/);
  assert.throws(() => parsePolicy("just notes"), /no restrictions/);
  assert.throws(() => parsePolicy("---\nconfidence: 90\n---\n## A\nRule: a\nKeeps it: b\nBreaks it: c\n"), /between 0 and 1/);
  assert.throws(() => parsePolicy("## A\nRule: a\nKeeps it: b\nBreaks it: c\n## A\nRule: a\nKeeps it: b\nBreaks it: c\n"), /two restrictions/);
  assert.equal(parsePolicy("---\nconfidence: 0.75\n---\n## A\nRule: a\nKeeps it: b\nBreaks it: c\n").confidence, 0.75);
});

test("paths resolve like Pi's file tools, through symlinks, even when missing", () => {
  assert.equal(resolvePath("~/.zshrc", "/repo", "/Users/me"), "/Users/me/.zshrc");
  assert.equal(resolvePath("@src/a.ts", "/repo", "/Users/me"), "/repo/src/a.ts");
  assert.equal(resolvePath("../other/x", "/repo/sub", "/Users/me"), "/repo/other/x");
  const base = realpathSync(mkdtempSync(join(tmpdir(), "guard-")));
  symlinkSync(base, join(base, "link"));
  assert.equal(realPath(join(base, "link", "new", "file.txt")), join(base, "new", "file.txt"));
});

test("the workspace is the repository and the temp folders, never home or above", () => {
  const temps = ["/private/tmp", "/var/folders/x/T"];
  assert.deepEqual(workspaceOf("/Users/me/repos/app", "/Users/me", temps), ["/Users/me/repos/app", ...temps]);
  assert.deepEqual(workspaceOf("/Users/me", "/Users/me", temps), temps);
  assert.deepEqual(workspaceOf("/", "/Users/me", temps), temps);
  const real = (p: string) => (p === "/tmp" ? "/private/tmp" : p);
  assert.deepEqual(workspaceOf("/Users/me/repos/app", "/Users/me", ["/tmp"], real), ["/Users/me/repos/app", "/tmp", "/private/tmp"]);
  assert.ok(inside("/Users/me/repos/app/src/a.ts", ["/Users/me/repos/app"]));
  assert.ok(!inside("/Users/me/repos/app-old/a.ts", ["/Users/me/repos/app"]));
  assert.ok(inside("/Users/me/repos/app", ["/Users/me/repos/app"]));
});

test("calls are described for Jev; other tools aren't guarded", () => {
  const exists = (p: string) => p === "/Users/me/notes.md";
  assert.deepEqual(describeCall("bash", { command: "ls -la" }, "/repo", "/Users/me", exists), { action: "bash: ls -la" });
  assert.deepEqual(describeCall("write", { path: "~/notes.md", content: "x" }, "/repo", "/Users/me", exists), {
    action: "write /Users/me/notes.md: replaces the whole file, which already exists",
    path: "/Users/me/notes.md",
  });
  assert.equal(describeCall("write", { path: "~/new.md", content: "x" }, "/repo", "/Users/me", exists)?.action, "write /Users/me/new.md: creates a new file");
  assert.equal(describeCall("edit", { path: "src/a.ts", edits: [] }, "/repo", "/Users/me", exists)?.path, "/repo/src/a.ts");
  assert.equal(describeCall("read", { path: "/etc/hosts" }, "/repo", "/Users/me", exists), undefined);
  assert.equal(describeCall("grep", { pattern: "x" }, "/repo", "/Users/me", exists), undefined);
});

test("one Noul per restriction, with both outcomes described", () => {
  const policy = parsePolicy(SHIPPED);
  const q = questionsFor(policy);
  assert.deepEqual(Object.keys(q), policy.restrictions.map((r) => r.id));
  const first = q.files_outside_the_workspace;
  assert.equal(first.type, "noul");
  assert.match(first.instructions, /^Does `action`, run from `working_directory`, keep to this rule\? Don't delete/);
  assert.equal(first.criteria.true, policy.restrictions[0].keeps);
  assert.equal(first.criteria.false, policy.restrictions[0].breaks);
});

test("a call runs only when every restriction clears the confidence", () => {
  const policy = parsePolicy(SHIPPED);
  const all = (p: number) => Object.fromEntries(policy.restrictions.map((r) => [r.id, { noul: p }]));
  assert.equal(verdictOf(policy, all(0.97)).allowed, true);
  assert.equal(verdictOf(policy, all(0.9)).allowed, true);
  const one = verdictOf(policy, { ...all(0.99), startup_and_access_files: { noul: 0.4 } });
  assert.equal(one.allowed, false);
  assert.deepEqual(one.doubted.map((d) => d.restriction.id), ["startup_and_access_files"]);
  const missing = verdictOf(policy, { files_outside_the_workspace: { noul: 0.99 } });
  assert.equal(missing.allowed, false);
  assert.equal(missing.doubted.length, 2);
});

test("a blocked call repeats every restriction, marks the doubted ones and says to break it down", () => {
  const policy = parsePolicy(SHIPPED);
  const verdict = verdictOf(policy, { files_outside_the_workspace: { noul: 0.42 }, startup_and_access_files: { noul: 0.99 }, the_disk_and_the_system: { noul: 0.99 } });
  const text = blockedMessage(policy, ["/Users/me/repos/app", "/private/tmp"], verdict);
  assert.match(text, /^Blocked by pi-thunder-guard: this call did not run\. It could not be confirmed, with 90% confidence/);
  assert.match(text, /- Files outside the workspace: Don't delete.*\(in doubt: 42% sure it keeps to this\)/);
  assert.match(text, /- Startup and access files: Don't change shell startup files, or anything that runs or grants access automatically\.\n/);
  assert.match(text, /- The disk and the system: /);
  assert.match(text, /The workspace: \/Users\/me\/repos\/app, \/private\/tmp/);
  assert.match(text, /Break it into smaller commands/);
  assert.match(text, /ask the user to run it themselves/);

  const down = blockedMessage(policy, ["/private/tmp"], undefined, "Jev couldn't be asked (timeout). Try once more; if it keeps failing, tell the user.");
  assert.match(down, /did not run\. Jev couldn't be asked \(timeout\)/);
  assert.match(down, /The restrictions in place:\n- Files outside the workspace/);
  assert.doesNotMatch(down, /Break it into/);
});
