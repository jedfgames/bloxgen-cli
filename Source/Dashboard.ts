// Bloxgen Dashboard — interactive web UI for the Bloxgen development loop.
// Operates on the current working directory as the project root.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

// The HTML is embedded as a generated module (see scripts/embed-html.ts).
import DASHBOARD_HTML from "./Dashboard.html" with { type: "text" };

// ── Paths (derived from cwd, not script location) ────────────────
const PROJECT_ROOT = process.cwd();
const LOG_DIR = path.join(PROJECT_ROOT, ".claude", "bloxgen-logs");
const CHECKPOINT_FILE = path.join(
    PROJECT_ROOT,
    ".claude",
    "bloxgen-checkpoint.json",
);
const STATUS_FILE = path.join(PROJECT_ROOT, ".claude", "bloxgen-status.txt");
const STOP_FILE = path.join(PROJECT_ROOT, ".claude", "bloxgen-stop");
const TODO_FILE = path.join(PROJECT_ROOT, "knowledge", "TODO.md");
const USER_TODO_FILE = path.join(PROJECT_ROOT, "knowledge", "USER_TODO.md");
const MCP_CONFIG = path.join(PROJECT_ROOT, ".claude", "mcp-bloxgen.json");
const FEATURES_FILE = path.join(PROJECT_ROOT, "knowledge", "FEATURES.md");
const GDD_FILE = path.join(PROJECT_ROOT, "knowledge", "GDD.md");

// ── Config ─────────────────────────────────────────────────────────
const PORT = 7377;
const PAUSE_BETWEEN_SECS = 5;
const MIN_PLANNED_FEATURES = 2;
const CRITIC_INTERVAL = 3;
const MONTHLY_CAP_USD = 200;
// Max 20x plan gives ~20x more value per dollar than API rates.
// plan_cost = api_cost / API_TO_PLAN_RATIO
const API_TO_PLAN_RATIO = 20;

const ALLOWED_TOOLS = [
    "Read",
    "Write",
    "Edit",
    "Glob",
    "Grep",
    "Bash",
    "Agent",
    "mcp__roblox-custom__run_lune_tests",
    "mcp__roblox-custom__run_studio_tests",
    "mcp__roblox-custom__run_regression",
    "mcp__roblox-custom__check_luau_syntax",
    "mcp__roblox-custom__search_roblox_assets",
    "mcp__roblox-custom__run_playtest",
    "mcp__roblox-custom__run_playtest_manual",
    "mcp__roblox-custom__screenshot_studio",
].join(",");

// ── State ──────────────────────────────────────────────────────────
interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUSD: number;
    numTurns: number;
    contextWindow: number;
}

interface BloxgenState {
    status: "idle" | "running" | "stopping" | "stopping_graceful";
    iteration: number;
    featuresBuilt: number;
    featuresIdeated: number;
    mode: "BUILD" | "IDEATE" | "CRITIC" | "PARALLEL_FIX" | "IDLE";
    currentStep: string;
    currentFeatureId: string;
    plannedCount: number;
    buildModel: string;
    lastMode: string;
    logFile: string;
    startedAt: string | null;
    iterationStartedAt: string | null;
    tokens: TokenUsage;
}

const emptyTokens = (): TokenUsage => ({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUSD: 0,
    numTurns: 0,
    contextWindow: 200000,
});

const state: BloxgenState = {
    status: "idle",
    iteration: 0,
    featuresBuilt: 0,
    featuresIdeated: 0,
    mode: "IDLE",
    currentStep: "",
    currentFeatureId: "",
    plannedCount: 0,
    buildModel: "",
    lastMode: "",
    logFile: "",
    startedAt: null,
    iterationStartedAt: null,
    tokens: emptyTokens(),
};

let claudeProcess: ChildProcess | null = null;
let resumeFlag = false;
let forceCriticNext = false;
let criticModel: "haiku" | "sonnet" | "opus" = "haiku";
let refinementMode = false;
let lastCheckpointFeature = "";
let lastCheckpointStep = "";
let sessionCostUSD = 0;

// ── Parallel Agents ───────────────────────────────────────────────
interface ParallelAgent {
    id: string; // e.g. "agent-0"
    bugId: string; // e.g. "BUG-023"
    bugName: string; // short description
    model: string; // e.g. "haiku" or "sonnet"
    status: "coding" | "done" | "failed";
    branch: string; // worktree branch name
    worktreePath: string;
    process: ChildProcess | null;
    output: { event: string; data: unknown }[];
    startedAt: string;
    finishedAt: string | null;
    error: string | null;
}

interface ParallelState {
    phase: "idle" | "coding" | "merging" | "testing" | "done";
    agents: ParallelAgent[];
    testAgent: ChildProcess | null;
    testOutput: { event: string; data: unknown }[];
    testResult: string | null;
}

const parallelState: ParallelState = {
    phase: "idle",
    agents: [],
    testAgent: null,
    testOutput: [],
    testResult: null,
};

const PARALLEL_ALLOWED_TOOLS = [
    "Read",
    "Write",
    "Edit",
    "Glob",
    "Grep",
    "Bash",
    "Agent",
].join(",");

const PARALLEL_FIX_PROMPT = `You are fixing a specific bug in a Roblox incremental simulator project.
Your job: implement the fix for the assigned bug, then exit cleanly.

IMPORTANT: You are running in PARALLEL with other agents. Do NOT run any Studio tests,
playtests, or regression tests. Only fix the code and check syntax.

## Workflow
1. Read knowledge/TODO.md and find the bug entry
2. Read knowledge/SOLVED_ISSUES.md for relevant pitfalls
3. Read .claude/CONVENTIONS.md and .claude/RULES.md for coding standards
4. Read the source files related to the bug
5. Implement the fix following conventions (--!strict, InputBridge, GameState)
6. Check syntax on every .luau file you modify using check_luau_syntax
7. Do NOT run Studio tests, Lune tests, regression, or playtests

When finished, output: BLOXGEN: FIXED <BUG_ID> — <summary of fix>
If stuck after 3 attempts, output: BLOXGEN: STUCK — <reason>`;

function getParallelPublicState() {
    return {
        phase: parallelState.phase,
        agents: parallelState.agents.map((a) => ({
            id: a.id,
            bugId: a.bugId,
            bugName: a.bugName,
            status: a.status,
            branch: a.branch,
            startedAt: a.startedAt,
            finishedAt: a.finishedAt,
            error: a.error,
            outputCount: a.output.length,
        })),
        testResult: parallelState.testResult,
        testOutputCount: parallelState.testOutput.length,
    };
}

function broadcastParallel() {
    broadcast("parallel", getParallelPublicState());
}

async function spawnParallelAgents(bugs: { id: string; model: string }[]) {
    if (parallelState.phase !== "idle") return;

    parallelState.phase = "coding";
    parallelState.agents = [];
    parallelState.testOutput = [];
    parallelState.testResult = null;
    broadcastParallel();

    // Read TODO.md once to get bug descriptions
    let todoContent = "";
    try {
        todoContent = fs.readFileSync(TODO_FILE, "utf-8");
    } catch {}

    for (let i = 0; i < bugs.length; i++) {
        const bugId = bugs[i].id;
        const bugModel = bugs[i].model;
        const branch = `parallel-fix/${bugId.toLowerCase()}-${Date.now()}`;
        const worktreePath = path.join(
            PROJECT_ROOT,
            ".claude",
            "worktrees",
            `agent-${i}`,
        );

        // Extract bug name from TODO.md
        let bugName = bugId;
        for (const line of todoContent.split("\n")) {
            if (
                line.includes(bugId) &&
                (line.includes("| planned") || line.includes("- ["))
            ) {
                const cols = line.split("|");
                if (cols.length >= 4) {
                    bugName = cols[3]?.trim().split(" — ")[0] || bugId;
                } else {
                    // Active issues format: - [ ] **BUG-XXX**: description
                    const descMatch = line.match(
                        /\*\*[^*]+\*\*:\s*(.+?)(?:\s*—|$)/,
                    );
                    if (descMatch) bugName = descMatch[1].trim();
                }
                break;
            }
        }

        const agent: ParallelAgent = {
            id: `agent-${i}`,
            bugId,
            bugName,
            model: bugModel,
            status: "coding",
            branch,
            worktreePath,
            process: null,
            output: [],
            startedAt: new Date().toISOString(),
            finishedAt: null,
            error: null,
        };
        parallelState.agents.push(agent);
    }

    broadcastParallel();

    // Create worktrees and spawn agents
    const agentPromises: Promise<void>[] = [];
    for (const agent of parallelState.agents) {
        agentPromises.push(spawnOneAgent(agent));
    }

    // Wait for all agents to finish coding
    await Promise.all(agentPromises);

    // Check if all succeeded
    const allDone = parallelState.agents.every((a) => a.status === "done");
    const anyDone = parallelState.agents.some((a) => a.status === "done");

    if (!anyDone) {
        parallelState.phase = "done";
        parallelState.testResult = "All agents failed — no merge needed";
        broadcastParallel();
        broadcast(
            "signal",
            "PARALLEL: All agents failed. No changes to merge.",
        );
        return;
    }

    // Merge phase
    parallelState.phase = "merging";
    broadcastParallel();
    broadcast("text", "\n--- PARALLEL: Merging agent branches ---\n");

    let mergeErrors = 0;
    for (const agent of parallelState.agents) {
        if (agent.status !== "done") continue;
        try {
            // Cherry-pick or merge changes from the worktree branch
            execSync(`git merge --no-edit ${agent.branch}`, {
                cwd: PROJECT_ROOT,
                encoding: "utf-8",
                timeout: 30000,
            });
            broadcast("text", `Merged ${agent.branch} (${agent.bugId})`);
        } catch (err: any) {
            mergeErrors++;
            broadcast(
                "signal",
                `MERGE CONFLICT: ${agent.bugId} — ${err.message}`,
            );
            // Abort the failed merge
            try {
                execSync("git merge --abort", {
                    cwd: PROJECT_ROOT,
                    timeout: 5000,
                });
            } catch {}
        }
    }

    // Clean up worktrees
    for (const agent of parallelState.agents) {
        try {
            execSync(`git worktree remove --force "${agent.worktreePath}"`, {
                cwd: PROJECT_ROOT,
                timeout: 10000,
            });
        } catch {}
        try {
            execSync(`git branch -D ${agent.branch}`, {
                cwd: PROJECT_ROOT,
                timeout: 5000,
            });
        } catch {}
    }

    if (mergeErrors > 0) {
        broadcast(
            "signal",
            `PARALLEL: ${mergeErrors} merge conflict(s). Resolve manually.`,
        );
    }

    // Testing phase
    parallelState.phase = "testing";
    broadcastParallel();
    broadcast("text", "\n--- PARALLEL: Running tests on merged code ---\n");

    await runTestAgent();

    // Mark successfully fixed bugs as implemented in TODO.md
    const fixedBugIds = parallelState.agents
        .filter((a) => a.status === "done")
        .map((a) => a.bugId);
    if (fixedBugIds.length > 0) {
        markBugsImplemented(fixedBugIds);
        broadcast(
            "text",
            `Marked ${fixedBugIds.length} bug(s) as implemented: ${fixedBugIds.join(", ")}`,
        );
    }

    parallelState.phase = "done";
    broadcastParallel();
    broadcast("signal", "PARALLEL: Complete");
}

