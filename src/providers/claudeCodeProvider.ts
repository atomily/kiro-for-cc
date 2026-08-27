import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
import { ConfigManager } from '../utils/configManager';
import { VSC_CONFIG_NAMESPACE } from '../constants';

/** How long to wait for shell integration before falling back to a timed send. */
const SHELL_READY_TIMEOUT_MS = 8000;

/** Where `claude` commonly lives, checked only if the login shell cannot find it. */
const CLAUDE_FALLBACK_PATHS = [
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    `${process.env.HOME}/.local/bin/claude`,
    `${process.env.HOME}/.claude/local/claude`,
    `${process.env.HOME}/.bun/bin/claude`
];

interface ResolvedClaude {
    /** Absolute path to the claude executable. */
    binary: string;
    /** PATH as the user's login shell sees it, for the spawned process. */
    path: string | undefined;
}

export class ClaudeCodeProvider {
    private context: vscode.ExtensionContext;
    private outputChannel: vscode.OutputChannel;
    private configManager: ConfigManager;

    /**
     * Claude session id -> the terminal running it.
     *
     * Populated because we pass `--session-id` when spawning, which is the only
     * way to know which terminal owns which session; VS Code exposes the shell
     * pid, not the pid of the `claude` process inside it. Sessions the user
     * started by hand are therefore listed but not focusable.
     */
    private sessionTerminals = new Map<string, vscode.Terminal>();

    /**
     * Ids of every session Kiro has launched in this workspace.
     *
     * Persisted separately from `sessionTerminals` because the terminal handle
     * dies with the window but the Claude session does not: after a reload a
     * session is still ours to list, just no longer ours to focus.
     */
    private static readonly LAUNCHED_KEY = 'kfc.launchedSessionIds';

