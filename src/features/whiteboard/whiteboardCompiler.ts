/**
 * Compiles an .excalidraw scene into text a spec agent can reason about.
 *
 * An .excalidraw file is JSON, not an image, so a drawing can be primary source
 * material for a spec rather than an illustration beside it. Labelled boxes are
 * UI elements, bound arrows are behaviours, and loose text is annotation.
 */

interface ExcalidrawElement {
    id: string;
    type: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    text?: string;
    containerId?: string | null;
    isDeleted?: boolean;
    startBinding?: { elementId: string } | null;
    endBinding?: { elementId: string } | null;
}

const CONTAINER_TYPES = new Set(['rectangle', 'ellipse', 'diamond', 'image', 'frame']);

export interface CompiledWhiteboard {
    lines: string[];
    shapeCount: number;
    edgeCount: number;
    noteCount: number;
}

export function compileWhiteboard(raw: string): CompiledWhiteboard {
    let scene: { elements?: ExcalidrawElement[] };
    try {
        scene = JSON.parse(raw);
    } catch {
        return { lines: [], shapeCount: 0, edgeCount: 0, noteCount: 0 };
    }

    const elements = (scene.elements ?? []).filter(e => e && !e.isDeleted);
    const byId = new Map(elements.map(e => [e.id, e]));

    // Text bound to a shape is that shape's label rather than a note of its own.
    const labels = new Map<string, string>();
    for (const el of elements) {
        if (el.type === 'text' && el.containerId && el.text?.trim()) {
            labels.set(el.containerId, el.text.trim().replace(/\s+/g, ' '));
        }
    }

    const nameOf = (id: string | undefined): string => {
        if (!id) { return 'unlabelled'; }
        const label = labels.get(id);
        if (label) { return label; }
        const el = byId.get(id);
        return el ? `unlabelled ${el.type}` : 'unknown';
    };

    const lines: string[] = [];
    let shapeCount = 0, edgeCount = 0, noteCount = 0;

    // Reading order: top to bottom, then left to right, so the output matches
    // how someone scanning the drawing would describe it.
    const ordered = [...elements].sort((a, b) => (a.y ?? 0) - (b.y ?? 0) || (a.x ?? 0) - (b.x ?? 0));

    for (const el of ordered) {
        if (CONTAINER_TYPES.has(el.type)) {
            const size = el.width && el.height
                ? ` ${Math.round(el.width)}x${Math.round(el.height)}`
                : '';
            lines.push(`SHAPE  "${nameOf(el.id)}"  at (${Math.round(el.x ?? 0)},${Math.round(el.y ?? 0)})${size}`);
            shapeCount++;
        } else if (el.type === 'arrow' || el.type === 'line') {
            const from = el.startBinding?.elementId;
            const to = el.endBinding?.elementId;
            // An unbound arrow points at empty space; it carries no relation.
            if (!from || !to) { continue; }
            const label = labels.get(el.id);
            lines.push(`EDGE   "${nameOf(from)}" -> "${nameOf(to)}"${label ? `  [${label}]` : ''}`);
            edgeCount++;
        } else if (el.type === 'text' && !el.containerId && el.text?.trim()) {
            lines.push(`NOTE   "${el.text.trim().replace(/\s+/g, ' ')}"`);
            noteCount++;
        }
    }

    return { lines, shapeCount, edgeCount, noteCount };
}

/**
 * Wraps compiled scenes in the <whiteboard> block the quick workflow expects.
 * Returns an empty string when nothing usable was found, so callers can omit
 * the block entirely rather than passing an empty one.
 */
export function formatForPrompt(boards: Array<{ name: string; compiled: CompiledWhiteboard }>): string {
    const usable = boards.filter(b => b.compiled.lines.length > 0);
    if (usable.length === 0) { return ''; }

    const parts = usable.map(({ name, compiled }) =>
        [`## ${name}`, ...compiled.lines].join('\n')
    );

    return [
        '<whiteboard>',
        'Compiled from the linked Excalidraw whiteboard(s). Treat SHAPE, EDGE and',
        'NOTE lines as primary source requirements, not as illustration.',
        '',
        ...parts,
        '</whiteboard>'
    ].join('\n');
}