async function spawnOneAgent(agent: ParallelAgent): Promise<void> {
    return new Promise((resolve) => {
        try {
            // Create worktree directory
            fs.mkdirSync(path.dirname(agent.worktreePath), { recursive: true });

            // Create git worktree with new branch
            execSync(
                `git worktree add -b ${agent.branch} "${agent.worktreePath}" HEAD`,
                {
                    cwd: PROJECT_ROOT,
                    encoding: "utf-8",
                    timeout: 30000,
                },
            );
        } catch (err: any) {
            agent.status = "failed";
            agent.error = `Worktree creation failed: ${err.message}`;
            agent.finishedAt = new Date().toISOString();
            broadcastParallel();
            resolve();
            return;
        }

        // Copy untracked game files into the worktree (git worktree only includes tracked files)
        const untrackedDirs = [
            "src/shared/Features",
            "src/shared/GameState/Snapshots",
            "tests/studio/suites",
            "tests/studio/playtests",
            "tests/lune/suites",
            "tests/lune/sim",
            "ServerPackages",
        ];
        const untrackedFiles = ["src/shared/Progression/StepValidator.luau"];
        for (const dir of untrackedDirs) {
            const src = path.join(PROJECT_ROOT, dir);
            const dest = path.join(agent.worktreePath, dir);
            if (fs.existsSync(src)) {
                fs.cpSync(src, dest, { recursive: true, force: true });
            }
        }
        for (const file of untrackedFiles) {
            const src = path.join(PROJECT_ROOT, file);
            const dest = path.join(agent.worktreePath, file);
            if (fs.existsSync(src)) {
                fs.mkdirSync(path.dirname(dest), { recursive: true });
                fs.copyFileSync(src, dest);
            }
        }

        const prompt = `${PARALLEL_FIX_PROMPT}\n\n## Your assigned bug: ${agent.bugId}\nFix ONLY this bug. Read TODO.md to find its description.`;

        const claude = spawn(
            "claude",
            [
                "-p",
                prompt,
                "--allowedTools",
                PARALLEL_ALLOWED_TOOLS,
                "--model",
                agent.model,
                "--mcp-config",
                path.join(PROJECT_ROOT, ".claude", "mcp-none.json"),
                "--strict-mcp-config",
                "--verbose",
                "--output-format",
                "stream-json",
            ],
            {
                cwd: agent.worktreePath,
                env: process.env,
                stdio: ["ignore", "pipe", "pipe"],
            },
        );

        agent.process = claude;
        broadcastParallel();

        const rl = createInterface({ input: claude.stdout! });
        rl.on("line", (raw: string) => {
            const trimmed = raw.trim();
            if (!trimmed) return;

            let obj: any;
            try {
                obj = JSON.parse(trimmed);
            } catch {
                return;
            }

            if (obj.type !== "assistant") return;
            const content = obj.message?.content;
            if (!Array.isArray(content)) return;

            for (const c of content) {
                if (c.type === "text" && c.text?.trim()) {
                    agent.output.push({ event: "text", data: c.text });
                    broadcast("parallel-agent", {
                        agentId: agent.id,
                        event: "text",
                        data: c.text,
                    });

                    // Check for completion signals
                    if (c.text.includes("BLOXGEN: FIXED")) {
                        // Will be marked done on exit
                    }
                    if (c.text.includes("BLOXGEN: STUCK")) {
                        agent.error = c.text;
                    }
                } else if (c.type === "tool_use") {
                    const summary = summarizeTool(c.name ?? "", c.input ?? {});
                    agent.output.push({ event: "tool", data: summary });
                    broadcast("parallel-agent", {
                        agentId: agent.id,
                        event: "tool",
                        data: summary,
                    });
                }
            }
        });

        claude.stderr?.on("data", (chunk: Buffer) => {
            const text = chunk.toString().trim();
            if (text) {
                agent.output.push({ event: "text", data: `[stderr] ${text}` });
            }
        });

        claude.on("exit", (code) => {
            agent.process = null;
            agent.finishedAt = new Date().toISOString();

            // Check if any FIXED signal was output
            const hasFixed = agent.output.some(
                (o) =>
                    typeof o.data === "string" &&
                    o.data.includes("BLOXGEN: FIXED"),
            );
            const hasStuck = agent.output.some(
                (o) =>
                    typeof o.data === "string" &&
                    o.data.includes("BLOXGEN: STUCK"),
            );

            if (hasFixed && !hasStuck) {
                agent.status = "done";
            } else {
                agent.status = "failed";
                if (!agent.error)
                    agent.error = hasStuck
                        ? "Agent got stuck"
                        : `Exited with code ${code}`;
            }

            broadcastParallel();
            broadcast("parallel-agent", {
                agentId: agent.id,
                event: "signal",
                data: `Agent ${agent.bugId}: ${agent.status}`,
            });
            resolve();
        });

        claude.on("error", (err) => {
            agent.process = null;
            agent.status = "failed";
            agent.error = err.message;
            agent.finishedAt = new Date().toISOString();
            broadcastParallel();
            resolve();
        });
    });
}

async function runTestAgent(): Promise<void> {
    return new Promise((resolve) => {
        const bugSummary = parallelState.agents
            .filter((a) => a.status === "done")
            .map((a) => `- ${a.bugId}: ${a.bugName}`)
            .join("\n");

        const testPrompt = `You are the TEST AGENT for a parallel bugfix session.
Multiple agents have just fixed bugs in parallel and their changes have been merged.
Your job: run tests, identify failures, and fix them.

## Bugs that were fixed
${bugSummary}

## Workflow
1. Run Studio tests with run_studio_tests
2. Run regression tests with run_regression
3. If any tests fail, use get_console_output to read the Roblox Studio console for additional error details
4. Read the relevant source code and fix the issue
5. Re-run failing tests until they pass (max 3 attempts per test)
6. If you fix code, check syntax with check_luau_syntax

When finished, output: BLOXGEN: TESTS_DONE — <pass_count>/<total_count> passed
If stuck, output: BLOXGEN: TESTS_STUCK — <reason>`;

        const claude = spawn(
            "claude",
            [
                "-p",
                testPrompt,
                "--allowedTools",
                ALLOWED_TOOLS,
                "--mcp-config",
                MCP_CONFIG,
                "--strict-mcp-config",
                "--verbose",
                "--output-format",
                "stream-json",
            ],
            {
                cwd: PROJECT_ROOT,
                env: process.env,
                stdio: ["ignore", "pipe", "pipe"],
            },
        );

        parallelState.testAgent = claude;
        broadcastParallel();

        const rl = createInterface({ input: claude.stdout! });
        rl.on("line", (raw: string) => {
            const trimmed = raw.trim();
            if (!trimmed) return;

            let obj: any;
            try {
                obj = JSON.parse(trimmed);
            } catch {
                return;
            }

            if (obj.type !== "assistant") return;
            const content = obj.message?.content;
            if (!Array.isArray(content)) return;

            for (const c of content) {
                if (c.type === "text" && c.text?.trim()) {
                    parallelState.testOutput.push({
                        event: "text",
                        data: c.text,
                    });
                    broadcast("parallel-test", { event: "text", data: c.text });

                    if (
                        c.text.includes("BLOXGEN: TESTS_DONE") ||
                        c.text.includes("BLOXGEN: TESTS_STUCK")
                    ) {
                        parallelState.testResult = c.text;
                    }
                } else if (c.type === "tool_use") {
                    const summary = summarizeTool(c.name ?? "", c.input ?? {});
                    parallelState.testOutput.push({
                        event: "tool",
                        data: summary,
                    });
                    broadcast("parallel-test", {
                        event: "tool",
                        data: summary,
                    });
                }
            }
        });

        claude.stderr?.on("data", (chunk: Buffer) => {
            const text = chunk.toString().trim();
            if (text) {
                parallelState.testOutput.push({
                    event: "text",
                    data: `[stderr] ${text}`,
                });
            }
        });

        claude.on("exit", () => {
            parallelState.testAgent = null;
            if (!parallelState.testResult) {
                parallelState.testResult = "Test agent exited without result";
            }
            broadcastParallel();
            resolve();
        });

        claude.on("error", (err) => {
            parallelState.testAgent = null;
            parallelState.testResult = `Test agent error: ${err.message}`;
            broadcastParallel();
            resolve();
        });
    });
}

function stopParallelAgents() {
    // Kill all agent processes
    for (const agent of parallelState.agents) {
        if (agent.process) {
            agent.process.kill();
            agent.process = null;
            agent.status = "failed";
            agent.error = "Stopped by user";
            agent.finishedAt = new Date().toISOString();
        }
    }
    // Kill test agent
    if (parallelState.testAgent) {
        parallelState.testAgent.kill();
        parallelState.testAgent = null;
        parallelState.testResult = "Stopped by user";
    }
    // Clean up worktrees
    for (const agent of parallelState.agents) {
        try {
            execSync(`git worktree remove --force "${agent.worktreePath}"`, {
                cwd: PROJECT_ROOT,
                timeout: 10000,
            });
        } catch {}
        try {
            execSync(`git branch -D ${agent.branch}`, {
                cwd: PROJECT_ROOT,
                timeout: 5000,
            });
        } catch {}
    }
    parallelState.phase = "idle";
    broadcastParallel();
}

// ── SSE Clients ────────────────────────────────────────────────────
const sseClients = new Set<http.ServerResponse>();

const MAX_OUTPUT_BUFFER = 2000;
const outputBuffer: { event: string; data: unknown }[] = [];

function broadcast(event: string, data: unknown) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    // Buffer displayable events for replay on reconnect
    if (
        event === "text" ||
        event === "tool" ||
        event === "step" ||
        event === "signal"
    ) {
        outputBuffer.push({ event, data });
        if (outputBuffer.length > MAX_OUTPUT_BUFFER) {
            outputBuffer.splice(0, outputBuffer.length - MAX_OUTPUT_BUFFER);
        }
    }
    for (const client of sseClients) {
        try {
            client.write(payload);
        } catch {
            sseClients.delete(client);
        }
    }
}

function broadcastState() {
    broadcast("state", getPublicState());
}

