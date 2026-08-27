import * as vscode from 'vscode';
import * as path from 'path';
import { SpecManager } from '../features/spec/specManager';
import { WhiteboardManager } from '../features/whiteboard/whiteboardManager';

export class SpecExplorerProvider implements vscode.TreeDataProvider<SpecItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<SpecItem | undefined | null | void> = new vscode.EventEmitter<SpecItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<SpecItem | undefined | null | void> = this._onDidChangeTreeData.event;
    
    private specManager!: SpecManager;
    private outputChannel: vscode.OutputChannel;
    private isLoading: boolean = false;
    
    constructor(private context: vscode.ExtensionContext, outputChannel: vscode.OutputChannel) {
        // We'll set the spec manager later from extension.ts
        this.outputChannel = outputChannel;
    }
    
    setSpecManager(specManager: SpecManager) {
        this.specManager = specManager;
    }

    private whiteboardManager?: WhiteboardManager;

    setWhiteboardManager(whiteboardManager: WhiteboardManager) {
        this.whiteboardManager = whiteboardManager;
    }
    
    refresh(): void {
        this.isLoading = true;
        this._onDidChangeTreeData.fire(); // Show loading state immediately
        
        // Simulate async loading
        setTimeout(() => {
            this.isLoading = false;
            this._onDidChangeTreeData.fire(); // Show actual content
        }, 100);
    }
    
    getTreeItem(element: SpecItem): vscode.TreeItem {
        return element;
    }

    /**
     * A spec node carrying its task progress.
     *
     * Finished and archived specs start collapsed: the reason to expand a spec
     * is to act on it, and neither of those is waiting on you.
     */
    private async buildSpecItem(specName: string, isArchived: boolean): Promise<SpecItem> {
        const progress = await this.specManager.getTaskProgress(specName);
        const complete = progress !== undefined && progress.done === progress.total;

        return new SpecItem(
            specName,
            isArchived || complete
                ? vscode.TreeItemCollapsibleState.Collapsed
                : vscode.TreeItemCollapsibleState.Expanded,
            isArchived ? 'spec-archived' : 'spec',
            this.context,
            specName,
            undefined,
            undefined,
            undefined,
            progress
        );
    }
    
    async getChildren(element?: SpecItem): Promise<SpecItem[]> {
        
        if (!vscode.workspace.workspaceFolders || !this.specManager) {
            return [];
        }
        
        if (!element) {
            // Root level - show loading state or specs
            const items: SpecItem[] = [];
            
            if (this.isLoading) {
                // Show loading state
                items.push(new SpecItem(
                    'Loading specs...',
                    vscode.TreeItemCollapsibleState.None,
                    'spec-loading',
                    this.context
                ));
                return items;
            }
            
            // Active specs first; archived ones collapse into a single group.
            const specs = await this.specManager.getSpecList();
            const archived = new Set(await this.specManager.listArchived());

            const active = specs.filter(name => !archived.has(name));
            for (const name of active) {
                items.push(await this.buildSpecItem(name, false));
            }

            const archivedSpecs = specs.filter(name => archived.has(name));
            if (archivedSpecs.length > 0) {
                items.push(new SpecItem(
                    `Archived (${archivedSpecs.length})`,
                    vscode.TreeItemCollapsibleState.Collapsed,
                    'spec-archive-group',
                    this.context
                ));
            }

            return items;
        } else if (element.contextValue === 'spec-archive-group') {
            const specs = await this.specManager.getSpecList();
            const archived = new Set(await this.specManager.listArchived());
            const items: SpecItem[] = [];
            for (const name of specs.filter(n => archived.has(n))) {
                items.push(await this.buildSpecItem(name, true));
            }
            return items;
        } else if (element.contextValue === 'spec' || element.contextValue === 'spec-archived') {
            // Show spec documents
            const specsPath = await this.specManager.getSpecBasePath();
            const specPath = `${specsPath}/${element.specName}`;
            
            const documents: SpecItem[] = [
                new SpecItem(
                    'requirements',
                    vscode.TreeItemCollapsibleState.None,
                    'spec-document',
                    this.context,
                    element.specName!,
                    'requirements',
                    {
                        command: 'kfc.spec.navigate.requirements',
                        title: 'Open Requirements',
                        arguments: [element.specName]
                    },
                    `${specPath}/requirements.md`
                ),
                new SpecItem(
                    'design',
                    vscode.TreeItemCollapsibleState.None,
                    'spec-document',
                    this.context,
                    element.specName!,
                    'design',
                    {
                        command: 'kfc.spec.navigate.design',
                        title: 'Open Design',
                        arguments: [element.specName]
                    },
                    `${specPath}/design.md`
                ),
                new SpecItem(
                    'tasks',
                    vscode.TreeItemCollapsibleState.None,
                    'spec-document',
                    this.context,
                    element.specName!,
                    'tasks',
                    {
                        command: 'kfc.spec.navigate.tasks',
                        title: 'Open Tasks',
                        arguments: [element.specName]
                    },
                    `${specPath}/tasks.md`
                )
            ];

            // Any .excalidraw dropped into the spec folder shows up here. Living
            // in the folder is what links it -- there is no link syntax.
            const boards = await this.whiteboardManager?.listForSpec(element.specName!) ?? [];
            for (const board of boards) {
                documents.push(new SpecItem(
                    board.name,
                    vscode.TreeItemCollapsibleState.None,
                    'spec-whiteboard',
                    this.context,
                    element.specName!,
                    'whiteboard',
                    {
                        command: 'kfc.whiteboard.open',
                        title: 'Open Whiteboard',
                        arguments: [board]
                    },
                    board.path
                ));
            }

            return documents;
        }
        
        return [];
    }
}

class SpecItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly contextValue: string,
        private readonly context: vscode.ExtensionContext,
        public readonly specName?: string,
        public readonly documentType?: string,
        public readonly command?: vscode.Command,
        private readonly filePath?: string,
        private readonly progress?: { done: number; total: number }
    ) {
        super(label, collapsibleState);
        
        if (contextValue === 'spec-loading') {
            this.iconPath = new vscode.ThemeIcon('sync~spin');
            this.tooltip = 'Loading specs...';
        } else if (contextValue === 'spec-archive-group') {
            this.iconPath = new vscode.ThemeIcon('archive');
            this.tooltip = 'Archived specs - hidden from the active list, files untouched';
        } else if (contextValue === 'spec' || contextValue === 'spec-archived') {
            const complete = progress !== undefined && progress.done === progress.total;

            if (contextValue === 'spec-archived') {
                this.iconPath = new vscode.ThemeIcon('archive', new vscode.ThemeColor('descriptionForeground'));
            } else if (complete) {
                this.iconPath = new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green'));
            } else {
                this.iconPath = new vscode.ThemeIcon('package');
            }

            if (progress) {
                this.description = `${progress.done}/${progress.total}`;
            }
            this.tooltip = [
                `Spec: ${label}`,
                progress ? `Tasks: ${progress.done} of ${progress.total} complete` : 'No tasks yet',
                contextValue === 'spec-archived' ? 'Archived' : ''
            ].filter(Boolean).join('\n');
        } else if (contextValue === 'spec-whiteboard') {
            this.iconPath = new vscode.ThemeIcon('symbol-color');
            this.tooltip = `Whiteboard: ${specName}/${label}`;
        } else if (contextValue === 'spec-document') {
            // Different icons for different document types
            if (documentType === 'requirements') {
                this.iconPath = new vscode.ThemeIcon('chip');
                this.tooltip = `Requirements: ${specName}/${label}`;
            } else if (documentType === 'design') {
                this.iconPath = new vscode.ThemeIcon('layers');
                this.tooltip = `Design: ${specName}/${label}`;
            } else if (documentType === 'tasks') {
                this.iconPath = new vscode.ThemeIcon('tasklist');
                this.tooltip = `Tasks: ${specName}/${label}`;
            } else {
                this.iconPath = new vscode.ThemeIcon('file');
                this.tooltip = `${documentType}: ${specName}/${label}`;
            }
            
            // Set description to file path
            if (filePath) {
                this.description = filePath;
            }
            
            // Add context menu items
            if (documentType === 'requirements' || documentType === 'design' || documentType === 'tasks') {
                this.contextValue = `spec-document-${documentType}`;
            }
        }
    }
}