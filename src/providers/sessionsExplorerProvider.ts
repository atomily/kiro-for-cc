import * as vscode from 'vscode';
import { SessionMonitor, SessionInfo, SubagentInfo, SubagentStatus } from '../features/sessions/sessionMonitor';
import { VSC_CONFIG_NAMESPACE } from '../constants';

const POLL_INTERVAL_MS = 3000;

export class SessionsExplorerProvider implements vscode.TreeDataProvider<SessionTreeItem>, vscode.Disposable {
    private _onDidChangeTreeData = new vscode.EventEmitter<SessionTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private monitor: SessionMonitor;
    private timer: NodeJS.Timeout | undefined;
    private visible = false;

    /** Live sessions from the last poll, so getChildren can resolve parents cheaply. */
    private liveSessionIds = new Set<string>();

    /**
     * Flat subagent list per session, from the last time that session was expanded.
     * Agents nest (an agent can spawn agents), but they all live in one flat
     * directory keyed by parentAgentId, so the tree shape is rebuilt from here
     * rather than re-reading disk once per level.
     */
    private agentsBySession = new Map<string, SubagentInfo[]>();

    constructor(
        private outputChannel: vscode.OutputChannel,
        /** True when Kiro launched the session and therefore owns its terminal. */
        private isOwned: (sessionId: string) => boolean = () => false,
        /** Ids of every session Kiro launched here, surviving window reloads. */
        private launchedIds: () => Set<string> = () => new Set()
    ) {
        this.monitor = new SessionMonitor(outputChannel);
    }

    /**
     * Polling only runs while the view is on screen: each tick shells out to
     * `claude agents --json` and may scan a multi-MB transcript.
     */
    setVisible(visible: boolean): void {
        this.visible = visible;
        if (visible) {
            this.refresh();
            this.timer ??= setInterval(() => this._onDidChangeTreeData.fire(), POLL_INTERVAL_MS);
        } else if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: SessionTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: SessionTreeItem): Promise<SessionTreeItem[]> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) { return []; }
        const cwd = workspaceFolder.uri.fsPath;

        if (!element) {
            let sessions = await this.monitor.listSessions(cwd);

            // Sessions started outside Kiro are noise here: the view exists to
            // watch work this extension dispatched.
            const showAll = vscode.workspace
                .getConfiguration(VSC_CONFIG_NAMESPACE)
                .get<boolean>('sessions.showAll', false);
            if (!showAll) {
                const launched = this.launchedIds();
                sessions = sessions.filter(s => launched.has(s.sessionId));
            }

            this.liveSessionIds = new Set(sessions.map(s => s.sessionId));

            // Busy sessions first, then most recently started.
            sessions.sort((a, b) => {
                if ((a.status === 'busy') !== (b.status === 'busy')) {
                    return a.status === 'busy' ? -1 : 1;
                }
                return b.startedAt - a.startedAt;
            });

            return sessions.map(s => new SessionTreeItem(s, undefined, false, this.isOwned(s.sessionId)));
        }

        if (element.session) {
            const sessionId = element.session.sessionId;
            const agents = await this.monitor.listSubagents(
                sessionId,
                cwd,
                this.liveSessionIds.has(sessionId)
            );
            this.agentsBySession.set(sessionId, agents);
            // Only top-level agents hang off the session; nested ones hang off
            // whichever agent spawned them.
            return this.toItems(agents.filter(a => !a.parentAgentId), agents);
        }

        if (element.agent) {
            const agents = this.agentsBySession.get(element.agent.sessionId) ?? [];
            return this.toItems(
                agents.filter(a => a.parentAgentId === element.agent!.agentId),
                agents
            );
        }

        return [];
    }

    private toItems(subset: SubagentInfo[], all: SubagentInfo[]): SessionTreeItem[] {
        const parentIds = new Set(all.map(a => a.parentAgentId).filter(Boolean));
        return subset.map(a => new SessionTreeItem(undefined, a, parentIds.has(a.agentId)));
    }

    dispose(): void {
        if (this.timer) { clearInterval(this.timer); }
        this._onDidChangeTreeData.dispose();
    }
}

export class SessionTreeItem extends vscode.TreeItem {
    constructor(
        public readonly session?: SessionInfo,
        public readonly agent?: SubagentInfo,
        hasChildren = false,
        owned = false
    ) {
        super(
            session ? session.name : agent!.description,
            session || hasChildren
                ? vscode.TreeItemCollapsibleState.Expanded
                : vscode.TreeItemCollapsibleState.None
        );

        if (session) {
            // Only Kiro-launched sessions expose a focus action: VS Code gives no
            // handle on a terminal it did not create.
            this.contextValue = owned ? 'kfc-session-owned' : 'kfc-session';
            this.description = `${session.status} · pid ${session.pid}`;
            this.iconPath = new vscode.ThemeIcon(
                session.status === 'busy' ? 'debug-start' : 'vm-outline',
                new vscode.ThemeColor(
                    session.status === 'busy' ? 'charts.green' : 'descriptionForeground'
                )
            );
            this.tooltip = new vscode.MarkdownString(
                [
                    `**${session.name}**`,
                    '',
                    `- Status: \`${session.status}\``,
                    `- Kind: \`${session.kind}\``,
                    `- Session: \`${session.sessionId}\``,
                    `- Started: ${new Date(session.startedAt).toLocaleString()}`,
                    owned ? '' : '',
                    owned
                        ? '_Click to focus its terminal._'
                        : '_Started outside Kiro. Expand to read its subagents._'
                ].filter(Boolean).join('\n')
            );
            // Clicking a session Kiro does not own just expands it, rather than
            // firing a command that can only report failure.
            if (owned) {
                this.command = {
                    command: 'kfc.sessions.focusTerminal',
                    title: 'Focus Session Terminal',
                    arguments: [session]
                };
            }
        } else if (agent) {
            this.contextValue = 'kfc-subagent';
            this.description = agent.agentType;
            this.iconPath = iconForStatus(agent.status);
            this.tooltip = new vscode.MarkdownString(
                [
                    `**${agent.description}**`,
                    '',
                    `- Agent: \`${agent.agentType}\``,
                    `- Status: \`${agent.status}\``,
                    `- Id: \`${agent.agentId}\``,
                    agent.parentAgentId ? `- Spawned by: \`${agent.parentAgentId}\` (depth ${agent.spawnDepth})` : '',
                    agent.updatedAt ? `- Last write: ${new Date(agent.updatedAt).toLocaleTimeString()}` : ''
                ].filter(Boolean).join('\n')
            );
            this.command = {
                command: 'kfc.sessions.openTranscript',
                title: 'Open Agent Transcript',
                arguments: [agent]
            };
        }
    }
}

function iconForStatus(status: SubagentStatus): vscode.ThemeIcon {
    switch (status) {
        case 'running':
            return new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.blue'));
        case 'completed':
            return new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green'));
        case 'failed':
            return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
        case 'killed':
        case 'stopped':
            return new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('charts.yellow'));
        default:
            return new vscode.ThemeIcon('question', new vscode.ThemeColor('descriptionForeground'));
    }
}
