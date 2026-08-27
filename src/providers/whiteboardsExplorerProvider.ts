import * as vscode from 'vscode';
import * as path from 'path';
import { WhiteboardManager, WhiteboardInfo, WHITEBOARDS_DIR } from '../features/whiteboard/whiteboardManager';

export class WhiteboardsExplorerProvider implements vscode.TreeDataProvider<WhiteboardItem>, vscode.Disposable {
    private _onDidChangeTreeData = new vscode.EventEmitter<WhiteboardItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private watcher: vscode.FileSystemWatcher | undefined;

    constructor(private manager: WhiteboardManager) {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (folder) {
            // Boards live either in .claude/whiteboards or inside a spec folder,
            // so watch the whole .claude tree for scene files.
            this.watcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(folder, '.claude/**/*.excalidraw')
            );
            this.watcher.onDidCreate(() => this.refresh());
            this.watcher.onDidDelete(() => this.refresh());
        }
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: WhiteboardItem): vscode.TreeItem {
        return element;
    }

    async getChildren(): Promise<WhiteboardItem[]> {
        if (!vscode.workspace.workspaceFolders) { return []; }
        const boards = await this.manager.listStandalone();
        return boards.map(b => new WhiteboardItem(b));
    }

    dispose(): void {
        this.watcher?.dispose();
        this._onDidChangeTreeData.dispose();
    }
}

export class WhiteboardItem extends vscode.TreeItem {
    constructor(public readonly board: WhiteboardInfo) {
        super(board.name, vscode.TreeItemCollapsibleState.None);
        this.contextValue = 'kfc-whiteboard';
        this.iconPath = new vscode.ThemeIcon('symbol-color');
        this.resourceUri = vscode.Uri.file(board.path);
        this.tooltip = board.specName
            ? `Whiteboard for spec "${board.specName}"`
            : `Standalone whiteboard · ${path.join(WHITEBOARDS_DIR, board.name)}.excalidraw`;
        this.command = {
            command: 'kfc.whiteboard.open',
            title: 'Open Whiteboard',
            arguments: [board]
        };
    }
}
