import * as vscode from 'vscode';
import * as path from 'path';
import { ClaudeCodeProvider } from '../../providers/claudeCodeProvider';
import { ConfigManager } from '../../utils/configManager';
import { NotificationUtils } from '../../utils/notificationUtils';
import { PromptLoader } from '../../services/promptLoader';

export type SpecDocumentType = 'requirements' | 'design' | 'tasks';

/** Structural type so SpecManager does not depend on the whiteboard feature. */
export interface WhiteboardMentionResolver {
    resolveMentions(text: string): Promise<{ block: string; matched: string[]; unmatched: string[] }>;
}

export class SpecManager {
    private configManager: ConfigManager;
    private promptLoader: PromptLoader;

    constructor(
        private claudeProvider: ClaudeCodeProvider,
        private outputChannel: vscode.OutputChannel
    ) {
        this.configManager = ConfigManager.getInstance();
        this.configManager.loadSettings();
        this.promptLoader = PromptLoader.getInstance();
    }

    public async getSpecBasePath(): Promise<string> {
        await this.configManager.loadSettings();
        return this.configManager.getPath('specs');
    }

    async create() {
        // Get feature description only
        const description = await vscode.window.showInputBox({
            title: '✨ Create New Spec ✨',
            prompt: 'Specs are a structured way to build features so you can plan before building',
            placeHolder: 'Enter your idea to generate requirement, design, and task specs...',
            ignoreFocusOut: false
        });

        if (!description) {
            return;
        }

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('No workspace folder open');
            return;
        }

        // Show notification immediately after user input
        NotificationUtils.showAutoDismissNotification('Claude is creating your spec. Check the terminal for progress.');

        // Let Claude handle everything - directory creation, naming, and file creation
        // Load and render the spec creation prompt
        const specBasePath = await this.getSpecBasePath();
        const prompt = this.promptLoader.renderPrompt('create-spec', {
            description,
            workspacePath: workspaceFolder.uri.fsPath,
            specBasePath
        });

        // Send to Claude and get the terminal
        const terminal = await this.claudeProvider.invokeClaudeSplitView(prompt, 'KFC - Creating Spec');