    constructor(context: vscode.ExtensionContext, outputChannel: vscode.OutputChannel) {
        this.context = context;
        this.outputChannel = outputChannel;

        vscode.window.onDidCloseTerminal(closed => {
            for (const [sessionId, terminal] of this.sessionTerminals) {
                if (terminal === closed) {
                    this.sessionTerminals.delete(sessionId);
                }
            }
        });

        this.configManager = ConfigManager.getInstance();
        this.configManager.loadSettings();
        // Listen for configuration changes
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration(VSC_CONFIG_NAMESPACE)) {
                this.configManager.loadSettings();
            }
        });
    }

    /**
     * Create a temporary file with content
     */
    private async createTempFile(content: string, prefix: string = 'prompt'): Promise<string> {
        const tempDir = this.context.globalStorageUri.fsPath;
        await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);

        const tempFile = path.join(tempDir, `${prefix}-${Date.now()}.md`);
        await fs.promises.writeFile(tempFile, content);

        return this.convertPathIfWSL(tempFile);
    }



    /**
     * Convert Windows path to WSL path if needed
     * Example: C:\Users\username\file.txt -> /mnt/c/Users/username/file.txt
     */
    private convertPathIfWSL(filePath: string): string {
        // Check if running on Windows and path is a Windows path
        if (process.platform === 'win32' && filePath.match(/^[A-Za-z]:\\/)) {
            // Replace backslashes with forward slashes
            let wslPath = filePath.replace(/\\/g, '/');
            // Convert drive letter to WSL format (C: -> /mnt/c)
            wslPath = wslPath.replace(/^([A-Za-z]):/, (_match, drive) => `/mnt/${drive.toLowerCase()}`);
            return wslPath;
        }

        // Return original path if not on Windows or not a Windows path
        return filePath;
    }

    /**
     * Invokes Claude Code in a new terminal on the right side (split view) with the given prompt
     * Returns the terminal instance for potential renaming
     *
     * No permission-mode flag is passed: Claude Code applies its own settings
     * precedence (enterprise / CLI / local project / project / user) and prompts
     * the user directly for anything not already allowed.
     */
    async invokeClaudeSplitView(prompt: string, title: string = 'Kiro for Claude Code'): Promise<vscode.Terminal> {
        const { terminal } = await this.invokeClaudeSession(prompt, { title });
        return terminal;
    }

    /**
     * Launches a session and hands back the id it was pinned to, so callers that
     * need to reopen it later (`claude --resume <id>`) can store it.
     *
     * Passing `resumeSessionId` reopens an existing conversation instead of
     * starting one, and ignores `prompt` -- resume drops the user into the
     * interactive session where it left off.
     */
    async invokeClaudeSession(
        prompt: string,
        options: {
            title?: string;
            model?: string;
            effort?: string;
            resumeSessionId?: string;
        } = {}
    ): Promise<{ terminal: vscode.Terminal; sessionId: string }> {
        const title = options.title ?? 'Kiro for Claude Code';
        try {
            // Pin the session id up front so the Sessions view can map this
            // session back to the terminal that owns it, and so drafts can be
            // resumed later by id.
            const sessionId = options.resumeSessionId ?? randomUUID();
            const modelArgs = this.getModelArgs(options.model, options.effort);
            const claude = await this.resolveClaude();
            const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

            let terminal: vscode.Terminal;

            if (claude) {
                // Spawn the binary as the terminal's process. Nothing is typed
                // into a shell, so shell startup cannot race, truncate, or
                // swallow the command -- the failure mode that turns `claude`
                // into `laude` when an rc file prompts for input.
                const args = options.resumeSessionId
                    ? ['--resume', options.resumeSessionId, ...modelArgs]
                    : ['--session-id', sessionId, ...modelArgs, prompt];

                terminal = vscode.window.createTerminal({
                    name: title,
                    cwd,
                    location: { viewColumn: vscode.ViewColumn.Two },
                    shellPath: claude.binary,
                    shellArgs: args,
                    // claude shells out to git, editors and hooks, so it needs the
                    // PATH the user actually has, not the extension host's.
                    env: claude.path ? { PATH: claude.path } : undefined
                });

                this.sessionTerminals.set(sessionId, terminal);
                await this.rememberLaunchedSession(sessionId);
                terminal.show();
                this.outputChannel.appendLine(
                    `[ClaudeCodeProvider] Spawned ${claude.binary} (session ${sessionId})`
                );
            } else {
                // No binary found: fall back to typing into a shell.
                const flags = this.getModelFlags(options.model, options.effort);
                let command: string;
                let promptFilePath: string | undefined;

                if (options.resumeSessionId) {
                    command = `claude --resume ${options.resumeSessionId}${flags}`;
                } else {
                    promptFilePath = await this.createTempFile(prompt, 'prompt');
                    command = `claude --session-id ${sessionId}${flags} "$(cat "${promptFilePath}")"`;
                }

                terminal = vscode.window.createTerminal({
                    name: title,
                    cwd,
                    location: { viewColumn: vscode.ViewColumn.Two }
                });

                this.sessionTerminals.set(sessionId, terminal);
                await this.rememberLaunchedSession(sessionId);
                terminal.show();
                await this.runWhenReady(terminal, command);

                const cleanupPath = promptFilePath;
                setTimeout(async () => {
                    if (!cleanupPath) { return; }
                    try {
                        await fs.promises.unlink(cleanupPath);
                        this.outputChannel.appendLine(`Cleaned up prompt file: ${cleanupPath}`);
                    } catch (e) {
                        this.outputChannel.appendLine(`Failed to cleanup temp file: ${e}`);
                    }
                }, 30000);
            }

            // Return the terminal for potential renaming
            return { terminal, sessionId };

        } catch (error) {
            this.outputChannel.appendLine(`ERROR: Failed to send to Claude Code: ${error}`);
            vscode.window.showErrorMessage(`Failed to run Claude Code: ${error}`);
            throw error;
        }
    }

    private resolved: Promise<ResolvedClaude | undefined> | undefined;

    /**
     * Locates the claude executable so it can be spawned directly.
     *
     * Resolution runs through the user's login shell because that is where
     * version managers put things on PATH; the extension host's own PATH is
     * frequently missing them. Cached: this shells out once per window.
     */
    private resolveClaude(): Promise<ResolvedClaude | undefined> {
        this.resolved ??= this.doResolveClaude();
        return this.resolved;
    }

    private async doResolveClaude(): Promise<ResolvedClaude | undefined> {
        const configured = vscode.workspace
            .getConfiguration(VSC_CONFIG_NAMESPACE)
            .get<string>('claudePath', 'claude')
            .trim() || 'claude';

        if (path.isAbsolute(configured) && fs.existsSync(configured)) {
            return { binary: configured, path: await this.loginShellPath() };
        }

        const shell = process.env.SHELL || '/bin/zsh';
        try {
            // -l without -i: login files are read, but the interactive rc is not,
            // so a prompt in .zshrc cannot hang this.
            const { stdout } = await execFileAsync(
                shell,
                ['-lc', `command -v ${configured}; printf '__PATH__%s' "$PATH"`],
                { timeout: 5000 }
            );
            const [binaryLine, pathPart] = stdout.split('__PATH__');
            const binary = binaryLine.trim().split('\n').pop()?.trim();
            if (binary && fs.existsSync(binary)) {
                return { binary, path: pathPart?.trim() };
            }
        } catch (error) {
            this.outputChannel.appendLine(`[ClaudeCodeProvider] Login-shell lookup failed: ${error}`);
        }

        for (const candidate of CLAUDE_FALLBACK_PATHS) {
            if (fs.existsSync(candidate)) {
                return { binary: candidate, path: await this.loginShellPath() };
            }
        }

        this.outputChannel.appendLine(
            `[ClaudeCodeProvider] Could not locate "${configured}". Set kfc.claudePath to an absolute path.`
        );
        return undefined;
    }

    private async loginShellPath(): Promise<string | undefined> {
        const shell = process.env.SHELL || '/bin/zsh';
        try {
            const { stdout } = await execFileAsync(shell, ['-lc', 'printf %s "$PATH"'], { timeout: 5000 });
            return stdout.trim() || undefined;
        } catch {
            return undefined;
        }
    }

    /**
     * Runs `command` once the shell can actually receive it.
     *
     * Typing into a terminal races shell startup: anything the rc files print or
     * prompt for can swallow the first characters, which turns `claude ...` into
     * `laude: command not found`. Shell integration tells us when the shell is
     * genuinely ready, so we wait for that rather than guessing a delay.
     *
     * Shells without integration (or a startup prompt still waiting on input)
     * never report ready, so we fall back to the timed send after a grace period.
     */
    private async runWhenReady(terminal: vscode.Terminal, command: string): Promise<void> {
        const integration = await this.waitForShellIntegration(terminal, SHELL_READY_TIMEOUT_MS);

        if (integration) {
            integration.executeCommand(command);
            return;
        }

        this.outputChannel.appendLine(
            '[ClaudeCodeProvider] Shell integration unavailable; falling back to timed send. ' +
            'If the command arrives truncated, an interactive prompt in your shell startup is eating input.'
        );
        const delay = this.configManager.getTerminalDelay();
        setTimeout(() => {
            terminal.sendText(command, true); // true = add newline to execute
        }, delay);
    }

    private waitForShellIntegration(
        terminal: vscode.Terminal,
        timeoutMs: number
    ): Promise<vscode.TerminalShellIntegration | undefined> {
        if (terminal.shellIntegration) {
            return Promise.resolve(terminal.shellIntegration);
        }

        return new Promise(resolve => {
            const timer = setTimeout(() => {
                subscription.dispose();
                resolve(undefined);
            }, timeoutMs);

            const subscription = vscode.window.onDidChangeTerminalShellIntegration(event => {
                if (event.terminal !== terminal) { return; }
                clearTimeout(timer);
                subscription.dispose();
                resolve(event.shellIntegration);
            });
        });
    }

    /**
     * Model/effort overrides for spawned sessions, as CLI flags.
     *
     * Both are per-session, so setting them here never touches the user's
     * ~/.claude/settings.json. Empty settings mean "inherit", which is the
     * default; pinning them matters most for demos and timed runs, where
     * inheriting `opus[1m]` at high effort is the difference between a task
     * taking under a minute and taking fifteen.
     */
    private getModelArgs(modelOverride?: string, effortOverride?: string): string[] {
        const config = vscode.workspace.getConfiguration(VSC_CONFIG_NAMESPACE);
        const model = (modelOverride ?? config.get<string>('claude.model', '')).trim();
        const effort = (effortOverride ?? config.get<string>('claude.effort', '')).trim();

        // Empty by default: Claude Code applies its own settings precedence and
        // prompts for anything not already allowed. Worth pinning only for timed
        // runs, where a permission prompt mid-task costs minutes.
        const permissionMode = config.get<string>('claude.permissionMode', '').trim();

        const args: string[] = [];
        if (model) { args.push('--model', model); }
        if (effort) { args.push('--effort', effort); }
        if (permissionMode) { args.push('--permission-mode', permissionMode); }
        return args;
    }

    private getModelFlags(modelOverride?: string, effortOverride?: string): string {
        const config = vscode.workspace.getConfiguration(VSC_CONFIG_NAMESPACE);
        const model = (modelOverride ?? config.get<string>('claude.model', '')).trim();
        const effort = (effortOverride ?? config.get<string>('claude.effort', '')).trim();

        const permissionMode = config.get<string>('claude.permissionMode', '').trim();

        let flags = '';
        if (model) { flags += ` --model ${model}`; }
        if (effort) { flags += ` --effort ${effort}`; }
        if (permissionMode) { flags += ` --permission-mode ${permissionMode}`; }

        if (flags) {
            this.outputChannel.appendLine(`[ClaudeCodeProvider] Session overrides:${flags}`);
        }
        return flags;
    }

    /**
     * The terminal running `sessionId`, if this extension spawned it.
     */
    getTerminalForSession(sessionId: string): vscode.Terminal | undefined {
        return this.sessionTerminals.get(sessionId);
    }

    /** Session ids Kiro launched here, across reloads. */
    getLaunchedSessionIds(): Set<string> {
        return new Set(
            this.context.workspaceState.get<string[]>(ClaudeCodeProvider.LAUNCHED_KEY, [])
        );
    }

    private async rememberLaunchedSession(sessionId: string): Promise<void> {
        const existing = this.context.workspaceState.get<string[]>(ClaudeCodeProvider.LAUNCHED_KEY, []);
        if (existing.includes(sessionId)) { return; }
        // Bounded: ids of long-dead sessions simply never match a live one, but
        // the list should not grow forever.
        const updated = [...existing, sessionId].slice(-200);
        await this.context.workspaceState.update(ClaudeCodeProvider.LAUNCHED_KEY, updated);
    }

    /**
     * Rename a terminal
     */
    async renameTerminal(terminal: vscode.Terminal, newName: string): Promise<void> {
        // Make sure the terminal is active
        terminal.show();

        // Small delay to ensure terminal is focused
        await new Promise(resolve => setTimeout(resolve, 100));
        this.outputChannel.appendLine(`[ClaudeCodeProvider] ${terminal.name} Terminal renamed to: ${newName}`);

        // Execute the rename command
        await vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', {
            name: newName
        });
    }
}
