import * as vscode from 'vscode';
import { DraftManager, DraftRecord } from '../features/draft/draftManager';

export class DraftsExplorerProvider implements vscode.TreeDataProvider<DraftItem>, vscode.Disposable {
    private _onDidChangeTreeData = new vscode.EventEmitter<DraftItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private manager: DraftManager) { }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: DraftItem): vscode.TreeItem {
        return element;
    }

    async getChildren(): Promise<DraftItem[]> {
        if (!vscode.workspace.workspaceFolders) { return []; }
        const drafts = await this.manager.list();
        return drafts.map(d => new DraftItem(d));
    }

    dispose(): void {
        this._onDidChangeTreeData.dispose();
    }
}

export class DraftItem extends vscode.TreeItem {
    constructor(public readonly draft: DraftRecord) {
        super(draft.request, vscode.TreeItemCollapsibleState.None);
        this.contextValue = 'kfc-draft';
        this.iconPath = new vscode.ThemeIcon('edit');
        this.description = relativeTime(draft.createdAt);
        this.tooltip = new vscode.MarkdownString([
            `**${draft.request}**`,
            '',
            `- Started: ${new Date(draft.createdAt).toLocaleString()}`,
            `- Session: \`${draft.sessionId}\``,
            '',
            '_Click to resume this conversation._'
        ].join('\n'));
        this.command = {
            command: 'kfc.draft.resume',
            title: 'Resume Draft',
            arguments: [draft]
        };
    }
}

function relativeTime(timestamp: number): string {
    const minutes = Math.floor((Date.now() - timestamp) / 60000);
    if (minutes < 1) { return 'just now'; }
    if (minutes < 60) { return `${minutes}m ago`; }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) { return `${hours}h ago`; }
    return `${Math.floor(hours / 24)}d ago`;
}
