// Auto-generated from src/prompts/draft/create-draft.md
// DO NOT EDIT MANUALLY

export const frontmatter = {
  "id": "create-draft",
  "name": "Create Draft",
  "version": "1.0.0",
  "description": "A one-off throwaway session with no spec artifacts",
  "variables": {
    "request": {
      "type": "string",
      "required": true,
      "description": "What the user wants done"
    },
    "workspacePath": {
      "type": "string",
      "required": true,
      "description": "Workspace root path"
    },
    "whiteboard": {
      "type": "string",
      "required": false,
      "description": "Compiled whiteboard scene, when one was referenced with @name"
    }
  }
};

export const content = "\n<user_input>\nDRAFT SESSION - one-off work, no spec artifacts.\n\nWorkspace: {{workspacePath}}\n\nRequest: {{request}}\n\n{{whiteboard}}\n\n## How to run a draft\n\nThis is a throwaway. Do not create `requirements.md`, `design.md`, `tasks.md`,\nor a spec folder. Do not ask for approval between steps. Just do the work.\n\n- Ask at most **one** clarifying question, and only if you genuinely cannot\n  start without the answer. Otherwise pick sensible defaults, state them in one\n  line, and proceed.\n- Prefer **official scaffolding tools** over hand-rolling. `create-t3-app`,\n  `create-next-app`, `cargo new`, framework CLIs and generators exist and are\n  faster and more correct than assembling files by hand. Reach for the real\n  installer first.\n- Prefer ecosystem defaults and conventions over custom design. A draft is not\n  where you invent architecture.\n- Do not add tests, CI, README files, or documentation unless asked.\n- Do not refactor code you were not asked to touch.\n\n## How to write back\n\nThe user reads every draft summary. Optimise for scanning, not for completeness.\nThese limits are derived from ASD-STE100, the controlled-English standard for\ntechnical documentation. Treat them as hard rules, not preferences.\n\nLength:\n\n- Final summary: 10 lines maximum.\n- Sentences: 20 words maximum, one idea each. No semicolons.\n- Paragraphs: 4 sentences maximum.\n\nWording:\n\n- Active voice, simple tenses. \"Added the route\", not \"the route has been added\".\n- Use the same word for the same thing every time. Do not vary it for elegance.\n- No hedge stacks. \"Should mostly work in theory\" tells the user nothing -- state\n  what you verified and what you did not.\n- No marketing adjectives: robust, seamless, powerful, comprehensive, modern.\n- No nominalised verbs. \"Validated the input\", not \"performed validation of it\".\n- No noun clusters longer than three words.\n- Technical terms are exempt from all of the above. Never rename a real symbol,\n  file, flag, or library to make a sentence simpler.\n\nContent:\n\n- Reference code as `path/to/file.ts:42` so the user can jump straight to it.\n- Do not explain code that is visible in the diff. Explain decisions that are not.\n\nEnd every draft with exactly this shape:\n\n```\nDid:      what changed, one line per item\nAssumed:  every default you picked without asking\nCheck:    anything you could not verify\n```\n\nWrite `Assumed: none` or `Check: nothing` rather than dropping a heading.\n\nIf the request turns out to be substantially larger than a one-off -- multiple\nsubsystems, real architectural choices, work that wants a review gate -- say so\nearly and suggest a quick spec instead. Do not silently expand a draft into a\nproject.\n</user_input>\n";

export default {
  frontmatter,
  content
};