function getMonthCostUSD(): number {
    const now = new Date();
    const monthPrefix = `bloxgen_${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
    let total = 0;
    try {
        const files = fs
            .readdirSync(LOG_DIR)
            .filter(
                (f: string) => f.startsWith(monthPrefix) && f.endsWith(".log"),
            );
        for (const file of files) {
            const fullPath = path.join(LOG_DIR, file);
            const stat = fs.statSync(fullPath);
            const readSize = Math.min(stat.size, 4096);
            const buf = Buffer.alloc(readSize);
            const fd = fs.openSync(fullPath, "r");
            fs.readSync(
                fd,
                buf,
                0,
                readSize,
                Math.max(0, stat.size - readSize),
            );
            fs.closeSync(fd);
            const tail = buf.toString("utf-8");
            const resultMatch = tail.match(/\{"type":"result".*$/m);
            if (resultMatch) {
                try {
                    const result = JSON.parse(resultMatch[0]);
                    total += result.total_cost_usd ?? 0;
                } catch {}
            }
        }
    } catch {}
    return total;
}

function getPublicState() {
    return {
        status: state.status,
        iteration: state.iteration,
        featuresBuilt: state.featuresBuilt,
        featuresIdeated: state.featuresIdeated,
        mode: state.mode,
        currentStep: state.currentStep,
        currentFeatureId: state.currentFeatureId,
        plannedCount: state.plannedCount,
        plannedQueue: getPlannedQueue(),
        startedAt: state.startedAt,
        iterationStartedAt: state.iterationStartedAt,
        tokens: state.tokens,
        hasCheckpoint: fs.existsSync(CHECKPOINT_FILE),
        sessionCostUSD: sessionCostUSD / API_TO_PLAN_RATIO,
        monthCostUSD: (getMonthCostUSD() + sessionCostUSD) / API_TO_PLAN_RATIO,
        monthlyCapUSD: MONTHLY_CAP_USD,
        iterCostUSD: state.tokens.costUSD / API_TO_PLAN_RATIO,
        criticModel,
        buildModel: state.buildModel,
        refinementMode,
    };
}

// ── Helpers (ported from bloxgen.sh) ─────────────────────────────────
function countPlanned(): number {
    try {
        const content = fs.readFileSync(TODO_FILE, "utf-8");
        return (content.match(/\| planned/g) || []).length;
    } catch {
        return 0;
    }
}

function listPlannedIds(): string[] {
    try {
        const content = fs.readFileSync(TODO_FILE, "utf-8");
        const ids: string[] = [];
        for (const line of content.split("\n")) {
            if (line.includes("| planned")) {
                const cols = line.split("|");
                if (cols.length >= 3) ids.push(cols[2].trim());
            }
        }
        return ids;
    } catch {
        return [];
    }
}

function getPlannedQueue(): {
    priority: number;
    id: string;
    name: string;
    description: string;
    complexity: string;
    systems: string;
    progressionStep: string;
}[] {
    try {
        const content = fs.readFileSync(TODO_FILE, "utf-8");
        const items: {
            priority: number;
            id: string;
            name: string;
            description: string;
            complexity: string;
            systems: string;
            progressionStep: string;
        }[] = [];
        const seenIds = new Set<string>();

        for (const line of content.split("\n")) {
            // Feature Queue table rows with "| planned"
            if (line.includes("| planned")) {
                const cols = line.split("|").map((c) => c.trim());
                if (cols.length < 6) continue;
                const priority = parseInt(cols[1], 10);
                const id = cols[2];
                const rawName = cols[3];
                const nameParts = rawName.split(/\s[—–-]\s/);
                const name = nameParts[0];
                const description = nameParts.slice(1).join(" — ") || "";
                const progressionStep = cols[4] || "";
                const complexity = cols[5] || "";
                const systems = cols[6] || "";
                items.push({
                    priority: isNaN(priority) ? 99 : priority,
                    id,
                    name,
                    description,
                    complexity,
                    systems,
                    progressionStep,
                });
                seenIds.add(id);
                continue;
            }

            // Active Issues: unchecked bugs "- [ ] **BUG-XXX**: description — Difficulty: xxx — Systems: yyy"
            const bugMatch = line.match(/^- \[ \] \*\*(\w+-\d+)\*\*:\s*(.+)/);
            if (bugMatch) {
                const id = bugMatch[1];
                if (seenIds.has(id)) continue;
                const rest = bugMatch[2];
                const nameParts = rest.split(/\s[—–-]\s/);
                const name = nameParts[0].substring(0, 80);
                const description = rest;
                const diffMatch = rest.match(
                    /Difficulty:\s*\*{0,2}(\w+)\*{0,2}/i,
                );
                const sysMatch = rest.match(/Systems:\s*([^—–\-\[]+)/i);
                const complexity = diffMatch ? diffMatch[1] : "";
                const systems = sysMatch ? sysMatch[1].trim() : "";
                // Bugs from Active Issues appear after all Feature Queue items (agent picks Feature Queue first)
                const maxFeaturePriority = items.reduce(
                    (max, it) => Math.max(max, it.priority),
                    0,
                );
                items.push({
                    priority: maxFeaturePriority + 1,
                    id,
                    name,
                    description,
                    complexity,
                    systems,
                    progressionStep: "",
                });
                seenIds.add(id);
            }
        }

        items.sort((a, b) => a.priority - b.priority);
        return items;
    } catch {
        return [];
    }
}

function getParallelBugs(): { id: string; model: string }[] {
    return getPlannedQueue()
        .filter((item) => {
            if (!item.id.startsWith("BUG-")) return false;
            const c = item.complexity.toLowerCase();
            return ["easy", "haiku", "medium", "sonnet"].includes(c);
        })
        .map((item) => {
            const c = item.complexity.toLowerCase();
            const model = c === "easy" || c === "haiku" ? "haiku" : "sonnet";
            return { id: item.id, model };
        });
}

function getNextBugId(): string {
    try {
        const content = fs.readFileSync(TODO_FILE, "utf-8");
        let maxId = 0;
        const re = /BUG-(\d+)/g;
        let match;
        while ((match = re.exec(content)) !== null) {
            const num = parseInt(match[1], 10);
            if (num > maxId) maxId = num;
        }
        return `BUG-${String(maxId + 1).padStart(3, "0")}`;
    } catch {
        return "BUG-999";
    }
}

function markBugsImplemented(bugIds: string[]): void {
    try {
        let content = fs.readFileSync(TODO_FILE, "utf-8");
        for (const bugId of bugIds) {
            // Mark Active Issues checkbox: - [ ] **BUG-XXX** → - [x] **BUG-XXX**
            content = content.replace(
                new RegExp(`- \\[ \\] (\\*\\*${bugId}\\*\\*)`, "g"),
                "- [x] $1",
            );
            // Mark Feature Queue table row: | planned | → | implemented |
            // Match lines containing the bug ID and "planned"
            content = content.replace(
                new RegExp(
                    `(\\|[^|]*${bugId}[^|]*(?:\\|[^|]*)*\\|\\s*)planned(\\s*\\|)`,
                    "g",
                ),
                "$1implemented$2",
            );
        }
        fs.writeFileSync(TODO_FILE, content);
    } catch (err) {
        console.error("Failed to mark bugs as implemented:", err);
    }
}

function appendBugToTodo(
    bugId: string,
    description: string,
    severity: string,
    systems: string,
): void {
    try {
        const content = fs.readFileSync(TODO_FILE, "utf-8");
        const lines = content.split("\n");

        // Insert active issue entry before "## Feature Queue"
        const activeEntry = `- [ ] **${bugId}**: ${description} — Severity: ${severity} — Systems: ${systems}`;
        const tableEntry = `| 0 | ${bugId} | ${description} | N/A | ${severity === "high" ? "medium" : "easy"} | ${systems} | planned |`;

        let featureQueueIdx = lines.findIndex((l) =>
            l.startsWith("## Feature Queue"),
        );
        if (featureQueueIdx === -1) featureQueueIdx = lines.length;
        lines.splice(featureQueueIdx, 0, activeEntry, "");

        // Insert table row before "## Backlog"
        const backlogIdx = lines.findIndex((l) => l.startsWith("## Backlog"));
        if (backlogIdx !== -1) {
            lines.splice(backlogIdx, 0, tableEntry);
        }

        fs.writeFileSync(TODO_FILE, lines.join("\n"));
    } catch (err) {
        console.error("Failed to append bug to TODO:", err);
    }
}

function getFirstPlannedFeature(): {
    id: string;
    name: string;
    difficulty: string;
} {
    try {
        const content = fs.readFileSync(TODO_FILE, "utf-8");
        for (const line of content.split("\n")) {
            if (line.includes("| planned")) {
                const cols = line.split("|");
                const rawDifficulty = (cols[5]?.trim() || "").toLowerCase();
                // Map legacy names and normalize to haiku/sonnet/opus
                const rawModel =
                    rawDifficulty === "easy"
                        ? "haiku"
                        : rawDifficulty === "medium"
                          ? "sonnet"
                          : rawDifficulty === "hard"
                            ? "opus"
                            : ["haiku", "sonnet", "opus"].includes(
                                    rawDifficulty,
                                )
                              ? rawDifficulty
                              : "sonnet"; // default to sonnet if unrecognized
                // Features should never use anything lower than sonnet
                const id = cols[2]?.trim() || "";
                const isFeature = !id.startsWith("BUG-");
                const difficulty =
                    isFeature && rawModel === "haiku" ? "sonnet" : rawModel;
                return {
                    id,
                    name: cols[3]?.trim() || "?",
                    difficulty,
                };
            }
        }
    } catch {}
    return { id: "", name: "", difficulty: "sonnet" };
}

function saveCheckpoint() {
    const data = {
        iteration: state.iteration,
        features_built: state.featuresBuilt,
        features_ideated: state.featuresIdeated,
        timestamp: new Date().toISOString().replace(/\.\d+Z$/, ""),
        last_feature_id: state.currentFeatureId,
        last_step: state.currentStep,
        refinement_mode: refinementMode,
    };
    fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(data, null, 2) + "\n");
}

function loadCheckpoint(): boolean {
    try {
        const raw = fs.readFileSync(CHECKPOINT_FILE, "utf-8");
        const data = JSON.parse(raw);
        state.iteration = data.iteration || 0;
        state.featuresBuilt = data.features_built || 0;
        state.featuresIdeated = data.features_ideated || 0;
        lastCheckpointFeature = data.last_feature_id || "";
        lastCheckpointStep = data.last_step || "";
        refinementMode = data.refinement_mode || false;
        return true;
    } catch {
        return false;
    }
}

function writeStatus(msg: string) {
    const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
    fs.writeFileSync(STATUS_FILE, `${time} — ${msg}\n`);
}

function formatTimestamp(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function killStaleMcp() {
    try {
        const result = execSync(
            "wmic process where \"commandline like '%mcp-tools/server.ts%'\" get ProcessId 2>nul",
            { encoding: "utf-8", timeout: 5000 },
        );
        const pids = result.match(/\d+/g) || [];
        for (const pid of pids) {
            try {
                execSync(`taskkill /F /PID ${pid}`, { timeout: 3000 });
            } catch {}
        }
    } catch {}
}

function checkStudioMcp(timeoutSecs = 10): Promise<boolean> {
    return new Promise((resolve) => {
        const mcpExe = path.join(
            PROJECT_ROOT,
            "mcp-tools",
            "rbx-studio-mcp.exe",
        );
        if (!fs.existsSync(mcpExe)) {
            resolve(false);
            return;
        }

        const proc = spawn(mcpExe, ["--stdio"], {
            stdio: ["pipe", "pipe", "pipe"],
        });
        let resolved = false;
        const timer = setTimeout(() => {
            if (!resolved) {
                resolved = true;
                proc.kill();
                resolve(false);
            }
        }, timeoutSecs * 1000);

        proc.stdout.on("data", (chunk: Buffer) => {
            if (chunk.toString().includes('"id":2') && !resolved) {
                resolved = true;
                clearTimeout(timer);
                proc.kill();
                resolve(true);
            }
        });

        proc.on("error", () => {
            if (!resolved) {
                resolved = true;
                clearTimeout(timer);
                resolve(false);
            }
        });

        proc.stdin.write(
            JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: {
                    protocolVersion: "2024-11-05",
                    capabilities: {},
                    clientInfo: { name: "healthcheck", version: "0.1" },
                },
            }) + "\n",
        );
        proc.stdin.write(
            JSON.stringify({
                jsonrpc: "2.0",
                method: "notifications/initialized",
            }) + "\n",
        );
        proc.stdin.write(
            JSON.stringify({
                jsonrpc: "2.0",
                id: 2,
                method: "tools/call",
                params: { name: "get_studio_mode", arguments: {} },
            }) + "\n",
        );
    });
}

// ── Tool summarizer (from parse-bloxgen-log.ts) ──────────────────────
function summarizeTool(name: string, input: Record<string, any>): string {
    switch (name) {
        case "Read":
            return `[Read] ${input.file_path ?? ""}`;
        case "Write":
            return `[Write] ${input.file_path ?? ""}`;
        case "Edit":
            return `[Edit] ${input.file_path ?? ""}`;
        case "Grep":
        case "Glob":
            return `[${name}] ${input.pattern ?? ""}`;
        case "Bash": {
            let cmd = input.command ?? "";
            if (cmd.length > 80) cmd = cmd.slice(0, 77) + "...";
            return `[Bash] ${cmd}`;
        }
        case "Agent":
            return `[Agent] ${input.description ?? ""}`;
        case "TodoWrite":
            return `[TodoWrite]`;
        default:
            return `[${name}]`;
    }
}

// ── Prompts (copied from bloxgen.sh) ─────────────────────────────────
const BUILD_PROMPT = `You are operating in autonomous feature-development mode (Bloxgen Loop).
Your job: implement features and fixes from the project, then exit cleanly.

Follow this 13-step workflow EXACTLY.
IMPORTANT: At the START of each step, output the marker line exactly as shown (e.g. BLOXGEN_STEP: 1-PICK).
This is used for live progress tracking — do not skip or alter the format.

## Step 1 — PICK
BLOXGEN_STEP: 1-PICK
- Read knowledge/GDD.md — this is the game design overview; keep the vision and progression in mind throughout
- If GDD.md is empty or has no content beyond the template, read knowledge/GAME_IDEA.md and create a GDD from it (concept, core loop, progression, systems, currencies). Then continue.
- Read knowledge/TODO.md
- Read knowledge/TASK_GUIDE.md to understand task conventions
- Find the FIRST row in the Feature Queue whose Status is "planned"
- If no planned features remain, say so and exit
- Note the feature ID, progression step, and systems list

### Batching easy tasks
After picking the first task, check if it is a BUG-* entry with Est. Complexity "easy" or "haiku".
If so, scan the remaining planned rows and collect ALL additional BUG-* entries that are
also "easy"/"haiku" (up to 4 total tasks in the batch). These will be implemented together in a
single session. Non-bug features or medium/hard tasks are always done solo — pick only one.

For batched tasks, run Steps 2–12 for EACH task in sequence (finish one completely before
starting the next). Output BLOXGEN_STEP markers with the task ID, e.g.:
  BLOXGEN_STEP: 6-BUILD (BUG-006)
At the end, output one BLOXGEN: COMPLETED line per task.

## Step 2 — RESEARCH
BLOXGEN_STEP: 2-RESEARCH
- Read knowledge/SOLVED_ISSUES.md
- Search for entries whose Systems tags overlap with the feature's systems
- Note any relevant pitfalls or patterns

## Step 3 — ANALYZE
BLOXGEN_STEP: 3-ANALYZE
- Read the source files for every system the feature touches
- Read existing tests for those systems to understand testing patterns
- Read .claude/CONVENTIONS.md and .claude/RULES.md

## Step 4 — PLAN
BLOXGEN_STEP: 4-PLAN
- Write a detailed implementation plan as a new section in plan.md
- List every file you will create or modify
- List the GameState schema changes, InputBridge registrations
- List the progression step validators and test cases (Lune + Studio)

## Step 5 — REVIEW (gate — do not proceed if any check fails)
BLOXGEN_STEP: 5-REVIEW
- Check your plan against EVERY item in .claude/RULES.md Review Checklist:
  - Input Abstraction: no direct input connections
  - State Ownership: all state in GameState schema
  - Serializable: state captured by Serialize/Load
  - Progression Aware: feature knows its step, has validator, respects prerequisites
  - Dual Tested: at least one Lune test + one Studio test planned
  - No Hardcoded Players: no LocalPlayer refs in game logic
  - Documented: GDD entry planned
  - Regression Clean: plan does not break existing tests
- If any check fails, revise the plan before continuing

## Step 6 — BUILD
BLOXGEN_STEP: 6-BUILD
- Implement the feature following .claude/CONVENTIONS.md
- Use --!strict on all Luau files
- Route all input through InputBridge
- Store all state in GameState schema
- Check syntax on every .luau file you create or modify using the check_luau_syntax tool

## Step 7 — TEST-L (Lune tests)
BLOXGEN_STEP: 7-TEST-L
- Read knowledge/GUIDE_LUNE.md for simulation conventions and patterns
- Write Lune tests in tests/lune/suites/<Feature>_test.luau
- Run them with the run_lune_tests tool
- Iterate until ALL pass. Do not proceed until green.

## Step 8 — TEST-S (Studio tests)
BLOXGEN_STEP: 8-TEST-S
- Read knowledge/GUIDE_TESTEZ.md for spec file conventions and required test categories
- Write Studio tests in tests/studio/suites/<Feature>.spec.luau
- Run them with the run_studio_tests tool
- Iterate until ALL pass. Do not proceed until green.

## Step 9 — REGRESS
BLOXGEN_STEP: 9-REGRESS
- Run the full regression suite with the run_regression tool
- Fix any breakages. Never delete a snapshot or skip a failing test.

## Step 9.5 — PLAYTEST (visual smoke test)
BLOXGEN_STEP: 9.5-PLAYTEST
- First, decide: does this feature have ANY visual impact (new GUI, changed UI, world objects, HUD changes)?
  If NOT (e.g. pure backend fix, test-only change, sim tuning, data-only change), SKIP this step entirely and proceed to Step 10.
- Read knowledge/GUIDE_PLAYTESTS.md for playtest conventions and the 3-minute rule
- Find an existing playtest script in tests/studio/playtests/ to learn the format:
  - Scripts use -- @screenshot <name> markers to split into phases
  - Available locals: gameState, inputBridge, player
  - Use inputBridge:Inject("<ActionName>", { player = player, ... }) to simulate input
  - Use gameState:GetPlayerState/SetPlayerState to read/manipulate state
  - Variables persist across phases (no do...end wrapping)
- Write a playtest at tests/studio/playtests/<FeatureId>.luau that:
  - Drives the feature's happy path using the registered InputBridge actions
  - Has at least 2 -- @screenshot markers: before and after the key feature action
  - Adds -- VERIFY: comments before each screenshot describing what to check visually
- Run it with the run_playtest tool, passing the script path
  - Screenshots are saved to .claude/playtest-screenshots/<FeatureId>/<milestone>.png
- Spawn a SCREENSHOT REVIEW subagent using the Agent tool with this prompt:

  You are reviewing playtest screenshots for feature <FEATURE_ID> — <FEATURE_NAME>.

  ## 1. Read the playtest script
  Read tests/studio/playtests/<FeatureId>.luau to understand what the test does.
  Note each -- VERIFY: comment and the -- @screenshot milestone it precedes.

  ## 2. For EACH milestone screenshot, do these steps IN ORDER:

  a) PREDICT: Based on the VERIFY comment and your understanding of the game,
     describe what you expect the screenshot to look like BEFORE you see it.
     Be specific: what UI elements should be visible? What text/numbers?
     Where on screen should things appear?

  b) LOOK: Use the Read tool to open .claude/playtest-screenshots/<FeatureId>/<milestone>.png

  c) ANALYZE: Compare what you see to your prediction. Consider:
     - Is the expected UI visible and correctly positioned?
     - Does text content match expectations (counts, labels, levels)?
     - Is there invisible/missing UI that should be shown?
     - Is UI in a reasonable screen location (not clipped, overlapping, or tiny)?
     - Could any mismatch be a TIMING issue (screenshot taken too early/late)
       rather than an actual bug?

  d) VERDICT: State PASS or FAIL with specific reasoning.

  ## 3. Design review (on the LAST screenshot only)
  After completing all milestone checks, review the final screenshot for
  overall UI/UX quality. Check for:
  - UI overlapping or obscuring core gameplay elements (e.g. panels covering
    the main interactive object)
  - Cluttered or poorly spaced layouts that will scale badly as features grow
  - Inconsistent visual style (mismatched colors, button styles, font sizes)
  - Missing affordances (clickable things that don't look clickable, disabled
    buttons with no explanation)
  - Text that is unclear or ambiguous to a new player
  - Poor use of screen real estate (everything crammed in one area while
    other areas are empty)

  Rate the design: GOOD, NEEDS_WORK, or POOR.
  If NEEDS_WORK or POOR, list specific actionable fixes (max 3).

  ## 4. Output format (use exactly this):
  SCREENSHOT_REVIEW_START
  milestone: <name>
  prediction: <what you expected>
  observation: <what you see>
  verdict: PASS|FAIL
  reasoning: <explanation — note if timing issue vs real bug>
  ---
  (repeat for each milestone)
  DESIGN_REVIEW
  rating: GOOD|NEEDS_WORK|POOR
  issues:
  - <issue and fix> (omit section if GOOD)
  SCREENSHOT_REVIEW_END
  overall: PASS|FAIL
  design: GOOD|NEEDS_WORK|POOR
  summary: <one sentence>

