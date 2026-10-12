---
confidence: 0.9
# Files or folders outside the repository that agents may change freely.
editable:
  - ~/.config/zsh/agents.zsh
---

# Restrictions

The guard asks Jev about every bash call, and about every write or edit outside the workspace: does it keep to each restriction below? A call runs only when Jev is at least `confidence` sure it keeps to all of them. Otherwise it is blocked, and the model is shown the rules again and asked to break the command into simpler steps.

Each `##` section is one restriction, asked as its own question:
- **Rule** is what the model is shown when a call is blocked.
- **Keeps it** and **Breaks it** go only to Jev. Describe situations and give examples, rather than degrees ("very dangerous").

`editable` lists files or folders outside the repository that agents may change anyway: here, the agent settings that ~/.zshrc sources.

In Jev's state, `action` is the call itself, `workspace` is the list of folders and files the agent may change freely (the repository, its shared .git folder, the temp folders and the `editable` paths, under every name they go by), `paths` lists each path written out in `action`, resolved, with whether it is in `workspace` (worked out by code, so it can be trusted), `working_directory` is where the call runs, `working_directory_in_workspace` says whether that is inside `workspace`, and `home` is the home folder.

## Files outside the workspace

Rule: Don't delete, overwrite, move, empty or change the permissions of files or folders outside the workspace.

Keeps it: Everything it deletes, overwrites, moves or empties is in `workspace`: every entry of `paths` it changes has `in_workspace` true. Relative paths, `.`, and commands that name no path (tests, builds, installs, git in the current repository or worktree, which changes only the repository and its .git folder) act inside `working_directory`, which is in `workspace` when `working_directory_in_workspace` is true. Anything under /tmp, /private/tmp or /var/folders (the temp folders) is in `workspace`. Reading, listing and searching anywhere is fine. So is installing or updating packages (brew install, npm install -g, pip install, cargo install), and creating a new file anywhere when it doesn't replace one.

Breaks it: It deletes, overwrites, truncates, moves or renames something outside `workspace`: rm, mv or cp onto an existing path, `>` or `>>` redirection onto an existing file outside `workspace`, truncate, find -delete, rsync --delete, or git clean, reset or checkout in another folder. Or it changes the permissions or owner of something outside `workspace` (chmod, chown). For example, anything in `home`, ~/Documents, ~/Desktop, ~/Downloads or another repository.

## Startup and access files

Rule: Don't change shell startup files, or anything that runs or grants access automatically.

Keeps it: It doesn't write to any of the files below. Reading them is fine, and so is changing anything listed in `workspace`, such as the agent settings file ~/.config/zsh/agents.zsh, even though ~/.zshrc sources it.

Breaks it: It writes, appends to, replaces, moves or deletes ~/.zshrc, ~/.zshenv, ~/.zprofile, ~/.zlogin, ~/.bashrc, ~/.bash_profile or ~/.profile; anything in ~/.ssh, ~/.pi, ~/Library/LaunchAgents or /Library/LaunchDaemons; the crontab (crontab -e, or crontab given a file); or ~/.gitconfig (including git config --global).

## The disk and the system

Rule: Don't use administrator rights, or erase, format or write raw to a disk.

Keeps it: It runs as the user, without sudo, and leaves disks and system settings alone.

Breaks it: It uses sudo, su or doas. Or it formats, partitions, erases or unmounts a disk (diskutil erase or partition, mkfs, fdisk). Or it writes raw to a device (dd of=/dev/...). Or it changes system or security settings (csrutil, spctl, systemsetup, networksetup). Or it shuts down or restarts the machine.
