---
id: create-draft
name: Create Draft
version: 1.0.0
description: A one-off throwaway session with no spec artifacts
variables:
  request:
    type: string
    required: true
    description: What the user wants done
  workspacePath:
    type: string
    required: true
    description: Workspace root path
  whiteboard:
    type: string
    required: false
    description: Compiled whiteboard scene, when one was referenced with @name
---

<user_input>
DRAFT SESSION - one-off work, no spec artifacts.

Workspace: {{workspacePath}}

Request: {{request}}

{{whiteboard}}

## How to run a draft

This is a throwaway. Do not create `requirements.md`, `design.md`, `tasks.md`,
or a spec folder. Do not ask for approval between steps. Just do the work.

- Ask at most **one** clarifying question, and only if you genuinely cannot
  start without the answer. Otherwise pick sensible defaults, state them in one
  line, and proceed.
- Prefer **official scaffolding tools** over hand-rolling. `create-t3-app`,
  `create-next-app`, `cargo new`, framework CLIs and generators exist and are
  faster and more correct than assembling files by hand. Reach for the real
  installer first.
- Prefer ecosystem defaults and conventions over custom design. A draft is not
  where you invent architecture.
- Do not add tests, CI, README files, or documentation unless asked.
- Do not refactor code you were not asked to touch.

## How to write back

The user reads every draft summary. Optimise for scanning, not for completeness.
These limits are derived from ASD-STE100, the controlled-English standard for
technical documentation. Treat them as hard rules, not preferences.

Length:

- Final summary: 10 lines maximum.
- Sentences: 20 words maximum, one idea each. No semicolons.
- Paragraphs: 4 sentences maximum.

Wording:

- Active voice, simple tenses. "Added the route", not "the route has been added".
- Use the same word for the same thing every time. Do not vary it for elegance.
- No hedge stacks. "Should mostly work in theory" tells the user nothing -- state
  what you verified and what you did not.
- No marketing adjectives: robust, seamless, powerful, comprehensive, modern.
- No nominalised verbs. "Validated the input", not "performed validation of it".
- No noun clusters longer than three words.
- Technical terms are exempt from all of the above. Never rename a real symbol,
  file, flag, or library to make a sentence simpler.

Content:

- Reference code as `path/to/file.ts:42` so the user can jump straight to it.
- Do not explain code that is visible in the diff. Explain decisions that are not.

End every draft with exactly this shape:

```
Did:      what changed, one line per item
Assumed:  every default you picked without asking
Check:    anything you could not verify
```

Write `Assumed: none` or `Check: nothing` rather than dropping a heading.

If the request turns out to be substantially larger than a one-off -- multiple
subsystems, real architectural choices, work that wants a review gate -- say so
early and suggest a quick spec instead. Do not silently expand a draft into a
project.
</user_input>