- Parse the subagent's response:
  - If overall FAIL: read the reasoning, fix the issue, re-run playtest + review, max 3 attempts
  - After 3 failures: output BLOXGEN: PLAYTEST STUCK — <subagent's summary>, then continue to Step 10
  - If overall PASS but design is NEEDS_WORK or POOR: fix the listed design issues, re-run playtest + review (counts toward the same 3-attempt limit)
  - If overall PASS and design is GOOD: proceed to Step 10

## Step 10 — DOCUMENT
BLOXGEN_STEP: 10-DOCUMENT
- Add or update the feature entry in knowledge/GDD.md
- Fill in ALL fields: ID, Progression Location, Rationale, Behavior,
  Systems Touched, Dependencies, Inputs, State Changes, Status

## Step 11 — SNAPSHOT
BLOXGEN_STEP: 11-SNAPSHOT
- If the feature has a progression step, save a GameState snapshot at
  src/shared/GameState/Snapshots/<step_id>.json
- The snapshot must pass the step's validator

## Step 12 — UPDATE
BLOXGEN_STEP: 12-UPDATE
- Update knowledge/TODO.md: set the feature's Status to "implemented"
- Register all new tests in tests/manifest.json
- If you encountered issues, add them to knowledge/SOLVED_ISSUES.md

When finished, output one line per completed task: BLOXGEN: COMPLETED <FEATURE_ID> — <feature name>
If you batched multiple tasks, output a COMPLETED line for each one that succeeded.
If stuck for more than 3 attempts on any step, output: BLOXGEN: STUCK — <reason>
If one task in a batch gets stuck, skip it (output BLOXGEN: STUCK for that task) and continue with the remaining tasks.`;

const IDEATE_PROMPT = `You are operating in autonomous feature-ideation mode (Bloxgen Loop — Ideation Phase).
The feature queue is running low. Your job: dream up 3–5 NEW features and add them to TODO.md.
IMPORTANT: At the START of each step, output the marker line exactly as shown (e.g. BLOXGEN_STEP: 1-GUIDE).
This is used for live progress tracking — do not skip or alter the format.

