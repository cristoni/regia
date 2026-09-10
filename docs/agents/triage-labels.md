# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.

## How a label is applied here

The issue tracker is local markdown (see `issue-tracker.md`), so there is no label API.
A label is a `Status:` line near the top of the issue file, holding exactly one of the
right-hand-column strings:

```markdown
# Il datadir viene dalla Sede

Status: ready-for-agent
```

"Applying a label" means rewriting that line; "removing a label" means replacing it with
another role, not deleting the line. An issue file with no `Status:` line is untriaged —
treat it as `needs-triage`.

These five strings stay in English on purpose: they're mechanics, not domain. The repo's
convention is Italian for the domain, English for the machinery
(`CLAUDE.md` → `### Convenzioni`).
