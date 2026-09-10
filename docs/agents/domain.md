# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root — the glossary. Deliberately free of implementation detail.
- **`docs/adr/`** — read ADRs that touch the area you're about to work in. Eleven of them, numbered `0001`–`0011`.
- **`docs/fatti-verificati.md`** — read it **before** changing anything that touches Snapcast, the Sede, ffmpeg or the telecamere. See the precedence rules below.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The producer skill (`/grill-with-docs`) creates them lazily when terms or decisions actually get resolved.

## File structure

This is a **single-context** repo: one `CONTEXT.md` and one `docs/adr/`, both at the root.
There is no `CONTEXT-MAP.md` and no `src/<context>/docs/adr/`.

```
/
├── CONTEXT.md                                    ← glossary
├── project.md                                    ← client's document, NOT current truth
├── docs/
│   ├── fatti-verificati.md                       ← measured / sourced facts
│   ├── scostamenti-dal-documento-di-progetto.md  ← where project.md is wrong
│   └── adr/
│       ├── 0001-flusso-audio-continuo-per-zona.md
│       └── … 0011-dove-gira-snapserver-e-una-sede-non-un-if.md
└── src/
```

## Three sources, and they have a precedence

This repo does not have the usual two-source setup. `CLAUDE.md` documents the full rules
under **`## Le tre fonti di documentazione`** — read that section, it is the authority.
The three things that most often bite an agent that skips it:

1. **`docs/fatti-verificati.md` comes first for Snapcast, the Sede, ffmpeg and the
   telecamere.** Every line is tagged `[sorgente]` (read in upstream code), `[misurato]`
   (run on this machine) or `[surrogato]` (measured on a stand-in, needs redoing). When the
   code looks strange, the reason is almost always there — so read it before proposing a
   "simplification" that removes a workaround for something real.

2. **ADR corrections live at the bottom of the file and do not replace the text above.**
   Some ADRs were corrected after later research. An agent that reads only the top of an
   ADR will act on a decision that has since been amended. Read to the end.

3. **`project.md` is not current truth.** It's the client's document and contains factual
   errors and unreachable criteria found during analysis. Where `project.md` and
   `docs/scostamenti-dal-documento-di-progetto.md` disagree, **the latter wins**.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

Here that means Italian for the domain and English for the mechanics: Zona, Altoparlante,
Telecamera, Suono, Effetto, Sottofondo, Flusso, Identifica, Ponte, Sede — against `worker`,
`schema`, `Status:`, and the rest of the plumbing.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/grill-with-docs`). `CONTEXT.md` has an **`## Ambiguità aperte`** section for exactly this.

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (formato audio PCM stereo, buffer 2000) — but worth reopening because…_

## When to write, not just read

`CLAUDE.md` sets the threshold, and it's not "every change":

- A new decision that is **hard to reverse, surprising, and a genuine trade-off** earns an ADR.
- Anything you actually **measure** earns a line in `docs/fatti-verificati.md`, tagged
  `[sorgente]` / `[misurato]` / `[surrogato]`.
- A new domain term earns an entry in `CONTEXT.md`.
