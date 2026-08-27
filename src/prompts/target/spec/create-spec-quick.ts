// Auto-generated from src/prompts/spec/create-spec-quick.md
// DO NOT EDIT MANUALLY

export const frontmatter = {
  "id": "create-spec-quick",
  "name": "Create Quick Spec",
  "version": "1.0.0",
  "description": "Create a spec for a change the user already understands, in a single pass",
  "variables": {
    "description": {
      "type": "string",
      "required": true,
      "description": "User's feature description"
    },
    "workspacePath": {
      "type": "string",
      "required": true,
      "description": "Workspace root path"
    },
    "specBasePath": {
      "type": "string",
      "required": true,
      "description": "Base path for specs directory"
    },
    "whiteboard": {
      "type": "string",
      "required": false,
      "description": "Compiled whiteboard scene, if one was linked"
    },
    "whiteboardPaths": {
      "type": "string",
      "required": false,
      "description": "Source .excalidraw paths to copy into the spec folder"
    }
  }
};

export const content = "\n<user_input>\nLAUNCH A QUICK SPEC WORKFLOW\n\nLoad the **quick** spec workflow system prompt: call the\n*spec-system-prompt-loader* sub agent with the workflow type `quick`, then read\nthe file path it returns.\n\nFeature Description: {{description}}\n\nWorkspace path: {{workspacePath}}\nSpec base path: {{specBasePath}}\n\n{{whiteboard}}\n\n{{#if whiteboardPaths}}\nSource whiteboard files:\n{{whiteboardPaths}}\n\nAfter you create the spec folder, COPY each of those files into it, keeping the\nsame filename. The drawing is part of the spec's record: someone reading the spec\nlater should be able to open the picture it came from. Copy, do not move -- the\noriginal stays in `.claude/whiteboards/`.\n{{/if}}\n\nYou have full control over the naming and file creation.\n</user_input>\n";

export default {
  frontmatter,
  content
};
