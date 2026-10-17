import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { exec } from "node:child_process";

function findExistingAncestor(filePath: string): string {
  let curr = path.dirname(filePath);
  while (!fs.existsSync(curr)) {
    const parent = path.dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }
  return curr;
}

export function validateWorkspaceSafePath(workspaceRoot: string, relativePath: string): string {
  const normRoot = path.resolve(workspaceRoot);
  const targetAbs = path.resolve(normRoot, relativePath);

  if (!targetAbs.startsWith(normRoot + path.sep) && targetAbs !== normRoot) {
    throw new Error(`Path traversal detected: '${relativePath}' escapes workspace root`);
  }

  if (fs.existsSync(targetAbs)) {
    const realTarget = fs.realpathSync(targetAbs);
    const realRoot = fs.realpathSync(normRoot);
    if (!realTarget.startsWith(realRoot + path.sep) && realTarget !== realRoot) {
      throw new Error(`Path traversal via symlink/junction detected for '${relativePath}'`);
    }
  } else {
    const ancestor = findExistingAncestor(targetAbs);
    if (fs.existsSync(ancestor)) {
      const realAncestor = fs.realpathSync(ancestor);
      const realRoot = fs.realpathSync(normRoot);
      if (!realAncestor.startsWith(realRoot + path.sep) && realAncestor !== realRoot) {
        throw new Error(`Path traversal via ancestor symlink/junction detected for '${relativePath}'`);
      }
    }
  }
  return targetAbs;
}

export type AllowedLocalToolName =
  | "read_file"
  | "list_files"
  | "search_files"
  | "propose_file_change"
  | "run_tests"
  | "delegate_task"
  | "send_agent_message"
  | "submit_deliverable";

export interface StructuredToolCall {
  id: string;
  tool: AllowedLocalToolName;
  args: Record<string, unknown>;
}

export interface ToolExecutionOutcome {
  callId: string;
  tool: AllowedLocalToolName;
  status: "executed" | "duplicate_skipped" | "pending_approval" | "blocked" | "error";
  output: string;
  approvalPayload?: {
    operation: "create" | "modify" | "delete";
    relativePath: string;
    stagedPath: string;
    baseSha256: string | null;
    stagedSha256: string;
    diff: string;
  };
  deliverableCompleted?: boolean;
}

const ALLOWED_TOOLS = new Set<AllowedLocalToolName>([
  "read_file",
  "list_files",
  "search_files",
  "propose_file_change",
  "run_tests",
  "delegate_task",
  "send_agent_message",
  "submit_deliverable",
]);

function sha256(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * Extracts structured tool calls strictly from ```freellm-tool ... ``` blocks
 * at the end/top-level of a completed model response.
 * Ignores quoted examples (`> ```freellm-tool`) to prevent accidental execution.
 */
export function extractStructuredToolCalls(completedResponse: string): StructuredToolCall[] {
  const calls: StructuredToolCall[] = [];
  if (!completedResponse || !completedResponse.includes("```freellm-tool")) {
    return calls;
  }

  // Strip blockquoted lines (`> ...`) so quoted documentation examples never trigger tools
  const unquotedLines = completedResponse
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith(">"))
    .join("\n");

  const regex = /```freellm-tool\s*\r?\n([\s\S]*?)\r?\n```/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(unquotedLines)) !== null) {
    const rawJson = match[1]?.trim();
    if (!rawJson) continue;
    try {
      const parsed = JSON.parse(rawJson);
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof parsed.id === "string" &&
        parsed.id.trim().length > 0 &&
        typeof parsed.tool === "string" &&
        ALLOWED_TOOLS.has(parsed.tool as AllowedLocalToolName) &&
        parsed.args &&
        typeof parsed.args === "object" &&
        !Array.isArray(parsed.args)
      ) {
        calls.push({
          id: parsed.id.trim(),
          tool: parsed.tool as AllowedLocalToolName,
          args: parsed.args as Record<string, unknown>,
        });
      }
    } catch {
      // Malformed tool block is ignored safely
    }
  }

  return calls;
}

/**
 * Persistent Ledger of executed tool call IDs to prevent duplicate side effects after crash/restart.
 */
export class ToolCallLedger {
  private ledgerPath: string;
  private records = new Map<string, ToolExecutionOutcome>();