        // Set up automatic terminal renaming when spec folder is created
        this.setupSpecFolderWatcher(workspaceFolder, terminal).catch(error => {
            this.outputChannel.appendLine(`[SpecManager] Failed to set up watcher: ${error}`);
        });
    }

    /**
     * Quick spec: one pass, one approval gate, no judge tree.
     *
     * `whiteboardBlock` is the compiled <whiteboard> section when the spec was
     * started from a drawing; an empty string renders to nothing in the prompt.
     */
    /** Set after construction; whiteboards are created later in activation. */
    private whiteboards?: WhiteboardMentionResolver;

    setWhiteboardManager(whiteboards: WhiteboardMentionResolver) {
        this.whiteboards = whiteboards;
    }

    async createQuick(whiteboardBlock: string = '', whiteboardPaths: string[] = []) {
        const description = await vscode.window.showInputBox({
            title: whiteboardBlock ? '⚡ Quick Spec from Whiteboard ⚡' : '⚡ Create Quick Spec ⚡',
            prompt: 'For changes you already understand - one document, one approval, straight to tasks',
            placeHolder: whiteboardBlock
                ? 'What should be built from this whiteboard?'
                : 'Describe the change (reference a whiteboard with @name)...',
            ignoreFocusOut: false
        });

        if (!description) {
            return;
        }

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('No workspace folder open');
            return;
        }

        // An explicit block (started from the Whiteboards view) wins; otherwise
        // pick up any @mentions typed into the description.
        let block = whiteboardBlock;
        if (!block && this.whiteboards) {
            const resolved = await this.whiteboards.resolveMentions(description);
            block = resolved.block;
            if (resolved.unmatched.length > 0) {
                vscode.window.showWarningMessage(
                    `No whiteboard named ${resolved.unmatched.map(u => `@${u}`).join(', ')}. Continuing without it.`
                );
            }
        }

        NotificationUtils.showAutoDismissNotification('Claude is creating your quick spec. Check the terminal for progress.');

        const specBasePath = await this.getSpecBasePath();
        const prompt = this.promptLoader.renderPrompt('create-spec-quick', {
            description,
            workspacePath: workspaceFolder.uri.fsPath,
            specBasePath,
            whiteboard: block,
            whiteboardPaths: whiteboardPaths.join('\n')
        });

        const terminal = await this.claudeProvider.invokeClaudeSplitView(prompt, 'KFC - Quick Spec');

        this.setupSpecFolderWatcher(workspaceFolder, terminal).catch(error => {
            this.outputChannel.appendLine(`[SpecManager] Failed to set up watcher: ${error}`);
        });
    }

    async createWithAgents() {
        // Get feature description only
        const description = await vscode.window.showInputBox({
            title: '✨ Create New Spec with Agents ✨',
            prompt: 'This will use specialized subagents for creating requirements, design, and tasks',
            placeHolder: 'Enter your idea to generate requirement, design, and task specs...',
            ignoreFocusOut: false
        });

        if (!description) {
            return;
        }

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('No workspace folder open');
            return;
        }

        // Show notification immediately after user input
        NotificationUtils.showAutoDismissNotification('Claude is creating your spec with specialized agents. Check the terminal for progress.');

        // Use the specialized subagent prompt
        const specBasePath = await this.getSpecBasePath();
        const prompt = this.promptLoader.renderPrompt('create-spec-with-agents', {
            description,
            workspacePath: workspaceFolder.uri.fsPath,
            specBasePath
        });

        // Send to Claude and get the terminal
        const terminal = await this.claudeProvider.invokeClaudeSplitView(prompt, 'KFC - Creating Spec (Agents)');

        // Set up automatic terminal renaming when spec folder is created
        this.setupSpecFolderWatcher(workspaceFolder, terminal).catch(error => {
            this.outputChannel.appendLine(`[SpecManager] Failed to set up watcher: ${error}`);
        });
    }

    async implTask(taskFilePath: string, taskDescription: string) {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('No workspace folder open');
            return;
        }

        // Show notification immediately after user input
        NotificationUtils.showAutoDismissNotification('Claude is implementing your task. Check the terminal for progress.');

        const prompt = this.promptLoader.renderPrompt('impl-task', {
            taskFilePath,
            taskDescription
        });

        await this.claudeProvider.invokeClaudeSplitView(prompt, 'KFC - Implementing Task');
    }

    /**
     * Set up a file system watcher to automatically rename the terminal 
     * when a new spec folder is created
     */
    private async setupSpecFolderWatcher(workspaceFolder: vscode.WorkspaceFolder, terminal: vscode.Terminal): Promise<void> {
        // Create watcher for new folders in the specs directory
        const specBasePath = await this.getSpecBasePath();
        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(workspaceFolder, `${specBasePath}/*`),
            false, // Watch for creates
            true,  // Ignore changes
            true   // Ignore deletes
        );

        let disposed = false;

        // Handle folder creation
        const disposable = watcher.onDidCreate(async (uri) => {
            if (disposed) return;

            // Validate it's a directory
            try {
                const stats = await vscode.workspace.fs.stat(uri);
                if (stats.type !== vscode.FileType.Directory) {
                    this.outputChannel.appendLine(`[SpecManager] Skipping non-directory: ${uri.fsPath}`);
                    return;
                }
            } catch (error) {
                this.outputChannel.appendLine(`[SpecManager] Error checking path: ${error}`);
                return;
            }

            const specName = path.basename(uri.fsPath);
            this.outputChannel.appendLine(`[SpecManager] New spec detected: ${specName}`);
            try {
                await this.claudeProvider.renameTerminal(terminal, `Spec: ${specName}`);
            } catch (error) {
                this.outputChannel.appendLine(`[SpecManager] Failed to rename terminal: ${error}`);
            }

            // Clean up after successful rename
            this.disposeWatcher(disposable, watcher);
            disposed = true;
        });

        // Auto-cleanup after timeout
        setTimeout(() => {
            if (!disposed) {
                this.outputChannel.appendLine(`[SpecManager] Watcher timeout - cleaning up`);
                this.disposeWatcher(disposable, watcher);
                disposed = true;
            }
        }, 60000); // 60 seconds timeout
    }

    /**
     * Dispose watcher and its event handler
     */
    private disposeWatcher(disposable: vscode.Disposable, watcher: vscode.FileSystemWatcher): void {
        disposable.dispose();
        watcher.dispose();
        this.outputChannel.appendLine(`[SpecManager] Watcher disposed`);
    }

    async navigateToDocument(specName: string, type: SpecDocumentType) {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return;
        }

        const specBasePath = await this.getSpecBasePath();
        const docPath = path.join(
            workspaceFolder.uri.fsPath,
            specBasePath,
            specName,
            `${type}.md`
        );

        try {
            const doc = await vscode.workspace.openTextDocument(docPath);
            await vscode.window.showTextDocument(doc);
        } catch (error) {
            // File doesn't exist, look for already open virtual documents
            // Create unique identifier for this spec document
            const uniqueMarker = `<!-- kiro-spec: ${specName}/${type} -->`;

            for (const doc of vscode.workspace.textDocuments) {
                // Check if this is an untitled document with our unique marker
                if (doc.isUntitled && doc.getText().includes(uniqueMarker)) {
                    // Found our specific virtual document, show it
                    await vscode.window.showTextDocument(doc, {
                        preview: false,
                        viewColumn: vscode.ViewColumn.Active
                    });
                    return;
                }
            }

            // No existing virtual document found, create a new one
            let placeholderContent = `${uniqueMarker}
# ${type.charAt(0).toUpperCase() + type.slice(1)} Document

This document has not been created yet.`;

            if (type === 'design') {
                placeholderContent += '\n\nPlease approve the requirements document first.';
            } else if (type === 'tasks') {
                placeholderContent += '\n\nPlease approve the design document first.';
            } else if (type === 'requirements') {
                placeholderContent += '\n\nRun "Create New Spec" to generate this document.';
            }

            // Create a new untitled document
            const doc = await vscode.workspace.openTextDocument({
                content: placeholderContent,
                language: 'markdown'
            });

            // Show it
            await vscode.window.showTextDocument(doc, {
                preview: false,
                viewColumn: vscode.ViewColumn.Active
            });
        }
    }

    async delete(specName: string): Promise<void> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('No workspace folder open');
            return;
        }

        const specBasePath = await this.getSpecBasePath();
        const specPath = path.join(
            workspaceFolder.uri.fsPath,
            specBasePath,
            specName
        );

        try {
            await vscode.workspace.fs.delete(vscode.Uri.file(specPath), { recursive: true });
            await NotificationUtils.showAutoDismissNotification(`Spec "${specName}" deleted successfully`);
        } catch (error) {
            this.outputChannel.appendLine(`[SpecManager] Failed to delete spec: ${error}`);
            vscode.window.showErrorMessage(`Failed to delete spec: ${error}`);
        }
    }

    /**
     * Completion counted from the checkboxes in tasks.md.
     *
     * Derived rather than stored: tasks.md is already the record of what is
     * done, so a separate "complete" flag could only ever disagree with it.
     * Returns undefined when there is no tasks.md or it has no checkboxes.
     */
    async getTaskProgress(specName: string): Promise<{ done: number; total: number } | undefined> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) { return undefined; }

        const specBasePath = await this.getSpecBasePath();
        const tasksPath = path.join(workspaceFolder.uri.fsPath, specBasePath, specName, 'tasks.md');

        let content: string;
        try {
            const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(tasksPath));
            content = Buffer.from(bytes).toString('utf8');
        } catch {
            return undefined; // Spec has not reached the task stage yet.
        }

        const boxes = content.match(/^\s*[-*]\s+\[[ xX]\]/gm);
        if (!boxes || boxes.length === 0) { return undefined; }

        const done = boxes.filter(b => /\[[xX]\]/.test(b)).length;
        return { done, total: boxes.length };
    }

    private async archiveFileUri(): Promise<vscode.Uri | undefined> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) { return undefined; }
        const specBasePath = await this.getSpecBasePath();
        // Lives beside the specs. getSpecList only returns directories, so a
        // file here is never mistaken for a spec.
        return vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, specBasePath, '.kfc-archive.json'));
    }

    async listArchived(): Promise<string[]> {
        const uri = await this.archiveFileUri();
        if (!uri) { return []; }
        try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            const parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }

    /**
     * Archiving only hides a spec from the active list. The folder is never
     * moved or deleted, so nothing that references those paths can break.
     */
    async setArchived(specName: string, archived: boolean): Promise<void> {
        const uri = await this.archiveFileUri();
        if (!uri) { return; }

        const current = new Set(await this.listArchived());
        if (archived) {
            current.add(specName);
        } else {
            current.delete(specName);
        }

        await vscode.workspace.fs.writeFile(
            uri,
            Buffer.from(JSON.stringify([...current].sort(), null, 2), 'utf8')
        );
        this.outputChannel.appendLine(`[SpecManager] ${archived ? 'Archived' : 'Restored'} spec: ${specName}`);
    }

    async getSpecList(): Promise<string[]> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return [];
        }

        const specBasePath = await this.getSpecBasePath();
        const specsPath = path.join(workspaceFolder.uri.fsPath, specBasePath);

        // Check if directory exists first before creating
        try {
            await vscode.workspace.fs.stat(vscode.Uri.file(specsPath));
        } catch {
            // Directory doesn't exist, create it
            try {
                this.outputChannel.appendLine(`[SpecManager] Creating ${specBasePath} directory`);
                await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(specsPath)));
                await vscode.workspace.fs.createDirectory(vscode.Uri.file(specsPath));
            } catch {
                // Ignore errors
            }
        }

        try {
            const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(specsPath));
            return entries
                .filter(([, type]) => type === vscode.FileType.Directory)
                .map(([name]) => name);
        } catch (error) {
            // Directory doesn't exist yet
            return [];
        }
    }
}