## Step 1 — READ THE GUIDE
BLOXGEN_STEP: 1-GUIDE
- Read knowledge/TASK_GUIDE.md — this is the authoritative reference for task creation
- Follow its ID conventions, required fields, and progression rules exactly

## Step 2 — CONTEXT
BLOXGEN_STEP: 2-CONTEXT
- Read knowledge/GDD.md — this is the game design overview; all new features must serve this vision
- If GDD.md is empty or has no content beyond the template, read knowledge/GAME_IDEA.md and create a GDD from it (concept, core loop, progression, systems, currencies). Then continue.
- Read knowledge/FEATURES.md to understand all implemented features
- Read knowledge/TODO.md to see what's been done and current progression steps
- Read src/shared/Progression/Steps.luau to see the progression timeline
- Read .claude/RULES.md and .claude/CONVENTIONS.md

## Step 3 — IDEATE
BLOXGEN_STEP: 3-IDEATE
Think about what the game needs next. Use the categories from the Task Guide:
- Gameplay depth (prestige, new currencies, achievements)
- Player experience (UI polish, animations, sound effects)
- Progression (new milestones, areas, bosses, challenges)
- Economy (shops, trading, pricing curves, resource sinks)
- Social (leaderboards, multiplayer interactions, gifting)
- Infrastructure (performance, analytics, save/load)
- Use the search_roblox_assets tool to browse for assets if your ideas need them

Generate 3–5 concrete feature ideas. Each must have:
- Clear name and description
- Progression step (existing or new)
- Systems touched
- Estimated complexity (easy / medium / hard)
- No dependencies on unimplemented features

## Step 4 — PRIORITIZE
BLOXGEN_STEP: 4-PRIORITIZE
Order by: dependencies first, then impact, then complexity.

## Step 5 — UPDATE TODO
BLOXGEN_STEP: 5-UPDATE-TODO
- Assign new IDs following the guide's ID conventions
- Add rows to the Feature Queue table in knowledge/TODO.md with Status "planned"
- Add new progression steps to src/shared/Progression/Steps.luau if needed
  (each step needs id, name, stepNumber, description, dependencies, and validator)

## Step 6 — UPDATE GDD
BLOXGEN_STEP: 6-UPDATE-GDD
- Add placeholder entries in knowledge/GDD.md for each with Status "planned"
- Fill in all required GDD fields from the template

When finished, output: BLOXGEN: IDEATED <count> features
If stuck, output: BLOXGEN: STUCK — <reason>`;

const CRITIC_PROMPT = `You are operating in autonomous critic-review mode (Bloxgen Loop — Critic Phase).
Time for a quality audit. Follow knowledge/GUIDE_CRITIC.md EXACTLY and produce a full report.
IMPORTANT: At the START of each step, output the marker line exactly as shown (e.g. BLOXGEN_STEP: 1-VISUALS).
This is used for live progress tracking — do not skip or alter the format.
Critic runs may take up to 10 minutes. Be thorough — do not skip areas to save time.

