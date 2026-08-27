import * as vscode from 'vscode';
import * as path from 'path';
import { compileWhiteboard, formatForPrompt, CompiledWhiteboard } from './whiteboardCompiler';

export const EXCALIDRAW_EXTENSION_ID = 'pomdtr.excalidraw-editor';
/** Custom editor view type the Excalidraw extension registers for *.excalidraw. */
export const EXCALIDRAW_VIEW_TYPE = 'editor.excalidraw';
export const WHITEBOARDS_DIR = '.claude/whiteboards';

export interface WhiteboardInfo {
    name: string;
    path: string;
    /** Spec this board belongs to, or undefined for a standalone board. */
    specName?: string;
}

/**
 * Whiteboards are plain .excalidraw files. They are linked to a spec by living
 * inside that spec's folder -- no link syntax to write or keep in sync.
 */
export class WhiteboardManager {
    constructor(
        private outputChannel: vscode.OutputChannel,
        private getSpecBasePath: () => string
    ) { }

    private get workspaceRoot(): string | undefined {
        return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    }

    /** Standalone boards in .claude/whiteboards/. */
    async listStandalone(): Promise<WhiteboardInfo[]> {
        if (!this.workspaceRoot) { return []; }
        return this.listIn(path.join(this.workspaceRoot, WHITEBOARDS_DIR));
    }

    /** Boards living inside a spec folder, which is what links them to it. */
    async listForSpec(specName: string): Promise<WhiteboardInfo[]> {
        if (!this.workspaceRoot) { return []; }
        const dir = path.join(this.workspaceRoot, this.getSpecBasePath(), specName);
        return (await this.listIn(dir)).map(b => ({ ...b, specName }));
    }

    private async listIn(dir: string): Promise<WhiteboardInfo[]> {
        try {
            const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
            return entries
                .filter(([name, type]) => type === vscode.FileType.File && name.endsWith('.excalidraw'))
                .map(([name]) => ({ name: name.replace(/\.excalidraw$/, ''), path: path.join(dir, name) }))
                .sort((a, b) => a.name.localeCompare(b.name));
        } catch {
            return []; // Directory absent is the normal empty case.
        }
    }

    /**
     * Creates an empty scene. Excalidraw rejects a zero-byte file, so a valid
     * empty document has to be written rather than just touching the path.
     */
    async create(name: string, specName?: string): Promise<vscode.Uri | undefined> {
        if (!this.workspaceRoot) {
            vscode.window.showErrorMessage('No workspace folder found');
            return undefined;
        }

        const dir = specName
            ? path.join(this.workspaceRoot, this.getSpecBasePath(), specName)
            : path.join(this.workspaceRoot, WHITEBOARDS_DIR);

        const safeName = name.trim().replace(/[^a-zA-Z0-9-_ ]/g, '').replace(/\s+/g, '-').toLowerCase();
        if (!safeName) {
            vscode.window.showErrorMessage('Whiteboard name must contain letters or numbers');
            return undefined;
        }

        const target = vscode.Uri.file(path.join(dir, `${safeName}.excalidraw`));
        try {
            await vscode.workspace.fs.stat(target);
            vscode.window.showWarningMessage(`Whiteboard "${safeName}" already exists.`);
            return target;
        } catch {
            // Does not exist yet, which is what we want.
        }

        const empty = {
            type: 'excalidraw',
            version: 2,
            source: 'kiro-for-cc',
            elements: [],
            appState: { gridSize: null, viewBackgroundColor: '#ffffff' },
            files: {}
        };

        await vscode.workspace.fs.createDirectory(vscode.Uri.file(dir));
        await vscode.workspace.fs.writeFile(target, Buffer.from(JSON.stringify(empty, null, 2), 'utf8'));
        this.outputChannel.appendLine(`[Whiteboard] Created ${target.fsPath}`);
        return target;
    }