  constructor(storageDir: string) {
    fs.mkdirSync(storageDir, { recursive: true });
    this.ledgerPath = path.resolve(storageDir, "tool-call-ledger.json");
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.ledgerPath)) {
        const items = JSON.parse(fs.readFileSync(this.ledgerPath, "utf8"));
        if (Array.isArray(items)) {
          for (const item of items) {
            if (item && typeof item.callId === "string") {
              this.records.set(item.callId, item);
            }
          }
        }
      }
    } catch {}
  }

  private save(): void {
    try {
      const tmp = `${this.ledgerPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(Array.from(this.records.values()), null, 2), "utf8");
      fs.renameSync(tmp, this.ledgerPath);
    } catch {}
  }

  get(callId: string): ToolExecutionOutcome | undefined {
    return this.records.get(callId);
  }

  record(outcome: ToolExecutionOutcome): void {
    this.records.set(outcome.callId, outcome);
    this.save();
  }
}

export interface LocalToolExecutorOptions {
  workspaceRoot: string;
  stagingDir: string;
  ledger: ToolCallLedger;
  allowedTools?: AllowedLocalToolName[];
  requireApprovalForWrite?: boolean;
  onDelegation?: (args: Record<string, unknown>) => Promise<string>;
  onAgentMessage?: (args: Record<string, unknown>) => Promise<string>;
}

export async function executeStructuredToolCall(
  call: StructuredToolCall,
  options: LocalToolExecutorOptions,
): Promise<ToolExecutionOutcome> {
  // 1. Idempotency / De-duplication check
  const prior = options.ledger.get(call.id);
  if (prior) {
    return {
      ...prior,
      status: "duplicate_skipped",
      output: `[IDEMPOTENT CACHE - Call '${call.id}' was already executed previously]\n${prior.output}`,
    };
  }

  // 2. Permission check
  if (options.allowedTools && !options.allowedTools.includes(call.tool)) {
    const blocked: ToolExecutionOutcome = {
      callId: call.id,
      tool: call.tool,
      status: "blocked",
      output: `Permission denied: Tool '${call.tool}' is not permitted for this agent.`,
    };
    options.ledger.record(blocked);
    return blocked;
  }

  try {
    switch (call.tool) {
      case "read_file": {
        const relPath = String(call.args.path || "").trim();
        if (!relPath) throw new Error("Missing 'path' argument for read_file");
        const targetAbs = validateWorkspaceSafePath(options.workspaceRoot, relPath);
        if (!fs.existsSync(targetAbs)) {
          throw new Error(`File not found: ${relPath}`);
        }
        const stat = fs.statSync(targetAbs);
        if (stat.isDirectory()) {
          throw new Error(`Path is a directory, not a file: ${relPath}`);
        }
        const content = fs.readFileSync(targetAbs, "utf8");
        const fileHash = sha256(content);
        const startLine = Number(call.args.startLine) || 1;
        const endLine = Number(call.args.endLine) || 400;
        const lines = content.split(/\r?\n/);
        const sliced = lines.slice(Math.max(0, startLine - 1), endLine).join("\n");

        const outcome: ToolExecutionOutcome = {
          callId: call.id,
          tool: call.tool,
          status: "executed",
          output: `File: ${relPath} (SHA256: ${fileHash}, Lines ${startLine}-${Math.min(endLine, lines.length)} of ${lines.length})\n---\n${sliced}`,
        };
        options.ledger.record(outcome);
        return outcome;
      }

      case "list_files": {
        const relDir = String(call.args.path || ".").trim();
        const targetAbs = validateWorkspaceSafePath(options.workspaceRoot, relDir);
        if (!fs.existsSync(targetAbs)) {
          throw new Error(`Directory not found: ${relDir}`);
        }
        const entries = fs.readdirSync(targetAbs, { withFileTypes: true });
        const formatted = entries
          .filter((e) => !e.name.startsWith(".git") && e.name !== "node_modules")
          .slice(0, 200)
          .map((e) => `${e.isDirectory() ? "[DIR] " : "[FILE]"} ${e.name}`)
          .join("\n");

        const outcome: ToolExecutionOutcome = {
          callId: call.id,
          tool: call.tool,
          status: "executed",
          output: `Directory listing for '${relDir}':\n${formatted || "(empty)"}`,
        };
        options.ledger.record(outcome);
        return outcome;
      }

      case "search_files": {
        const query = String(call.args.query || "").trim();
        const relDir = String(call.args.path || ".").trim();
        if (!query) throw new Error("Missing 'query' argument for search_files");
        const targetAbs = validateWorkspaceSafePath(options.workspaceRoot, relDir);

        const matches: string[] = [];
        const walk = (dir: string) => {
          if (matches.length >= 50) return;
          const items = fs.readdirSync(dir, { withFileTypes: true });
          for (const item of items) {
            if (matches.length >= 50) break;
            if (item.name === "node_modules" || item.name === ".git" || item.name === "dist") continue;
            const full = path.join(dir, item.name);
            if (item.isDirectory()) {
              walk(full);
            } else if (item.isFile()) {
              try {
                const stat = fs.statSync(full);
                if (stat.size > 512 * 1024) continue;
                const text = fs.readFileSync(full, "utf8");
                const lines = text.split(/\r?\n/);
                lines.forEach((line, idx) => {
                  if (matches.length < 50 && line.includes(query)) {
                    const rel = path.relative(options.workspaceRoot, full);
                    matches.push(`${rel}:${idx + 1}: ${line.trim().slice(0, 160)}`);
                  }
                });
              } catch {}
            }
          }
        };
        walk(targetAbs);

        const outcome: ToolExecutionOutcome = {
          callId: call.id,
          tool: call.tool,
          status: "executed",
          output: matches.length > 0 ? matches.join("\n") : `No matches found for '${query}'`,
        };
        options.ledger.record(outcome);
        return outcome;
      }

      case "propose_file_change": {
        const operation = String(call.args.operation || "modify") as "create" | "modify" | "delete";
        const relPath = String(call.args.path || "").trim();
        const content = typeof call.args.content === "string" ? call.args.content : "";
        if (!relPath) throw new Error("Missing 'path' in propose_file_change");

        const targetAbs = validateWorkspaceSafePath(options.workspaceRoot, relPath);
        const exists = fs.existsSync(targetAbs);

        if (operation === "create" && exists) {
          throw new Error(`Cannot create '${relPath}': file already exists.`);
        }
        if ((operation === "modify" || operation === "delete") && !exists) {
          throw new Error(`Cannot ${operation} '${relPath}': file does not exist.`);
        }

        const baseContent = exists ? fs.readFileSync(targetAbs, "utf8") : null;
        const baseSha256 = baseContent !== null ? sha256(baseContent) : null;

        fs.mkdirSync(options.stagingDir, { recursive: true });
        const stagedPath = path.resolve(
          options.stagingDir,
          `staged-${call.id.replace(/[^a-zA-Z0-9_-]/g, "_")}-${Date.now()}.tmp`,
        );
        fs.writeFileSync(stagedPath, content, "utf8");
        const stagedSha256 = sha256(content);

        const diffPreview =
          operation === "delete"
            ? `--- ${relPath}\n+++ /dev/null`
            : `--- ${relPath} (base: ${baseSha256?.slice(0, 8) || "new"})\n+++ ${relPath} (staged: ${stagedSha256.slice(0, 8)})`;

        if (options.requireApprovalForWrite !== false) {
          const outcome: ToolExecutionOutcome = {
            callId: call.id,
            tool: call.tool,
            status: "pending_approval",
            output: `Staged ${operation} on '${relPath}' (baseSha256: ${baseSha256 || "none"}, stagedSha256: ${stagedSha256}). Awaiting operator/merge approval.`,
            approvalPayload: {
              operation,
              relativePath: relPath,
              stagedPath,
              baseSha256,
              stagedSha256,
              diff: diffPreview,
            },
          };
          options.ledger.record(outcome);
          return outcome;
        } else {
          if (operation === "delete") {
            fs.rmSync(targetAbs, { force: true });
          } else {
            fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
            fs.writeFileSync(targetAbs, content, "utf8");
          }
          try {
            fs.rmSync(stagedPath, { force: true });
          } catch {}

          const outcome: ToolExecutionOutcome = {
            callId: call.id,
            tool: call.tool,
            status: "executed",
            output: `Applied ${operation} to '${relPath}' (SHA256: ${stagedSha256}).`,
          };
          options.ledger.record(outcome);
          return outcome;
        }
      }

      case "run_tests": {
        const command = String(call.args.command || "npm test").trim();
        if (/[;&|`$]|\b(rm|del|format|shutdown|reboot|git\s+push)\b/i.test(command)) {
          throw new Error(`Command rejected by safety policy: ${command}`);
        }

        const output = await new Promise<string>((resolve) => {
          exec(
            command,
            { cwd: options.workspaceRoot, timeout: 60000, maxBuffer: 1024 * 1024 },
            (error, stdout, stderr) => {
              const combined = `${stdout || ""}\n${stderr || ""}`.trim();
              if (error) {
                resolve(`Exit code ${error.code ?? 1}:\n${combined.slice(0, 4000)}`);
              } else {
                resolve(`Exit code 0 (PASS):\n${combined.slice(0, 4000)}`);
              }
            },
          );
        });

        const outcome: ToolExecutionOutcome = {
          callId: call.id,
          tool: call.tool,
          status: "executed",
          output,
        };
        options.ledger.record(outcome);
        return outcome;
      }

      case "delegate_task": {
        const resText = options.onDelegation
          ? await options.onDelegation(call.args)
          : `Delegated task '${String(call.args.title || "Subtask")}' queued.`;
        const outcome: ToolExecutionOutcome = {
          callId: call.id,
          tool: call.tool,
          status: "executed",
          output: resText,
        };
        options.ledger.record(outcome);
        return outcome;
      }

      case "send_agent_message": {
        const resText = options.onAgentMessage
          ? await options.onAgentMessage(call.args)
          : `Internal message sent to '${String(call.args.toAgent || "team")}'.`;
        const outcome: ToolExecutionOutcome = {
          callId: call.id,
          tool: call.tool,
          status: "executed",
          output: resText,
        };
        options.ledger.record(outcome);
        return outcome;
      }

      case "submit_deliverable": {
        const summary = String(call.args.summary || "Deliverable submitted.").trim();
        const outcome: ToolExecutionOutcome = {
          callId: call.id,
          tool: call.tool,
          status: "executed",
          output: `Deliverable recorded: ${summary}`,
          deliverableCompleted: true,
        };
        options.ledger.record(outcome);
        return outcome;
      }
    }
  } catch (err: any) {
    const errOutcome: ToolExecutionOutcome = {
      callId: call.id,
      tool: call.tool,
      status: "error",
      output: `Tool Error (${call.tool}): ${err.message}`,
    };
    options.ledger.record(errOutcome);
    return errOutcome;
  }
}

