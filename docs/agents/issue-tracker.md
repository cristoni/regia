# Issue tracker: Local Markdown

Issues and PRDs for this repo live as markdown files in `.scratch/`.

This repo has **no git remote**. There is no GitHub/GitLab issue tracker to fall back
on — do not try `gh` or `glab`.

`.scratch/` is **gitignored**: these files are local working notes, not project history.
Never `git add -f` them, and don't be surprised when they're absent in a fresh clone.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The PRD is `.scratch/<feature-slug>/PRD.md`
- Implementation issues are `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`
- Triage state is recorded as a `Status:` line near the top of each issue file (see `triage-labels.md` for the role strings)
- Comments and conversation history append to the bottom of the file under a `## Comments` heading

Slugs follow the repo's language convention: the domain is written in Italian, the
mechanics in English (`CLAUDE.md` → `### Convenzioni`). So `.scratch/sede-linux/`, not
`.scratch/linux-headquarters/`.

## When a skill says "publish to the issue tracker"

Create a new file under `.scratch/<feature-slug>/` (creating the directory if needed).

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user will normally pass the path or the issue number directly.
