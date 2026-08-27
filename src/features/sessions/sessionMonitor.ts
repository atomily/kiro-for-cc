import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { VSC_CONFIG_NAMESPACE } from '../../constants';

const execFileAsync = promisify(execFile);

/**
 * Terminal states reported by Claude Code's <task-notification> queue entries,
 * plus the two states we derive ourselves.
 */
export type SubagentStatus =
    | 'running'    // spawned, no task-notification yet, owning session alive
    | 'completed'
    | 'failed'
    | 'killed'
    | 'stopped'
    | 'orphaned';  // no notification, but the owning session is gone

export interface SessionInfo {
    pid: number;
    cwd: string;
    kind: string;
    sessionId: string;
    name: string;
    status: string; // 'idle' | 'busy'
    startedAt: number;
}

export interface SubagentInfo {
    agentId: string;
    agentType: string;
    description: string;
    toolUseId: string;
    spawnDepth: number;
    /** Set only for nested agents; depth-1 agents omit the key entirely. */
    parentAgentId?: string;
    sessionId: string;
    transcriptPath: string;
    status: SubagentStatus;
    updatedAt: number;
}

interface StatusCache {
    mtimeMs: number;
    size: number;
    statuses: Map<string, SubagentStatus>;
}

/**
 * Reads Claude Code's on-disk session and subagent state.
 *
 * Two sources, deliberately different:
 *  - Sessions come from `claude agents --json`, a supported scripting interface.
 *  - Subagents have no CLI, so they are read from ~/.claude/projects/<slug>/<sessionId>/subagents/.
 *
 * Everything here is best-effort: these are Claude Code internals and the layout
 * can change between CLI versions, so every read degrades to "nothing found"
 * rather than throwing into the tree view.
 */
export class SessionMonitor {
    private statusCache = new Map<string, StatusCache>();

    constructor(private outputChannel: vscode.OutputChannel) { }

    /**
     * ~/.claude/projects/ encodes a workspace path by replacing every character
     * outside [A-Za-z0-9] with a hyphen.
     * /Users/me/Documents/Github/kiro-for-cc -> -Users-me-Documents-Github-kiro-for-cc
     */
    static projectSlug(cwd: string): string {
        return cwd.replace(/[^a-zA-Z0-9]/g, '-');
    }

    static projectDir(cwd: string): string {
        return path.join(os.homedir(), '.claude', 'projects', SessionMonitor.projectSlug(cwd));
    }

    private getClaudePath(): string {
        return vscode.workspace
            .getConfiguration(VSC_CONFIG_NAMESPACE)
            .get<string>('claudePath', 'claude');
    }

    /**
     * Live Claude Code sessions rooted at `cwd`, newest last.
     *
     * `claude agents --json` is the documented path and does not need a TTY. If it
     * is unavailable (old CLI, claude not on PATH) we fall back to reading the
     * ~/.claude/sessions/<pid>.json registry directly.
     */
    async listSessions(cwd: string): Promise<SessionInfo[]> {
        try {
            const { stdout } = await execFileAsync(
                this.getClaudePath(),
                ['agents', '--json', '--cwd', cwd],
                { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }
            );
            const parsed = JSON.parse(stdout) as SessionInfo[];
            return parsed.filter(s => s && s.sessionId);
        } catch (error) {
            this.outputChannel.appendLine(
                `[SessionMonitor] 'claude agents --json' unavailable (${error}); falling back to session registry`
            );
            return this.listSessionsFromRegistry(cwd);
        }
    }

    private async listSessionsFromRegistry(cwd: string): Promise<SessionInfo[]> {
        const dir = path.join(os.homedir(), '.claude', 'sessions');
        let names: string[];
        try {
            names = await fs.promises.readdir(dir);
        } catch {
            return [];
        }

        const sessions: SessionInfo[] = [];
        for (const name of names.filter(n => n.endsWith('.json'))) {
            try {
                const raw = await fs.promises.readFile(path.join(dir, name), 'utf8');
                const s = JSON.parse(raw);
                if (s?.cwd === cwd && s.sessionId) {
                    sessions.push({
                        pid: s.pid,
                        cwd: s.cwd,
                        kind: s.kind ?? 'interactive',
                        sessionId: s.sessionId,
                        name: s.name ?? s.sessionId.slice(0, 8),
                        status: s.status ?? 'idle',
                        startedAt: s.startedAt ?? 0
                    });
                }
            } catch {
                // A session file mid-write is expected; skip it.
            }
        }
        return sessions;
    }

