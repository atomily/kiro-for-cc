import * as vscode from 'vscode';
import * as path from 'path';
import { ClaudeCodeProvider } from '../../providers/claudeCodeProvider';
import { PromptLoader } from '../../services/promptLoader';
import { WhiteboardManager } from '../whiteboard/whiteboardManager';

export const DRAFTS_FILE = '.claude/drafts/drafts.json';

export interface DraftRecord {
    /** Claude session id, pinned at launch so the draft can be resumed. */
    sessionId: string;
    request: string;
    createdAt: number;
}

/**
 * Drafts are one-off throwaway sessions: no spec, no documents, no gates.
 *
 * The only thing kept is the session id, which makes `claude --resume` work --
 * so a draft you ran days ago is still a live conversation you can pick back up.
 */
export class DraftManager {
    private promptLoader = PromptLoader.getInstance();

    constructor(
        private claudeProvider: ClaudeCodeProvider,
        private outputChannel: vscode.OutputChannel,
        private whiteboards: WhiteboardManager
    ) { }

    private get recordsUri(): vscode.Uri | undefined {
        const root = vscode.workspace.workspaceFolders?.[0];
        return root ? vscode.Uri.file(path.join(root.uri.fsPath, DRAFTS_FILE)) : undefined;
    }

    async list(): Promise<DraftRecord[]> {
        const uri = this.recordsUri;
        if (!uri) { return []; }
        try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            const parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return []; // No drafts yet.
        }
    }

    private async save(records: DraftRecord[]): Promise<void> {
        const uri = this.recordsUri;
        if (!uri) { return; }
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)));
        await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(records, null, 2), 'utf8'));
    }

    /**
     * `whiteboardBlock` is supplied when the draft was started from a board;
     * otherwise any @mentions in the request are resolved instead.
     */
    async create(whiteboardBlock: string = ''): Promise<boolean> {
        const request = await vscode.window.showInputBox({
            title: whiteboardBlock ? '📝 Draft from Whiteboard' : '📝 New Draft',
            prompt: 'One-off work - no spec, no approval gates, just does it',
            placeHolder: whiteboardBlock
                ? 'What should I build from this whiteboard?'
                : 'e.g. Setup a t3 stack with Drizzle (reference a whiteboard with @name)',
            ignoreFocusOut: false
        });
        if (!request) { return false; }

        const root = vscode.workspace.workspaceFolders?.[0];
        if (!root) {
            vscode.window.showErrorMessage('No workspace folder open');
            return false;
        }

        let block = whiteboardBlock;
        let matched: string[] = [];
        let unmatched: string[] = [];
        if (!block) {
            ({ block, matched, unmatched } = await this.whiteboards.resolveMentions(request));
        }
        if (unmatched.length > 0) {
            vscode.window.showWarningMessage(
                `No whiteboard named ${unmatched.map(u => `@${u}`).join(', ')}. Continuing without it.`
            );
        }
        if (matched.length > 0) {
            this.outputChannel.appendLine(`[Draft] Included whiteboards: ${matched.join(', ')}`);
        }

        const prompt = this.promptLoader.renderPrompt('create-draft', {
            request,
            workspacePath: root.uri.fsPath,
            whiteboard: block
        });

        // Drafts deliberately do not take the workspace model/effort overrides:
        // they are short, so they inherit the user's own Claude Code settings
        // unless a draft-specific override is configured.
        const config = vscode.workspace.getConfiguration('kfc');
        const { terminal, sessionId } = await this.claudeProvider.invokeClaudeSession(prompt, {
            title: `Draft: ${request.slice(0, 30)}`,
            model: config.get<string>('drafts.model', ''),
            effort: config.get<string>('drafts.effort', '')
        });
        terminal.show();

        const records = await this.list();
        records.unshift({ sessionId, request, createdAt: Date.now() });
        await this.save(records);
        this.outputChannel.appendLine(`[Draft] Started ${sessionId}: ${request}`);
        return true;
    }

    /** Reopens a past draft with `claude --resume <sessionId>`. */
    async resume(draft: DraftRecord): Promise<void> {
        const { terminal } = await this.claudeProvider.invokeClaudeSession('', {
            title: `Draft: ${draft.request.slice(0, 30)}`,
            resumeSessionId: draft.sessionId
        });
        terminal.show();
    }

    async delete(draft: DraftRecord): Promise<void> {
        const records = (await this.list()).filter(r => r.sessionId !== draft.sessionId);
        await this.save(records);
        // The Claude session itself is left alone; only Kiro's pointer is removed.
    }
}
