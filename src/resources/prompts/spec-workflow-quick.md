# Quick Spec Workflow

You are running the **quick** spec workflow. It exists for changes the user
already understands: a known feature, a bounded refactor, a UI element they can
describe or has been drawn on a whiteboard.

The full workflow (`spec-workflow-starter.md`) is built for *discovery* — parallel
candidate documents and tournament judging explore a solution space the user has
not yet mapped. Quick mode is not a degraded version of it. It is the correct tool
when the space is already known, and paying for exploration you do not need is the
mistake it is designed to avoid.

You MUST NOT reintroduce the full workflow's ceremony. Specifically, in quick mode:

- You MUST NOT ask how many agents to use. The count is always 1.
- You MUST NOT dispatch `spec-judge`. There are no competing candidates to judge.
- You MUST NOT produce separate `requirements.md` and `design.md`.
- You MUST NOT ask for approval more than once.

## Documents

Quick mode produces exactly two files in `{spec_base_path}/{feature_name}/`:

| File | Contents |
| ---- | -------- |
| `spec.md` | Requirements and design in one document |
| `tasks.md` | The implementation checklist |

### `spec.md` structure

```markdown
# {Feature Name}

## Context
One paragraph: what this changes and why.

## Requirements
Numbered, testable statements. Keep the numbering — tasks reference it.
1. ...
2. ...

## Design
How it will be built. Name real files and symbols. Include only the
decisions that constrain implementation; skip restating the requirements.

## Out of scope
What this deliberately does not do. Prevents scope drift during implementation.
```

If a whiteboard was supplied, its compiled contents arrive in the user message as a
`<whiteboard>` block containing SHAPE / EDGE / NOTE lines. Treat those as
**primary source requirements**, not as illustration:

- `SHAPE "X" at (x,y) WxH` — a UI element that must exist, with its layout intent.
  Relative position and size are the design constraint; exact pixels usually are not.
- `EDGE "A" -> "B" [label]` — a behaviour. The label is the trigger. Each edge
  should become at least one numbered requirement.
- `NOTE "..."` — a free-floating annotation. Treat it as a requirement unless it
  is clearly a reminder to the author.

Every shape and edge MUST be accounted for in Requirements, or listed under
"Out of scope" with a reason. Do not silently drop parts of the drawing.

### `tasks.md` structure

Identical to the full workflow, so Auto Mode and the ModelRole routing work
unchanged:

```markdown
- [ ] 1.1 Short imperative task title
  - What the task must accomplish, in one or two lines.
  - _Requirements: 1.2, 1.3_
  - _ModelRole: worker_
```

- Every task MUST carry `_Requirements:_` referencing `spec.md` numbering.
- Every task MUST carry `_ModelRole:_` — `worker` for routine bounded work,
  `architect` for cross-cutting, integration, or reconciliation work.
- Prefer many small independent tasks over few large ones. Independent tasks
  execute as one parallel wave; sequential dependencies serialize the run.
- State dependencies explicitly when they exist, so waves can be ordered.

## Sequence

1. Read the user's description, and the `<whiteboard>` block if present.
2. Write `spec.md` and `tasks.md` in a single pass. Do not stop between them.
3. Present both, and ask once: "Approve and start implementation?"
4. On approval, implement. Follow the same execution rules as the full workflow:
   dependency-ordered waves in Auto Mode, `_ModelRole:_` selecting the subagent
   type, one task at a time otherwise.

If the request turns out to be genuinely open-ended — competing architectures, an
unclear problem, requirements that need discovery — say so and recommend the full
workflow instead of guessing. That judgement call is yours to make once, before
writing `spec.md`, not midway through.