## Step 1 — VISUALS
BLOXGEN_STEP: 1-VISUALS
- Read knowledge/GUIDE_CRITIC.md and knowledge/GUIDE_UI_STANDARDS.md
- Run the critic-visual playtest: run_playtest with tests/studio/playtests/critic-visual.luau
- Review the screenshots for: overlapping panels, too many visible at once, center-screen obstruction, readability
- Use Grep to check src/client/*Gui.luau files for UI standards violations:
  - Missing TweenService usage (no animations)
  - Visible = true/false without tween wrappers
  - Missing MouseEnter/MouseLeave connections on buttons
  - Secondary panels obscuring the primary action (center is fine for the primary interaction itself)
- Score: PASS / WARN / FAIL with specific issues listed

## Step 2 — GAMEPLAY LOOP
BLOXGEN_STEP: 2-GAMEPLAY
- Run run_lune_tests (all strategies)
- Check Casual pacing: no milestone gap >5min (WARN) or >10min (FAIL)
- Check all milestones reachable within 7200s
- Check Casual/Engaged ratio <5x per milestone
- Score: PASS / WARN / FAIL

## Step 3 — TESTS
BLOXGEN_STEP: 3-TESTS
- Run run_studio_tests
- Run run_regression
- Any failure = FAIL, warnings = WARN
- List every failure with test name and error

## Step 4 — SCAFFOLDING
BLOXGEN_STEP: 4-SCAFFOLDING
- Grep src/shared/Features/ for InputBridge violations (ClickDetector, ProximityPrompt, UserInputService, .Activated)
- Grep for rogue state (Instance.new("IntValue"), Instance.new("StringValue"), .SetAttribute)
- Verify all features registered in FeatureRegistry (cross-check Features/init.luau)
- Compare cost formulas: server feature vs client GUI vs Lune SimEngine for key features
- Score: PASS / WARN / FAIL

## Step 5 — LUNE ACCURACY
BLOXGEN_STEP: 5-LUNE
- Audit key SimEngine formulas against actual feature modules (compare all registered features)
- Check SimState fields cover all economy-affecting customData fields in Schema
- Run run_lune_tests and verify milestone timings are reasonable
- Score: PASS / WARN / FAIL

## Step 6 — REPORT & TODO
BLOXGEN_STEP: 6-REPORT
- Print the full critic report in the structured format from GUIDE_CRITIC.md
- For EVERY issue found (FAIL or WARN), add a task to knowledge/TODO.md:
  - FAIL items: add as BUG- entries with priority 0 (Bloxgen must fix these before any new features)
  - WARN items: add as BUG- entries with priority 1
  - Use clear, actionable descriptions (e.g. "BUG-042 | Add hover/click animations to all 21 GUI files | N/A | medium | GUI | planned")
  - Group related issues into single tasks where sensible (e.g. one task for "add button animations to all GUIs" rather than 21 separate tasks)
- Do NOT attempt to fix issues in this step — just log them. The next BUILD iteration will pick them up.
- Read knowledge/TASK_GUIDE.md for the correct TODO.md row format and ID conventions

When finished, output: BLOXGEN: CRITIC_DONE — <PASS_COUNT>/5 areas passed
If stuck, output: BLOXGEN: STUCK — <reason>`;

const REFINE_PROMPT = `## REFINEMENT MODE ACTIVE
You are in REFINEMENT MODE. This changes what you can build or ideate.

Do NOT create new game mechanics, new systems, or new feature concepts.
Instead, focus ONLY on improving what already exists. Good refinement tasks include:
- Fixing open bugs (BUG-XXX) in TODO.md
- User Feedback items in TODO.md (always top priority)
- UI polish — animations, layout, responsive scaling, visual consistency
- Better placeholders — replace placeholder art, text, or assets with polished versions
- Physical feedback — screen shake, haptics, particle effects, juice on interactions
- DataStores — implement persistent data saving using ProfileService
- Tutorial and onboarding improvements
- Code cleanup — dead code, naming consistency, type safety
- Test coverage gaps
- Performance optimization

When ideating: propose refinement tasks (polish, fixes, infrastructure) not new features.
When building: pick refinement tasks from the queue, or if none exist, identify one yourself.
Use your judgment to pick the highest-impact refinement work available.`;

// ── Stream Parser ──────────────────────────────────────────────────
function parseAndBroadcast(raw: string) {
    const trimmed = raw.trim();
    if (!trimmed) return;

    let obj: any;
    try {
        obj = JSON.parse(trimmed);
    } catch {
        return;
    }

    if (obj.type === "system" && obj.subtype === "init") {
        broadcastState();
        return;
    }

    // Capture final result with token usage
    if (obj.type === "result") {
        const usage = obj.usage;
        const modelUsage = obj.modelUsage;
        if (usage || modelUsage) {
            state.tokens.inputTokens =
                (usage?.input_tokens ?? 0) +
                (usage?.cache_creation_input_tokens ?? 0) +
                (usage?.cache_read_input_tokens ?? 0);
            state.tokens.outputTokens = usage?.output_tokens ?? 0;
            state.tokens.cacheReadTokens = usage?.cache_read_input_tokens ?? 0;
            state.tokens.cacheWriteTokens =
                usage?.cache_creation_input_tokens ?? 0;
            state.tokens.costUSD = obj.total_cost_usd ?? 0;
            sessionCostUSD += state.tokens.costUSD;
            state.tokens.numTurns = obj.num_turns ?? 0;
            // Get context window from first model entry
            if (modelUsage) {
                const first = Object.values(modelUsage)[0] as any;
                if (first?.contextWindow)
                    state.tokens.contextWindow = first.contextWindow;
            }
            broadcastState();
        }
        return;
    }

    if (obj.type !== "assistant") return;

    const content = obj.message?.content;
    if (!Array.isArray(content)) return;

    for (const c of content) {
        if (c.type === "text" && c.text?.trim()) {
            broadcast("text", c.text);

            // Check for step markers
            const stepMatch = c.text.match(
                /BLOXGEN_STEP:\s*(\d+\.?\d*-[A-Z_-]+)/,
            );
            if (stepMatch) {
                state.currentStep = stepMatch[1];
                broadcast("step", state.currentStep);
                writeStatus(
                    `#${state.iteration} ${state.mode} — ${state.currentStep}`,
                );
                saveCheckpoint();
                broadcastState();
            }

            // Check for completion signals
            const signals = [
                "BLOXGEN: COMPLETED",
                "BLOXGEN: STUCK",
                "BLOXGEN: IDEATED",
                "BLOXGEN: CRITIC_DONE",
            ];
            for (const signal of signals) {
                if (c.text.includes(signal)) {
                    broadcast("signal", c.text);
                }
            }
        } else if (c.type === "tool_use") {
            broadcast("tool", summarizeTool(c.name ?? "", c.input ?? {}));
        }
    }
}

// ── Run One Iteration ──────────────────────────────────────────────
function runIteration(prompt: string, model?: string): Promise<void> {
    return new Promise((resolve) => {
        const timestamp = formatTimestamp();
        const logFile = path.join(
            LOG_DIR,
            `bloxgen_${timestamp}_iter${state.iteration}.log`,
        );
        state.logFile = logFile;

        fs.mkdirSync(LOG_DIR, { recursive: true });

        const modelLabel = model ? ` | Model: ${model}` : "";
        broadcast(
            "text",
            `\n--- Iteration #${state.iteration} | Mode: ${state.mode}${modelLabel} ---\n`,
        );

        const args = [
            "-p",
            prompt,
            "--allowedTools",
            ALLOWED_TOOLS,
            "--mcp-config",
            MCP_CONFIG,
            "--strict-mcp-config",
            "--verbose",
            "--output-format",
            "stream-json",
        ];
        if (model) args.push("--model", model);

        const claude = spawn("claude", args, {
            cwd: PROJECT_ROOT,
            env: process.env,
            stdio: ["ignore", "pipe", "pipe"],
        });

        broadcast("text", `Spawned claude (PID: ${claude.pid ?? "unknown"})`);

        claudeProcess = claude;
        const logStream = fs.createWriteStream(logFile);

        const rl = createInterface({ input: claude.stdout! });
        rl.on("line", (raw: string) => {
            logStream.write(raw + "\n");
            parseAndBroadcast(raw);
        });

        claude.stderr?.on("data", (chunk: Buffer) => {
            const text = chunk.toString().trim();
            logStream.write(chunk);
            if (text) broadcast("text", `[stderr] ${text}`);
        });

        claude.on("exit", (code) => {
            claudeProcess = null;
            logStream.end();

            broadcast(
                "text",
                `\n--- Iteration #${state.iteration} finished (exit code: ${code}) ---\n`,
            );
            resolve();
        });

        claude.on("error", (err) => {
            claudeProcess = null;
            logStream.end();
            broadcast(
                "signal",
                `ERROR: Failed to spawn claude: ${err.message}`,
            );
            resolve();
        });
    });
}

// ── Main Loop ──────────────────────────────────────────────────────
async function runLoop(resume: boolean) {
    state.status = "running";
    state.startedAt = new Date().toISOString();
    outputBuffer.length = 0; // Clear buffer for new session
    broadcastState();

    if (resume) {
        if (loadCheckpoint()) {
            broadcast(
                "text",
                `Resuming from checkpoint: iteration ${state.iteration}, built ${state.featuresBuilt}, ideated ${state.featuresIdeated}`,
            );
            if (lastCheckpointFeature) {
                broadcast(
                    "text",
                    `Last feature: ${lastCheckpointFeature} (step: ${lastCheckpointStep})`,
                );
            }
            resumeFlag = true;
        } else {
            broadcast("text", "No checkpoint found — starting fresh.");
        }
    } else {
        state.iteration = 0;
        state.featuresBuilt = 0;
        state.featuresIdeated = 0;
        state.currentFeatureId = "";
        state.currentStep = "";
        state.lastMode = "";
        sessionCostUSD = 0;
    }

    // Kill stale MCP processes
    killStaleMcp();

    // Preflight
    broadcast("text", "Running preflight checks...");
    const studioOk = await checkStudioMcp(15);
    broadcast("text", `Studio MCP: ${studioOk ? "OK" : "FAIL"}`);
    if (!studioOk) {
        broadcast(
            "signal",
            "Studio MCP unreachable — open Roblox Studio with the MCP plugin enabled.",
        );
        state.status = "idle";
        state.mode = "IDLE";
        broadcastState();
        return;
    }

    while (state.status === "running" || state.status === "stopping_graceful") {
        state.iteration++;
        state.plannedCount = countPlanned();
        broadcast("signal", "NEW_ITERATION");
        broadcastState();

        // Decide mode
        let currentPrompt: string;
        let modeDetail: string;

        if (
            forceCriticNext ||
            (state.featuresBuilt > 0 &&
                state.featuresBuilt % CRITIC_INTERVAL === 0 &&
                state.lastMode === "BUILD")
        ) {
            state.mode = "CRITIC";
            currentPrompt = CRITIC_PROMPT;
            modeDetail = forceCriticNext
                ? "manual critic requested"
                : `quality audit after ${state.featuresBuilt} builds`;
            state.currentFeatureId = "";
            forceCriticNext = false;
        } else if (state.plannedCount < MIN_PLANNED_FEATURES) {
            state.mode = "IDEATE";
            currentPrompt = IDEATE_PROMPT;
            modeDetail = `only ${state.plannedCount} planned (threshold: ${MIN_PLANNED_FEATURES})`;
            state.currentFeatureId = "";
        } else {
            // Check if we should auto-trigger parallel fix for easy/medium bugs
            const parallelBugs = getParallelBugs();
            if (parallelBugs.length >= 3 && parallelState.phase === "idle") {
                const bugIds = parallelBugs.map((b) => b.id);
                state.mode = "PARALLEL_FIX";
                state.currentFeatureId = bugIds.join(", ");
                modeDetail = `auto-parallel fixing ${parallelBugs.length} bugs: ${bugIds.join(", ")}`;

                state.currentStep = "";
                state.tokens = emptyTokens();
                state.iterationStartedAt = new Date().toISOString();
                broadcast("text", `\nMode: ${state.mode} — ${modeDetail}`);
                writeStatus(
                    `#${state.iteration} ${state.mode} — ${modeDetail}`,
                );
                broadcastState();

                const idsBefore = listPlannedIds();
                await spawnParallelAgents(parallelBugs);

                // Check for graceful stop
                const parallelPostStatus =
                    state.status as BloxgenState["status"];
                if (parallelPostStatus === "stopping_graceful") {
                    broadcast(
                        "text",
                        "\nStopping after parallel fix (graceful stop requested).",
                    );
                    break;
                }
                if (parallelPostStatus !== "running") break;

                // Count what was completed
                const idsAfter = listPlannedIds();
                const newlyBuilt = idsBefore.filter(
                    (id) => !idsAfter.includes(id),
                );
                if (newlyBuilt.length > 0) {
                    state.featuresBuilt += newlyBuilt.length;
                    broadcast(
                        "text",
                        `Parallel fixed: ${newlyBuilt.join(", ")}`,
                    );
                }

                state.plannedCount = countPlanned();
                state.lastMode = state.mode;
                saveCheckpoint();
                broadcastState();
                continue;
            }

            state.mode = "BUILD";
            currentPrompt = BUILD_PROMPT;
            const feat = getFirstPlannedFeature();
            state.currentFeatureId = feat.id;
            state.buildModel = feat.difficulty;
            modeDetail = `next up: ${feat.name} (${feat.difficulty})`;

            // Resume hint injection
            if (resumeFlag && lastCheckpointFeature && lastCheckpointStep) {
                if (feat.id === lastCheckpointFeature) {
                    const hint = `NOTE: A previous session was working on feature ${lastCheckpointFeature} and reached step ${lastCheckpointStep} before being interrupted. Some earlier steps may already be partially completed. Verify existing work before re-doing it — check if files already exist, if tests already pass, etc. Skip steps whose artifacts are already correct.\n\n`;
                    currentPrompt = hint + currentPrompt;
                    broadcast(
                        "text",
                        `Resume hint injected (feature ${lastCheckpointFeature} was at ${lastCheckpointStep})`,
                    );
                }
                resumeFlag = false;
                lastCheckpointFeature = "";
                lastCheckpointStep = "";
            }
        }

        // Refinement mode: inject constraint into BUILD and IDEATE prompts
        if (
            refinementMode &&
            (state.mode === "BUILD" || state.mode === "IDEATE")
        ) {
            currentPrompt = REFINE_PROMPT + "\n\n" + currentPrompt;
            modeDetail += " [REFINEMENT MODE]";
        }

        state.currentStep = "";
        state.tokens = emptyTokens();
        state.iterationStartedAt = new Date().toISOString();
        broadcast("text", `\nMode: ${state.mode} — ${modeDetail}`);
        writeStatus(`#${state.iteration} ${state.mode} — ${modeDetail}`);
        broadcastState();

        // Snapshot before
        const idsBefore = listPlannedIds();

        // Run the iteration with appropriate model
        const iterModel =
            state.mode === "CRITIC"
                ? criticModel
                : state.mode === "BUILD" && state.buildModel
                  ? state.buildModel
                  : undefined;
        await runIteration(currentPrompt, iterModel);

        // Re-read status after async iteration (may have changed)
        const postStatus = state.status as BloxgenState["status"];
        if (postStatus === "stopping_graceful") {
            broadcast(
                "text",
                "\nStopping after iteration (graceful stop requested).",
            );
            break;
        }
        if (postStatus !== "running") break;

        // Detect results
        const idsAfter = listPlannedIds();
        const newlyBuilt = idsBefore.filter((id) => !idsAfter.includes(id));
        const newlyPlanned = idsAfter.filter((id) => !idsBefore.includes(id));

        if (newlyBuilt.length > 0) {
            state.featuresBuilt += newlyBuilt.length;
            broadcast("text", `Built: ${newlyBuilt.join(", ")}`);
        }
        if (newlyPlanned.length > 0) {
            state.featuresIdeated += newlyPlanned.length;
            broadcast("text", `Ideated: ${newlyPlanned.join(", ")}`);
        }
        if (newlyBuilt.length === 0 && newlyPlanned.length === 0) {
            broadcast("text", "No changes detected in TODO.md");
        }

        state.plannedCount = countPlanned();
        state.lastMode = state.mode;
        saveCheckpoint();
        broadcastState();

        // If ideation produced nothing and nothing is planned, game may be complete
        if (
            state.plannedCount === 0 &&
            newlyPlanned.length === 0 &&
            state.mode === "IDEATE"
        ) {
            broadcast(
                "signal",
                "Ideation produced nothing — game may be complete!",
            );
            break;
        }

        // Kill stale MCP between iterations
        killStaleMcp();

        // Post-iteration Studio check
        if (!(await checkStudioMcp(15))) {
            broadcast(
                "signal",
                "Studio MCP unreachable after iteration. Waiting for reconnect...",
            );
            let reconnected = false;
            for (let i = 0; i < 30 && state.status === "running"; i++) {
                await new Promise((r) => setTimeout(r, 10000));
                if (await checkStudioMcp(10)) {
                    reconnected = true;
                    break;
                }
            }
            if (!reconnected) {
                broadcast(
                    "signal",
                    "Studio did not reconnect after 5 minutes. Stopping.",
                );
                break;
            }
            broadcast("text", "Studio reconnected! Resuming...");
            killStaleMcp();
        }

        // Pause between iterations
        if (state.status === "running") {
            broadcast("text", `Next iteration in ${PAUSE_BETWEEN_SECS}s...`);
            await new Promise((r) => setTimeout(r, PAUSE_BETWEEN_SECS * 1000));
        }
    }

    state.status = "idle";
    state.mode = "IDLE";
    state.currentStep = "";
    state.iterationStartedAt = null;
    writeStatus("stopped");
    broadcastState();
}

// ── HTTP Server ────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${PORT}`);

    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

    if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
    }

    // GET / — serve HTML
    if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(DASHBOARD_HTML);
        return;
    }

    // GET /api/state
    if (req.method === "GET" && url.pathname === "/api/state") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(getPublicState()));
        return;
    }

    // GET /api/history — past session summaries
    if (req.method === "GET" && url.pathname === "/api/history") {
        const sessions: any[] = [];
        try {
            const files = fs
                .readdirSync(LOG_DIR)
                .filter((f) => f.endsWith(".log"))
                .sort()
                .reverse();
            for (const file of files.slice(0, 30)) {
                // Read only the last few KB to find the result line
                const fullPath = path.join(LOG_DIR, file);
                const stat = fs.statSync(fullPath);
                const readSize = Math.min(stat.size, 8192);
                const buf = Buffer.alloc(readSize);
                const fd = fs.openSync(fullPath, "r");
                fs.readSync(
                    fd,
                    buf,
                    0,
                    readSize,
                    Math.max(0, stat.size - readSize),
                );
                fs.closeSync(fd);
                const tail = buf.toString("utf-8");

                // Extract timestamp from filename: bloxgen_YYYYMMDD_HHMMSS_iterN.log
                const match = file.match(
                    /bloxgen_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})_iter(\d+)/,
                );
                if (!match) continue;
                const [, y, mo, d, h, mi, s, iter] = match;
                const timestamp = `${y}-${mo}-${d} ${h}:${mi}:${s}`;

                // Find result JSON line
                const resultMatch = tail.match(/\{"type":"result".*$/m);
                if (resultMatch) {
                    try {
                        const result = JSON.parse(resultMatch[0]);
                        sessions.push({
                            file,
                            timestamp,
                            iteration: parseInt(iter),
                            durationMs: result.duration_ms ?? 0,
                            numTurns: result.num_turns ?? 0,
                            costUSD:
                                (result.total_cost_usd ?? 0) /
                                API_TO_PLAN_RATIO,
                            outputTokens: result.usage?.output_tokens ?? 0,
                            cacheReadTokens:
                                result.usage?.cache_read_input_tokens ?? 0,
                            result: (result.result ?? "").slice(0, 200),
                            isError: result.is_error ?? false,
                        });
                    } catch {}
                } else {
                    // No result line — session may have been interrupted
                    sessions.push({
                        file,
                        timestamp,
                        iteration: parseInt(iter),
                        durationMs: 0,
                        numTurns: 0,
                        costUSD: 0,
                        outputTokens: 0,
                        cacheReadTokens: 0,
                        result: "(interrupted)",
                        isError: true,
                    });
                }
            }
        } catch {}
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(sessions));
        return;
    }

    // GET /api/events — SSE
    if (req.method === "GET" && url.pathname === "/api/events") {
        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
        });
        res.write(
            `event: state\ndata: ${JSON.stringify(getPublicState())}\n\n`,
        );
        // Replay buffered output so page reloads see previous events
        for (const entry of outputBuffer) {
            res.write(
                `event: ${entry.event}\ndata: ${JSON.stringify(entry.data)}\n\n`,
            );
        }
        sseClients.add(res);
        req.on("close", () => sseClients.delete(res));
        return;
    }

    // POST /api/start
    if (req.method === "POST" && url.pathname === "/api/start") {
        if (state.status !== "idle") {
            res.writeHead(409, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Already running" }));
            return;
        }
        const resume = url.searchParams.get("resume") === "true";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, resume }));
        // Fire and forget
        runLoop(resume).catch((err) => {
            broadcast("signal", `Loop crashed: ${err.message}`);
            state.status = "idle";
            state.mode = "IDLE";
            broadcastState();
        });
        return;
    }

    // POST /api/critic — queue a critic run as the next iteration
    if (req.method === "POST" && url.pathname === "/api/critic") {
        if (state.status !== "idle") {
            // If running, flag for next iteration; if idle, start with critic
            forceCriticNext = true;
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, queued: true }));
            return;
        }
        // Start loop with critic forced
        forceCriticNext = true;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        runLoop(false).catch((err) => {
            broadcast("signal", `Loop crashed: ${err.message}`);
            state.status = "idle";
            state.mode = "IDLE";
            broadcastState();
        });
        return;
    }

    // POST /api/critic-model — toggle critic model (haiku/sonnet/opus)
    if (req.method === "POST" && url.pathname === "/api/critic-model") {
        let body = "";
        req.on("data", (chunk: Buffer) => {
            body += chunk.toString();
        });
        req.on("end", () => {
            try {
                const { model } = JSON.parse(body);
                if (
                    model === "haiku" ||
                    model === "sonnet" ||
                    model === "opus"
                ) {
                    criticModel = model;
                    broadcast("text", `Critic model set to: ${model}`);
                    broadcastState();
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ ok: true, model: criticModel }));
                } else {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    res.end(
                        JSON.stringify({
                            error: "Invalid model. Use haiku, sonnet, or opus.",
                        }),
                    );
                }
            } catch {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Invalid JSON" }));
            }
        });
        return;
    }

    // POST /api/refinement-mode — toggle refinement mode
    if (req.method === "POST" && url.pathname === "/api/refinement-mode") {
        let body = "";
        req.on("data", (chunk: Buffer) => {
            body += chunk.toString();
        });
        req.on("end", () => {
            try {
                const { enabled } = JSON.parse(body);
                refinementMode = !!enabled;
                saveCheckpoint();
                broadcast(
                    "text",
                    `Refinement mode ${refinementMode ? "enabled" : "disabled"}`,
                );
                broadcastState();
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true, refinementMode }));
            } catch {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Invalid JSON" }));
            }
        });
        return;
    }

    // POST /api/stop
    if (req.method === "POST" && url.pathname === "/api/stop") {
        if (state.status !== "running") {
            res.writeHead(409, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Not running" }));
            return;
        }
        state.status = "stopping";
        broadcastState();
        broadcast("text", "\nStop requested — killing current session...");
        if (claudeProcess) {
            claudeProcess.kill();
        }
        saveCheckpoint();
        writeStatus("stopped (requested)");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
    }

    // POST /api/stop-after — stop after current iteration finishes
    if (req.method === "POST" && url.pathname === "/api/stop-after") {
        if (state.status !== "running") {
            res.writeHead(409, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Not running" }));
            return;
        }
        state.status = "stopping_graceful";
        broadcastState();
        broadcast(
            "text",
            "\nGraceful stop requested — will stop after current iteration finishes.",
        );
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
    }

    // POST /api/kill-mcp — kill stale MCP processes
    if (req.method === "POST" && url.pathname === "/api/kill-mcp") {
        killStaleMcp();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
            JSON.stringify({ ok: true, message: "Stale MCP processes killed" }),
        );
        broadcast("text", "Killed stale MCP processes (manual)");
        return;
    }

    // POST /api/run-sim — run the progression simulator and return JSON results
    if (req.method === "POST" && url.pathname === "/api/run-sim") {
        try {
            const runnerPath = path.join(
                PROJECT_ROOT,
                "tests",
                "lune",
                "runner.luau",
            );
            const output = execSync(`lune run "${runnerPath}" -- --json`, {
                cwd: PROJECT_ROOT,
                encoding: "utf-8",
                timeout: 60000,
            });
            const jsonLine = output
                .split("\n")
                .find((l: string) => l.startsWith("SIMJSON:"));
            if (jsonLine) {
                const data = JSON.parse(jsonLine.slice("SIMJSON:".length));
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify(data));
            } else {
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "No SIMJSON output found" }));
            }
        } catch (err: any) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
        }
        return;
    }

    // GET /api/user-todo — parse USER_TODO.md for tasks, TODO.md for feedback messages
    if (req.method === "GET" && url.pathname === "/api/user-todo") {
        try {
            const tasks: { category: string; text: string; done: boolean }[] =
                [];
            const messages: { id: number; timestamp: string; text: string }[] =
                [];

            // Parse tasks from USER_TODO.md
            try {
                const userContent = fs.readFileSync(USER_TODO_FILE, "utf-8");
                let currentCategory = "";
                for (const rawLine of userContent.split("\n")) {
                    const line = rawLine.replace(/\r$/, "");
                    if (line.startsWith("## ")) {
                        currentCategory = line.replace("## ", "").trim();
                        continue;
                    }
                    const taskMatch = line.match(/^- \[([ x])\] (.+)$/);
                    if (taskMatch && currentCategory) {
                        tasks.push({
                            category: currentCategory,
                            done: taskMatch[1] === "x",
                            text: taskMatch[2].trim(),
                        });
                    }
                }
            } catch {}

            // Parse feedback messages from TODO.md "## User Feedback" section
            try {
                const todoContent = fs.readFileSync(TODO_FILE, "utf-8");
                let inFeedback = false;
                let msgId = 0;
                for (const rawLine of todoContent.split("\n")) {
                    const line = rawLine.replace(/\r$/, "");
                    if (line.startsWith("## User Feedback")) {
                        inFeedback = true;
                        continue;
                    }
                    if (inFeedback && line.startsWith("## ")) {
                        break; // hit next section
                    }
                    if (inFeedback) {
                        if (line.startsWith("Prioritize these")) continue;
                        const msgMatch = line.match(
                            /^- \[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\] (.+)$/,
                        );
                        if (msgMatch) {
                            messages.push({
                                id: msgId++,
                                timestamp: msgMatch[1],
                                text: msgMatch[2],
                            });
                            continue;
                        }
                        const trimmed = line.trim();
                        if (trimmed && trimmed !== "---") {
                            messages.push({
                                id: msgId++,
                                timestamp: "",
                                text: trimmed,
                            });
                        }
                    }
                }
            } catch {}

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ tasks, messages }));
        } catch {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ tasks: [], messages: [] }));
        }
        return;
    }

    // POST /api/user-task-toggle — toggle a task's done state by index
    if (req.method === "POST" && url.pathname === "/api/user-task-toggle") {
        let body = "";
        req.on("data", (chunk: Buffer) => {
            body += chunk.toString();
        });
        req.on("end", () => {
            try {
                const { id } = JSON.parse(body);
                if (typeof id !== "number") {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: "Invalid id" }));
                    return;
                }
                const content = fs.readFileSync(USER_TODO_FILE, "utf-8");
                const lines = content.split("\n");
                let taskIdx = 0;
                let found = false;

                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i].replace(/\r$/, "");
                    const taskMatch = line.match(/^- \[([ x])\] (.+)$/);
                    if (taskMatch) {
                        if (taskIdx === id) {
                            const nowDone = taskMatch[1] === " ";
                            lines[i] = lines[i].replace(
                                /^- \[[ x]\]/,
                                `- [${nowDone ? "x" : " "}]`,
                            );
                            found = true;
                            break;
                        }
                        taskIdx++;
                    }
                }

                if (!found) {
                    res.writeHead(404, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: "Task not found" }));
                    return;
                }
                fs.writeFileSync(USER_TODO_FILE, lines.join("\n"));
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true }));
            } catch (err: any) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: err.message }));
            }
        });
        return;
    }

    // POST /api/user-feedback — append a new timestamped message to TODO.md User Feedback section
    if (req.method === "POST" && url.pathname === "/api/user-feedback") {
        let body = "";
        req.on("data", (chunk: Buffer) => {
            body += chunk.toString();
        });
        req.on("end", () => {
            try {
                const { text } = JSON.parse(body);
                if (!text?.trim()) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: "Empty message" }));
                    return;
                }
                const content = fs.readFileSync(TODO_FILE, "utf-8");
                const lines = content.split("\n");
                const now = new Date();
                const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
                const entry = `- [${ts}] ${text.trim()}`;
                // Find end of User Feedback section (before next ## heading)
                let insertIdx = -1;
                let inFeedback = false;
                for (let i = 0; i < lines.length; i++) {
                    if (
                        lines[i]
                            .replace(/\r$/, "")
                            .startsWith("## User Feedback")
                    ) {
                        inFeedback = true;
                        continue;
                    }
                    if (
                        inFeedback &&
                        lines[i].replace(/\r$/, "").startsWith("## ")
                    ) {
                        insertIdx = i;
                        break;
                    }
                }
                if (insertIdx === -1) {
                    // No next section found, append at end
                    lines.push(entry);
                } else {
                    // Insert before the next section heading (with blank line)
                    lines.splice(insertIdx, 0, entry, "");
                }
                fs.writeFileSync(TODO_FILE, lines.join("\n"));
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true, timestamp: ts }));
            } catch (err: any) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: err.message }));
            }
        });
        return;
    }

    // PUT /api/user-feedback — update a specific message by id in TODO.md User Feedback section
    if (req.method === "PUT" && url.pathname === "/api/user-feedback") {
        let body = "";
        req.on("data", (chunk: Buffer) => {
            body += chunk.toString();
        });
        req.on("end", () => {
            try {
                const { id, text } = JSON.parse(body);
                if (typeof id !== "number" || !text?.trim()) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    res.end(
                        JSON.stringify({ error: "Invalid id or empty text" }),
                    );
                    return;
                }
                const content = fs.readFileSync(TODO_FILE, "utf-8");
                const lines = content.split("\n");
                let inFeedback = false;
                let msgIdx = 0;
                let found = false;

                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i].replace(/\r$/, "");
                    if (line.startsWith("## User Feedback")) {
                        inFeedback = true;
                        continue;
                    }
                    if (inFeedback && line.startsWith("## ")) break;
                    if (!inFeedback) continue;
                    if (line.startsWith("Prioritize these")) continue;
                    const isMsgLine =
                        line.match(/^- \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] /) ||
                        (line.trim() && line.trim() !== "---");
                    if (isMsgLine) {
                        if (msgIdx === id) {
                            const tsMatch = line.match(
                                /^- \[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\]/,
                            );
                            const ts = tsMatch
                                ? tsMatch[1]
                                : (() => {
                                      const now = new Date();
                                      return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
                                  })();
                            lines[i] = `- [${ts}] ${text.trim()}`;
                            found = true;
                            break;
                        }
                        msgIdx++;
                    }
                }

                if (!found) {
                    res.writeHead(404, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: "Message not found" }));
                    return;
                }
                fs.writeFileSync(TODO_FILE, lines.join("\n"));
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true }));
            } catch (err: any) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: err.message }));
            }
        });
        return;
    }

    // DELETE /api/user-feedback — remove a specific message by id from TODO.md User Feedback section
    if (req.method === "DELETE" && url.pathname === "/api/user-feedback") {
        let body = "";
        req.on("data", (chunk: Buffer) => {
            body += chunk.toString();
        });
        req.on("end", () => {
            try {
                const { id } = JSON.parse(body);
                if (typeof id !== "number") {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: "Invalid id" }));
                    return;
                }
                const content = fs.readFileSync(TODO_FILE, "utf-8");
                const lines = content.split("\n");
                let inFeedback = false;
                let msgIdx = 0;
                let found = false;

                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i].replace(/\r$/, "");
                    if (line.startsWith("## User Feedback")) {
                        inFeedback = true;
                        continue;
                    }
                    if (inFeedback && line.startsWith("## ")) break;
                    if (!inFeedback) continue;
                    if (line.startsWith("Prioritize these")) continue;
                    const isMsgLine =
                        line.match(/^- \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] /) ||
                        (line.trim() && line.trim() !== "---");
                    if (isMsgLine) {
                        if (msgIdx === id) {
                            lines.splice(i, 1);
                            found = true;
                            break;
                        }
                        msgIdx++;
                    }
                }

                if (!found) {
                    res.writeHead(404, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: "Message not found" }));
                    return;
                }
                fs.writeFileSync(TODO_FILE, lines.join("\n"));
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true }));
            } catch (err: any) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: err.message }));
            }
        });
        return;
    }

    // POST /api/chat — Q&A: spawn claude with game context, stream answer, detect bugs
    if (req.method === "POST" && url.pathname === "/api/chat") {
        let body = "";
        req.on("data", (chunk: Buffer) => {
            body += chunk.toString();
        });
        req.on("end", () => {
            try {
                const { question } = JSON.parse(body);
                if (!question?.trim()) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: "Empty question" }));
                    return;
                }

                res.writeHead(200, {
                    "Content-Type": "text/plain; charset=utf-8",
                    "Transfer-Encoding": "chunked",
                    "Cache-Control": "no-cache",
                });

                let featuresContent = "",
                    gddContent = "",
                    todoContent = "";
                try {
                    featuresContent = fs.readFileSync(FEATURES_FILE, "utf-8");
                } catch {}
                try {
                    gddContent = fs.readFileSync(GDD_FILE, "utf-8");
                } catch {}
                try {
                    todoContent = fs.readFileSync(TODO_FILE, "utf-8");
                } catch {}

                const nextBugId = getNextBugId();

                const chatPrompt = `You are a knowledgeable assistant for a Roblox incremental simulator game called "Spear Training". Answer the user's question based on the game's current state.

## Game Design Document
${gddContent}

## Implemented Features
${featuresContent}

## Current Bug/Feature Tracker
${todoContent}

## Instructions

1. Answer the user's question accurately based on the above game knowledge.
2. If the user's question describes something that appears to be a bug or broken behavior:
   - Explain what the expected behavior should be
   - Tell the user this appears to be a bug
   - Output a structured bug marker on its own line in EXACTLY this format:
     BLOXGEN_BUG: {"id": "${nextBugId}", "description": "concise bug description", "severity": "low|medium|high", "systems": "SystemA, SystemB"}
   - Severity: "high" for gameplay-breaking, "medium" for noticeable issues, "low" for cosmetic/minor
   - Systems: GUI, GameState, InputBridge, Testing, Progression, ModifierRegistry, Physics
3. If the question is NOT about a bug, just answer helpfully. Do NOT output a bug marker.
4. Keep answers concise (2-4 paragraphs max).
5. Do not mention the bug marker format to the user.

## User Question
${question}`;

                const claude = spawn(
                    "claude",
                    [
                        "-p",
                        chatPrompt,
                        "--allowedTools",
                        "Read,Glob,Grep",
                        "--verbose",
                        "--output-format",
                        "stream-json",
                    ],
                    {
                        cwd: PROJECT_ROOT,
                        env: process.env,
                        stdio: ["ignore", "pipe", "pipe"],
                    },
                );

                let bugDetected: {
                    id: string;
                    description: string;
                    severity: string;
                    systems: string;
                } | null = null;

                const rl = createInterface({ input: claude.stdout! });
                rl.on("line", (raw: string) => {
                    const trimmed = raw.trim();
                    if (!trimmed) return;

                    let obj: any;
                    try {
                        obj = JSON.parse(trimmed);
                    } catch {
                        return;
                    }

                    if (obj.type !== "assistant") return;
                    const content = obj.message?.content;
                    if (!Array.isArray(content)) return;

                    for (const c of content) {
                        if (c.type === "text" && c.text?.trim()) {
                            const bugMatch = c.text.match(
                                /BLOXGEN_BUG:\s*(\{.*\})/,
                            );
                            if (bugMatch) {
                                try {
                                    bugDetected = JSON.parse(bugMatch[1]);
                                } catch {}
                                const cleanText = c.text
                                    .replace(/BLOXGEN_BUG:\s*\{.*\}/, "")
                                    .trim();
                                if (cleanText) {
                                    res.write(
                                        JSON.stringify({
                                            type: "text",
                                            data: cleanText,
                                        }) + "\n",
                                    );
                                }
                            } else {
                                res.write(
                                    JSON.stringify({
                                        type: "text",
                                        data: c.text,
                                    }) + "\n",
                                );
                            }
                        }
                    }
                });

                claude.on("exit", () => {
                    if (bugDetected) {
                        appendBugToTodo(
                            bugDetected.id,
                            bugDetected.description,
                            bugDetected.severity,
                            bugDetected.systems,
                        );
                        res.write(
                            JSON.stringify({
                                type: "bug",
                                bugId: bugDetected.id,
                            }) + "\n",
                        );
                    }
                    res.write(JSON.stringify({ type: "done" }) + "\n");
                    res.end();
                });

                claude.on("error", (err) => {
                    res.write(
                        JSON.stringify({ type: "error", data: err.message }) +
                            "\n",
                    );
                    res.end();
                });
            } catch (err: any) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: err.message }));
            }
        });
        return;
    }

    // GET /api/parallel — get parallel agents state
    if (req.method === "GET" && url.pathname === "/api/parallel") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(getParallelPublicState()));
        return;
    }

    // GET /api/parallel/agent-output — get output for a specific agent
    if (req.method === "GET" && url.pathname === "/api/parallel/agent-output") {
        const agentId = url.searchParams.get("id");
        if (agentId === "test") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(parallelState.testOutput));
            return;
        }
        const agent = parallelState.agents.find((a) => a.id === agentId);
        if (!agent) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Agent not found" }));
            return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(agent.output));
        return;
    }

    // POST /api/parallel/start — start parallel bugfix session
    if (req.method === "POST" && url.pathname === "/api/parallel/start") {
        if (parallelState.phase !== "idle") {
            res.writeHead(409, { "Content-Type": "application/json" });
            res.end(
                JSON.stringify({ error: "Parallel session already active" }),
            );
            return;
        }
        let body = "";
        req.on("data", (chunk: Buffer) => {
            body += chunk.toString();
        });
        req.on("end", () => {
            try {
                const { bugIds } = JSON.parse(body);
                if (!Array.isArray(bugIds) || bugIds.length === 0) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    res.end(
                        JSON.stringify({
                            error: "bugIds must be a non-empty array",
                        }),
                    );
                    return;
                }
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true, count: bugIds.length }));
                // Fire and forget
                spawnParallelAgents(bugIds).catch((err) => {
                    broadcast(
                        "signal",
                        `Parallel session crashed: ${err.message}`,
                    );
                    parallelState.phase = "idle";
                    broadcastParallel();
                });
            } catch (err: any) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: err.message }));
            }
        });
        return;
    }

    // POST /api/parallel/stop — stop all parallel agents
    if (req.method === "POST" && url.pathname === "/api/parallel/stop") {
        if (parallelState.phase === "idle") {
            res.writeHead(409, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "No parallel session active" }));
            return;
        }
        stopParallelAgents();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
    }

    // POST /api/parallel/reset — reset parallel state to idle
    if (req.method === "POST" && url.pathname === "/api/parallel/reset") {
        stopParallelAgents();
        parallelState.agents = [];
        parallelState.testOutput = [];
        parallelState.testResult = null;
        parallelState.phase = "idle";
        broadcastParallel();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
    }

    // 404
    res.writeHead(404);
    res.end("Not found");
});

export function startDashboard(port: number = 7377) {
    server.listen(port, () => {
        const url = `http://localhost:${port}`;
        console.log(`Bloxgen Dashboard running at ${url}`);
        console.log(`Project root ${PROJECT_ROOT}`);
        console.log("Press Ctrl+C to stop the server.");

        // Copy URL to clipboard
        try {
            if (process.platform === "darwin") {
                execSync(`echo -n "${url}" | pbcopy`, { timeout: 3000 });
            } else if (process.platform === "win32") {
                execSync(`echo ${url}| clip`, { timeout: 3000 });
            } else {
                execSync(`echo -n "${url}" | xclip -selection clipboard`, {
                    timeout: 3000,
                });
            }
            console.log("(URL copied to clipboard)");
        } catch {}
    });

    process.on("SIGINT", () => {
        console.log("\nShutting down...");
        if (claudeProcess) {
            claudeProcess.kill();
            saveCheckpoint();
        }
        if (parallelState.phase !== "idle") {
            stopParallelAgents();
        }
        server.close();
        process.exit(0);
    });
}
