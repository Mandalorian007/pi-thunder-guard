# pi-thunder-guard

A happy-path guard for [Pi](https://pi.dev): it stops an agent's mistakes from wiping your disk or your files. Before each bash call, Jev (TypeSafe's System One) is asked whether the call keeps to a short list of restrictions. Writes and edits outside the repository are checked the same way. A call runs only when Jev is at least 90% sure it keeps to every restriction. Otherwise it is blocked, and the model is told:
- the restrictions;
- which one was in doubt;
- to break the command into simpler steps, or to ask you to run it.

It guards against mistakes, not against an agent that sets out to get around it.

## Install

```sh
pi install git:github.com/Mandalorian007/pi-thunder-guard
```

Pin a version with `@v0.2.0`. It needs a Jev key: `typesafe` in `~/.pi/agent/auth.json`, or `TYPESAFE_API_KEY`. Install it for the user, so every Pi process loads it, subagents included.

## What is checked

| Call | Checked |
|---|---|
| `bash` | Always, by Jev |
| `write`, `edit` inside the workspace | Never: it runs |
| `write`, `edit` outside the workspace | By Jev. A write says whether it replaces an existing file or creates one |
| Anything else (read, grep, find, ls, other tools) | Never |
| Your own `!command` in Pi | Never |

The **workspace** is:
- the repository Pi runs in (or the working directory, outside a repository);
- the repository's shared `.git` folder. In a worktree that folder is outside the checkout, but all the repository's worktrees share it;
- `/tmp`;
- the user temp folder (`$TMPDIR`);
- the `editable` paths in the restrictions file. The shipped file lists `~/.config/zsh/agents.zsh`, the agent settings that `~/.zshrc` sources, so agents can change their own aliases while `~/.zshrc` itself stays protected.

Each is listed under its own name and its real one (`/tmp` and `/private/tmp`). If the working directory is your home folder or above it, only the temp folders count, so starting Pi in `~` doesn't make all of `~` fair game.

## The restrictions

They live in [`restrictions.md`](restrictions.md):

| Restriction | Rule |
|---|---|
| Files outside the workspace | Don't delete, overwrite, move, empty or change the permissions of files or folders outside the workspace |
| Startup and access files | Don't change shell startup files, or anything that runs or grants access automatically (`~/.zshrc` and the like, `~/.ssh`, `~/.pi`, launch agents, crontab, `~/.gitconfig`) |
| The disk and the system | Don't use administrator rights, or erase, format or write raw to a disk |

Each `##` section is one restriction:
- **Rule** is what the model is shown when a call is blocked.
- **Keeps it** and **Breaks it** describe, for Jev, what each answer looks like.

The file's frontmatter holds the confidence (`0.9`) and the `editable` list:

```yaml
---
confidence: 0.9
editable:
  - ~/.config/zsh/agents.zsh
---
```

## How a call is decided

1. The call is described in words: `bash: <command>`, or `write <path>: replaces the whole file, which already exists`.
2. One request goes to Jev. Its state is:
   - the call;
   - each path written out in the command (anything starting with `/`, `~`, `./`, `../` or `$HOME`), resolved, with whether it is in the workspace. Code works this out, not Jev;
   - the working directory, and whether that is inside the workspace;
   - the workspace folders;
   - the home folder.

   It asks one yes-or-no question per restriction: does this call keep to the rule? File contents and the conversation are never sent. A request takes about 0.15–0.35 s and costs about $0.00005.
3. If every answer is at least the confidence, the call runs. If any is below it, the call is blocked.
4. If Jev can't be asked (no key, a timeout, an error after three tries), the call is blocked and the message says why. It never runs unchecked.

Every decision is saved in the session as a `thunder-guard` entry: the call, each restriction's score, whether it was allowed, the time taken and the input tokens. In the terminal, a block also shows a warning.

## What the model sees when a call is blocked

```
Blocked by pi-thunder-guard: this call did not run. It could not be confirmed, with 90% confidence, that it keeps to these restrictions:
- Files outside the workspace: Don't delete, overwrite, move, empty or change the permissions of files or folders outside the workspace. (in doubt: 21% sure it keeps to this)
- Startup and access files: Don't change shell startup files, or anything that runs or grants access automatically.
- The disk and the system: Don't use administrator rights, or erase, format or write raw to a disk.

The workspace: /Users/me/repos/app, /tmp, /private/tmp, /var/folders/…/T, /private/var/folders/…/T

Break it into smaller commands that each do one thing, with every path written out in full, so each can be checked on its own. Avoid chaining steps with &&, ; or |, and avoid hiding paths in variables, subshells, eval or scripts. If a step really has to go beyond these restrictions, don't look for a way around the guard: ask the user to run it themselves.
```

## Changing the restrictions

- **For everyone:** edit `restrictions.md` here, then run `npm run calibrate`. It asks Jev about 45 labelled calls (22 that should run, 23 that should be blocked; some run from a worktree) and prints each score, for about $0.002. Add a case whenever a call is wrongly allowed or blocked.
- **Just for you:** copy the file to `~/.pi/agent/guard.md`. That copy replaces the shipped one. Check it with `npm run calibrate -- ~/.pi/agent/guard.md`.

The file is read on every call, so an edit applies at once. A broken file blocks every guarded call and says what is wrong.

Calibration at v0.2.0: 41 of the 45 calls were decided as labelled.
- **Every call that should be blocked was,** each with at least one restriction at 0.37 or below.
- **The misses were all blocked rather than allowed:** creating a new file outside the workspace (about 0.8), and calls that land close to 0.9, such as `brew install jq` and a `>>` onto a worktree's shared `.git/info/exclude`.
- **Jev's scores move by about 0.04 between identical runs,** so a safe call scoring around 0.9 is sometimes blocked. The model then gets the advice to break the call down, which usually gets it through.

## Turning it off

`PI_THUNDER_GUARD=off pi …` runs without it. Setting that inside a bash call does nothing: the guard is already running in the Pi process.

## Limits

- **Jev reads the command, not what it runs.** `./deploy.sh` or `make install` is judged by its name.
- **It isn't a sandbox.** A determined agent can hide what a command does. Treat it as one signal among others: version control, backups, and not running Pi as root.
- **PowerShell and other tools that write files aren't covered.** Only the `bash`, `write` and `edit` tools are checked.

## Files

- `restrictions.md`: the restrictions and the confidence.
- `lib.ts`: parsing the restrictions, the workspace, the question, the verdict and the block message. No session needed.
- `index.ts`: the `tool_call` hook, the Jev client and the session record.
- `scripts/calibrate.ts`: the labelled calls.

`npm test` runs `lib.ts` offline.