    /**
     * Subagents spawned by `sessionId`, newest first.
     *
     * Each agent has a `<id>.meta.json` sidecar next to its transcript. Status is
     * NOT derivable from the parent's tool_result: async agents get a result
     * within ~1.5s carrying `status: "async_launched"`. The authoritative finish
     * signal is a <task-notification> queue-operation entry in the parent
     * transcript, so that is what we read.
     */
    async listSubagents(sessionId: string, cwd: string, sessionAlive: boolean): Promise<SubagentInfo[]> {
        const dir = path.join(SessionMonitor.projectDir(cwd), sessionId, 'subagents');
        let names: string[];
        try {
            names = await fs.promises.readdir(dir);
        } catch {
            return []; // No subagents spawned in this session yet.
        }

        // Pass 1: read every sidecar. Agents at all depths live in this one flat
        // directory; nesting is expressed by parentAgentId, not by layout.
        const metas: Array<{ agentId: string; meta: any; transcriptPath: string; updatedAt: number }> = [];
        for (const metaName of names.filter(n => n.endsWith('.meta.json'))) {
            const agentId = metaName.replace(/^agent-/, '').replace(/\.meta\.json$/, '');
            const transcriptPath = path.join(dir, `agent-${agentId}.jsonl`);
            try {
                const meta = JSON.parse(await fs.promises.readFile(path.join(dir, metaName), 'utf8'));
                let updatedAt = 0;
                try {
                    updatedAt = (await fs.promises.stat(transcriptPath)).mtimeMs;
                } catch {
                    // Transcript not created yet; treat as just-spawned.
                }
                metas.push({ agentId, meta, transcriptPath, updatedAt });
            } catch (error) {
                this.outputChannel.appendLine(`[SessionMonitor] Failed to read ${metaName}: ${error}`);
            }
        }

        // Pass 2: an agent's completion is recorded in whichever transcript
        // dispatched it -- the session's for depth-1, the parent agent's for
        // nested ones. Only agents that actually have children are worth scanning.
        const parentIds = new Set(
            metas.map(m => m.meta.parentAgentId).filter((id): id is string => Boolean(id))
        );
        const scanPaths = [path.join(SessionMonitor.projectDir(cwd), `${sessionId}.jsonl`)];
        for (const m of metas) {
            if (parentIds.has(m.agentId)) { scanPaths.push(m.transcriptPath); }
        }

        const statuses = new Map<string, SubagentStatus>();
        for (const scanPath of scanPaths) {
            for (const [id, status] of await this.readAgentStatuses(scanPath)) {
                statuses.set(id, status);
            }
        }

        return metas
            .map(({ agentId, meta, transcriptPath, updatedAt }) => ({
                agentId,
                agentType: meta.agentType ?? 'agent',
                description: meta.description ?? agentId,
                toolUseId: meta.toolUseId ?? '',
                spawnDepth: meta.spawnDepth ?? 1,
                parentAgentId: meta.parentAgentId,
                sessionId,
                transcriptPath,
                status: statuses.get(agentId) ?? (sessionAlive ? 'running' : 'orphaned'),
                updatedAt
            }))
            .sort((a, b) => b.updatedAt - a.updatedAt);
    }

    /**
     * Maps agentId -> terminal status by scanning one transcript.
     *
     * Two completion signals exist, because the Agent tool dispatches both ways:
     *
     *  - Synchronous agents finish inline. Their tool_result carries
     *    `toolUseResult: { agentId, status: "completed" }` with no isAsync flag,
     *    and no notification is ever emitted.
     *  - Async agents get a tool_result within ~1.5s carrying
     *    `status: "async_launched"`, which means started, NOT finished. Their
     *    real completion arrives later as a <task-notification> queue entry.
     *
     * Reading only one of the two leaves a whole class of agent stuck on
     * "running" forever, so both are collected here.
     *
     * Transcripts reach tens of MB, so results are cached on (mtime, size);
     * a finished agent's file stops changing and is never re-read.
     */
    private async readAgentStatuses(transcript: string): Promise<Map<string, SubagentStatus>> {
        let stat: fs.Stats;
        try {
            stat = await fs.promises.stat(transcript);
        } catch {
            return new Map();
        }

        const cached = this.statusCache.get(transcript);
        if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
            return cached.statuses;
        }

        const statuses = new Map<string, SubagentStatus>();
        try {
            const raw = await fs.promises.readFile(transcript, 'utf8');

            // Async completions. Each id/status pair MUST be read from inside a
            // single <task-notification> block: a pattern spanning blocks pairs a
            // task-id with a status from an unrelated later notification --
            // including ids that appear in prose, since system prompts document
            // this very format using a literal <task-id>ID</task-id>.
            const blockRe = /<task-notification>([\s\S]*?)<\/task-notification>/g;
            let block: RegExpExecArray | null;
            while ((block = blockRe.exec(raw)) !== null) {
                const taskId = /<task-id>([^<]+)<\/task-id>/.exec(block[1])?.[1];
                const status = /<status>([^<]+)<\/status>/.exec(block[1])?.[1];
                if (taskId && status && isTerminalStatus(status)) {
                    statuses.set(taskId, status);
                }
            }

            // Synchronous completions. Only lines mentioning agentId are parsed,
            // which is a small fraction of a transcript.
            for (const line of raw.split('\n')) {
                if (!line.includes('"agentId"')) { continue; }
                try {
                    const result = JSON.parse(line)?.toolUseResult;
                    if (result?.agentId && result.isAsync !== true && isTerminalStatus(result.status)) {
                        statuses.set(result.agentId, result.status);
                    }
                } catch {
                    // Partial line while the transcript is being appended to.
                }
            }
        } catch (error) {
            this.outputChannel.appendLine(`[SessionMonitor] Failed to scan ${transcript}: ${error}`);
            return statuses;
        }

        this.statusCache.set(transcript, { mtimeMs: stat.mtimeMs, size: stat.size, statuses });
        return statuses;
    }
}

function isTerminalStatus(status: unknown): status is SubagentStatus {
    return typeof status === 'string'
        && ['completed', 'failed', 'killed', 'stopped'].includes(status);
}
