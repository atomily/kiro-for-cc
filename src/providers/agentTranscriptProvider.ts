import * as vscode from 'vscode';
import * as fs from 'fs';
import { SubagentInfo } from '../features/sessions/sessionMonitor';

export const AGENT_TRANSCRIPT_SCHEME = 'kfc-agent';

const MAX_BLOCK_CHARS = 1500;

/**
 * Renders a subagent's append-only JSONL transcript as read-only markdown.
 *
 * A virtual document rather than a webview on purpose: it inherits VS Code's
 * preview-tab behaviour, so clicking a different agent in the tree REPLACES the
 * tab instead of stacking a new one, and find/scroll/selection all work for free.
 */
export class AgentTranscriptProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
    private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChange = this._onDidChange.event;

    /** Transcript path -> fs watcher, for documents currently open. */
    private watchers = new Map<string, fs.FSWatcher>();
    private disposables: vscode.Disposable[] = [];

    constructor(private outputChannel: vscode.OutputChannel) {
        this.disposables.push(
            vscode.workspace.onDidCloseTextDocument(doc => {
                if (doc.uri.scheme === AGENT_TRANSCRIPT_SCHEME) {
                    this.unwatch(AgentTranscriptProvider.transcriptPathOf(doc.uri));
                }
            })
        );
    }

    /**
     * Builds the URI for an agent. The path drives the tab label, so it carries
     * the human-readable description; the transcript path rides in the query so
     * two agents with identical descriptions stay distinct documents.
     */
    static uriFor(agent: SubagentInfo): vscode.Uri {
        const label = agent.description.replace(/[\\/:*?"<>|]/g, '-').slice(0, 60);
        return vscode.Uri.parse(
            `${AGENT_TRANSCRIPT_SCHEME}:/${label} (${agent.agentType}).md` +
            `?path=${encodeURIComponent(agent.transcriptPath)}`
        );
    }

    private static transcriptPathOf(uri: vscode.Uri): string {
        const match = /(?:^|&)path=([^&]*)/.exec(uri.query);
        return match ? decodeURIComponent(match[1]) : '';
    }

    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        const transcriptPath = AgentTranscriptProvider.transcriptPathOf(uri);
        if (!transcriptPath) {
            return '_No transcript path in URI._';
        }

        this.watch(transcriptPath, uri);

        let raw: string;
        try {
            raw = await fs.promises.readFile(transcriptPath, 'utf8');
        } catch (error) {
            return `_Transcript not readable yet._\n\n\`${transcriptPath}\`\n\n${error}`;
        }

        return this.render(raw, transcriptPath);
    }

    private render(raw: string, transcriptPath: string): string {
        const out: string[] = [];
        let firstPrompt = true;

        for (const line of raw.split('\n')) {
            if (!line.trim()) { continue; }

            let entry: any;
            try {
                entry = JSON.parse(line);
            } catch {
                continue; // Trailing partial line while the agent is still writing.
            }

            const message = entry.message;
            if (!message) { continue; }

            if (entry.type === 'user') {
                const content = message.content;
                if (typeof content === 'string') {
                    // The very first user entry is the task prompt from the parent.
                    out.push(firstPrompt ? '## Prompt\n' : '## Follow-up\n');
                    out.push(truncate(content, MAX_BLOCK_CHARS * 2), '');
                    firstPrompt = false;
                } else if (Array.isArray(content)) {
                    for (const block of content) {
                        if (block?.type === 'tool_result') {
                            out.push(renderToolResult(block), '');
                        }
                    }
                }
            } else if (entry.type === 'assistant') {
                for (const block of message.content ?? []) {
                    if (block?.type === 'text' && block.text?.trim()) {
                        out.push(block.text.trim(), '');
                    } else if (block?.type === 'tool_use') {
                        out.push(renderToolUse(block), '');
                    }
                    // Thinking blocks are intentionally dropped: they are long and
                    // rarely what you open a transcript to read.
                }
            }
        }

        if (out.length === 0) {
            out.push('_Agent has not produced output yet._');
        }

        out.unshift(`<!-- ${transcriptPath} -->`, '');
        return out.join('\n');
    }

    private watch(transcriptPath: string, uri: vscode.Uri): void {
        if (this.watchers.has(transcriptPath)) { return; }
        try {
            // Coalesce the burst of writes an active agent produces.
            let pending: NodeJS.Timeout | undefined;
            const watcher = fs.watch(transcriptPath, () => {
                if (pending) { clearTimeout(pending); }
                pending = setTimeout(() => this._onDidChange.fire(uri), 250);
            });
            this.watchers.set(transcriptPath, watcher);
        } catch (error) {
            this.outputChannel.appendLine(`[AgentTranscript] Cannot watch ${transcriptPath}: ${error}`);
        }
    }

    private unwatch(transcriptPath: string): void {
        const watcher = this.watchers.get(transcriptPath);
        if (watcher) {
            watcher.close();
            this.watchers.delete(transcriptPath);
        }
    }

    dispose(): void {
        for (const watcher of this.watchers.values()) { watcher.close(); }
        this.watchers.clear();
        this.disposables.forEach(d => d.dispose());
        this._onDidChange.dispose();
    }
}

function renderToolUse(block: any): string {
    const input = block.input ?? {};
    const summary =
        input.file_path ?? input.path ?? input.command ?? input.pattern ??
        input.description ?? input.url ?? '';
    const head = `**\`${block.name}\`**` + (summary ? ` — \`${truncate(String(summary), 160)}\`` : '');
    return head;
}

function renderToolResult(block: any): string {
    const content = block.content;
    const text = typeof content === 'string'
        ? content
        : Array.isArray(content)
            ? content.map((c: any) => (typeof c === 'string' ? c : c?.text ?? '')).join('\n')
            : '';
    if (!text.trim()) { return '> _(empty result)_'; }
    const marker = block.is_error ? '> **error**\n' : '';
    return marker + '```\n' + truncate(text.trim(), MAX_BLOCK_CHARS) + '\n```';
}

function truncate(text: string, limit: number): string {
    if (text.length <= limit) { return text; }
    return `${text.slice(0, limit)}\n… (${text.length - limit} more characters)`;
}
