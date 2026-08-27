---
id: create-spec-quick
name: Create Quick Spec
version: 1.0.0
description: Create a spec for a change the user already understands, in a single pass
variables:
  description:
    type: string
    required: true
    description: User's feature description
  workspacePath:
    type: string
    required: true
    description: Workspace root path
  specBasePath:
    type: string
    required: true
    description: Base path for specs directory
  whiteboard:
    type: string
    required: false
    description: Compiled whiteboard scene, if one was linked
  whiteboardPaths:
    type: string
    required: false
    description: Source .excalidraw paths to copy into the spec folder
---

<user_input>
LAUNCH A QUICK SPEC WORKFLOW

Load the **quick** spec workflow system prompt: call the
*spec-system-prompt-loader* sub agent with the workflow type `quick`, then read
the file path it returns.

Feature Description: {{description}}

Workspace path: {{workspacePath}}
Spec base path: {{specBasePath}}

{{whiteboard}}

{{#if whiteboardPaths}}
Source whiteboard files:
{{whiteboardPaths}}

After you create the spec folder, COPY each of those files into it, keeping the
same filename. The drawing is part of the spec's record: someone reading the spec
later should be able to open the picture it came from. Copy, do not move -- the
original stays in `.claude/whiteboards/`.
{{/if}}

You have full control over the naming and file creation.
</user_input>