export function buildAgentInitializationPrompt(params: {
  agentId: string;
  agentName: string;
  role: string;
  title?: string;
  reportsTo?: string | null;
  customInstructions?: string;
  projectSummary?: string;
  taskTitle?: string;
  taskDescription?: string;
}): string {
  const parts: string[] = [
    `# Agent Identity`,
    `- Name: ${params.agentName} (ID: ${params.agentId})`,
    `- Role: ${params.role}${params.title ? ` — ${params.title}` : ""}`,
    params.reportsTo ? `- Reports To: ${params.reportsTo}` : `- Reports To: Project Lead / Operator`,
  ];

  if (params.customInstructions) {
    parts.push(`\n# Role Instructions\n${params.customInstructions}`);
  }

  const isCeo = params.role.toLowerCase() === "ceo" || params.agentName.toLowerCase().includes("ceo");
  if (isCeo) {
    parts.push(`
# Executive Authority & Delegation Protocol (CEO)
As the Chief Executive Officer (CEO), you have full authority to recruit specialists, create new agents, and assign tasks to them.
CRITICAL INSTRUCTION: When the user asks you to create, hire, or design an agent, or set up a team member:
1. Do NOT just give a conversational answer like "I will create it" without providing the structured creation block.
2. Formulate the optimal specialist agent role, specialized system prompt, and best model.
3. ALWAYS output a structured \`\`\`json\`\`\` code block with \`"action": "create_agent"\` and an assigned \`"task"\`:

\`\`\`json
{
  "action": "create_agent",
  "name": "اسم الوكيل",
  "role": "engineer",
  "title": "المسمى الوظيفي",
  "model": "deepseek-normal",
  "systemPrompt": "التعليمات والمهام التفصيلية المخصصة لهذا الوكيل...",
  "task": {
    "title": "عنوان المهمة الأولى المطلوب منه تنفيذها",
    "description": "تفاصيل المهمة ومتطلبات التسليم"
  }
}
\`\`\`

When this block is output, the system creates the agent and registers their assigned task in the workspace immediately.`);
  }

  if (params.projectSummary) {
    parts.push(`\n# Project Context\n${params.projectSummary}`);
  }

  if (params.taskTitle || params.taskDescription) {
    parts.push(
      `\n# Assigned Task\nTitle: ${params.taskTitle || "Workspace Task"}\n${params.taskDescription || ""}`,
    );
  }

  parts.push(`
# Local Tool Execution Protocol
When you need to inspect files, search code, propose file edits, run tests, message a teammate, or submit your final deliverable, emit a \`\`\`freellm-tool\`\`\` JSON block with a unique \`id\`, \`tool\`, and \`args\`:

\`\`\`freellm-tool
{
  "id": "call_unique_01",
  "tool": "read_file",
  "args": { "path": "src/index.ts", "startLine": 1, "endLine": 100 }
}
\`\`\`

Available tools:
- \`read_file\`: \`{ "path": "relative/path", "startLine"?: 1, "endLine"?: 200 }\`
- \`list_files\`: \`{ "path": "." }\`
- \`search_files\`: \`{ "query": "searchTerm", "path"?: "." }\`
- \`propose_file_change\`: \`{ "operation": "create" | "modify" | "delete", "path": "relative/path", "content"?: "full file content" }\`
- \`run_tests\`: \`{ "command": "npm test" }\`
- \`send_agent_message\`: \`{ "toAgent": "agentIdOrRole", "messageType": "question" | "blocker" | "review_request" | "handoff", "content": "..." }\`
- \`submit_deliverable\`: \`{ "summary": "...", "filesModified": ["..."], "testsRun": ["..."] }\`

Wait for the system to return \`[TOOL_RESULT]\` before proceeding to the next step.`);

  return parts.join("\n");
}