    /** Every board in the workspace: standalone plus each spec's own. */
    async listAll(): Promise<WhiteboardInfo[]> {
        if (!this.workspaceRoot) { return []; }
        const boards = await this.listStandalone();

        const specsRoot = path.join(this.workspaceRoot, this.getSpecBasePath());
        try {
            const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(specsRoot));
            for (const [name, type] of entries) {
                if (type !== vscode.FileType.Directory) { continue; }
                boards.push(...await this.listForSpec(name));
            }
        } catch {
            // No specs directory yet.
        }
        return boards;
    }

    /**
     * Resolves `@board-name` references in free text.
     *
     * Mentions are matched against board names anywhere in the workspace, so a
     * whiteboard dropped into a spec folder can be referenced the same way as a
     * standalone one.
     */
    async resolveMentions(text: string): Promise<{ block: string; matched: string[]; unmatched: string[] }> {
        const mentions = [...text.matchAll(/@([A-Za-z0-9._-]+)/g)].map(m => m[1]);
        if (mentions.length === 0) {
            return { block: '', matched: [], unmatched: [] };
        }

        const all = await this.listAll();
        const matched: WhiteboardInfo[] = [];
        const unmatched: string[] = [];

        for (const mention of mentions) {
            const needle = mention.toLowerCase();
            // Exact first, then a unique prefix: "@test" should find "testing",
            // but never guess when two boards share that prefix.
            let hit = all.find(b => b.name.toLowerCase() === needle);
            if (!hit) {
                const prefixed = all.filter(b => b.name.toLowerCase().startsWith(needle));
                if (prefixed.length === 1) { hit = prefixed[0]; }
            }

            if (hit) {
                if (!matched.some(m => m.path === hit!.path)) { matched.push(hit); }
            } else {
                unmatched.push(mention);
            }
        }

        return {
            block: matched.length > 0 ? await this.compileForPrompt(matched) : '',
            matched: matched.map(b => b.name),
            unmatched
        };
    }

    async compile(boardPath: string): Promise<CompiledWhiteboard> {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(boardPath));
        return compileWhiteboard(Buffer.from(bytes).toString('utf8'));
    }

    /** The <whiteboard> block for a set of boards, or '' if none are usable. */
    async compileForPrompt(boards: WhiteboardInfo[]): Promise<string> {
        const compiled = [];
        for (const board of boards) {
            try {
                compiled.push({ name: board.name, compiled: await this.compile(board.path) });
            } catch (error) {
                this.outputChannel.appendLine(`[Whiteboard] Failed to compile ${board.path}: ${error}`);
            }
        }
        return formatForPrompt(compiled);
    }

    /**
     * Opens a board, preferring the Excalidraw custom editor.
     *
     * Detection never gates the open. Presence checks by extension id are
     * unreliable -- profiles, per-workspace disabling and editor forks all make
     * `getExtension` disagree with what is actually registered -- so the board
     * is opened first and the install hint is only ever a follow-up.
     */
    async open(boardPath: string): Promise<void> {
        const uri = vscode.Uri.file(boardPath);

        // Ask for the custom editor by view type: this tests the capability
        // that matters rather than a name that might not match.
        try {
            await vscode.commands.executeCommand('vscode.openWith', uri, EXCALIDRAW_VIEW_TYPE);
            return;
        } catch (error) {
            this.outputChannel.appendLine(
                `[Whiteboard] openWith(${EXCALIDRAW_VIEW_TYPE}) failed: ${error}`
            );
        }

        // Excalidraw registers itself as the default editor for *.excalidraw, so
        // a plain open still lands there when it is available.
        try {
            await vscode.commands.executeCommand('vscode.open', uri);
        } catch (error) {
            this.outputChannel.appendLine(`[Whiteboard] open failed: ${error}`);
            vscode.window.showErrorMessage(`Could not open ${path.basename(boardPath)}: ${error}`);
            return;
        }

        // The board is already open by now; this is only a suggestion.
        if (!vscode.extensions.getExtension(EXCALIDRAW_EXTENSION_ID)) {
            this.outputChannel.appendLine(
                `[Whiteboard] ${EXCALIDRAW_EXTENSION_ID} not reported as installed`
            );
            const install = 'Install Excalidraw';
            const choice = await vscode.window.showInformationMessage(
                'Opened as JSON. Install the Excalidraw editor to edit this whiteboard visually.',
                install
            );
            if (choice === install) {
                await vscode.commands.executeCommand(
                    'workbench.extensions.installExtension',
                    EXCALIDRAW_EXTENSION_ID
                );
            }
        }
    }
}
