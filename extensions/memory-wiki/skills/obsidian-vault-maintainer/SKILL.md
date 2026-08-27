---
name: obsidian-vault-maintainer
description: Maintain an Obsidian-friendly memory wiki vault with wikilinks, frontmatter, and official Obsidian CLI awareness.
---

Use this skill when the memory-wiki vault render mode is `obsidian` or the user wants the wiki to play nicely with Obsidian.

- Start from `afora wiki status` to confirm the vault mode and whether the official Obsidian CLI is available.
- Use `afora wiki obsidian status` before shelling out, then prefer the dedicated helpers like `afora wiki obsidian search`, `afora wiki obsidian open`, `afora wiki obsidian command`, and `afora wiki obsidian daily`.
- Prefer `[[Wikilinks]]`, stable filenames, and frontmatter that works with Obsidian dashboards and Dataview-style queries.
- Keep generated sections deterministic so Obsidian users can safely add handwritten notes around them.
- If the official Obsidian CLI is enabled, probe it before depending on it. Do not assume the app is installed, running, or configured.
- Avoid destructive renames unless you also have a link-repair plan.
