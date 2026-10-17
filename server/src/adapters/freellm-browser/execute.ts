import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import { SSEChunkBuffer } from "../../services/freellm-browser-daemon/stream-buffer.js";
import {
  buildAgentInitializationPrompt,
  extractStructuredToolCalls,
  executeStructuredToolCall,
  ToolCallLedger,
} from "../../services/freellm-tool-loop.js";

function getDaemonToken(): string {
  if (process.env.FREELLM_DAEMON_TOKEN) return process.env.FREELLM_DAEMON_TOKEN;
  const tokenPaths = [
    "C:\\Users\\malek\\.freellm-browser-profile\\token.txt",
    path.resolve(process.cwd(), "server/.browser-profile/token.txt"),
    path.resolve(process.cwd(), ".browser-profile/token.txt"),
  ];
  for (const p of tokenPaths) {
    if (fs.existsSync(p)) return fs.readFileSync(p, "utf8").trim();
  }
  return "";
}

function extractPromptFromContext(context: AdapterExecutionContext): string {
  if (context.context?.prompt && typeof context.context.prompt === "string") {
    return context.context.prompt;
  }
  const issue = context.context?.paperclipIssue as Record<string, unknown> | undefined;
  if (issue && (issue.title || issue.description)) {
    const parts: string[] = [];
    if (issue.title) parts.push(`Task: ${issue.title}`);
    if (issue.description) parts.push(`Description:\n${issue.description}`);
    return parts.join("\n\n");
  }
  if (context.agent?.name) {
    return `Hello, I am ${context.agent.name}. Please review the current task and proceed.`;
  }
  return "Proceed with the assigned workspace task.";
}

function extractSystemPromptFromContext(context: AdapterExecutionContext): string {
  const instructionsPath =
    (context.config?.instructionsFilePath as string) ||
    ((context.agent as any)?.adapterConfig as any)?.instructionsFilePath;
  let customInstructions = "";
  if (instructionsPath && fs.existsSync(instructionsPath)) {
    try {
      customInstructions = fs.readFileSync(instructionsPath, "utf8").trim();
    } catch {}
  }

  const issue = context.context?.paperclipIssue as Record<string, unknown> | undefined;
  const agent = context.agent as Record<string, unknown> | undefined;

  return buildAgentInitializationPrompt({
    agentId: String(agent?.id || "agent-default"),
    agentName: String(agent?.name || "Specialist Agent"),
    role: String(agent?.role || "engineer"),
    title: typeof agent?.title === "string" ? agent.title : undefined,
    reportsTo: typeof agent?.reportsTo === "string" ? agent.reportsTo : null,
    customInstructions,
    taskTitle: typeof issue?.title === "string" ? issue.title : undefined,
    taskDescription: typeof issue?.description === "string" ? issue.description : undefined,
  });
}

interface SingleTurnResponse {
  exitCode: number;
  fullResponse: string;
  lastStatus: string | null;
  hasError: boolean;
  errorMessage?: string;
  conversationUrl?: string;
  conversationId?: string;
  isInitialized?: boolean;
  cancelled?: boolean;
}

function dispatchTurnToDaemon(params: {
  daemonPort: number;
  daemonToken: string;
  prompt: string;
  platform: "gemini" | "deepseek" | "arena";
  modelId: string;
  deepThink: boolean;
  sessionId: string;
  agentId?: string;
  issueId?: string;
  projectId?: string;
  companyId?: string;
  systemPrompt?: string;
  context: AdapterExecutionContext;
}): Promise<SingleTurnResponse> {
  return new Promise((resolve) => {
    const postData = JSON.stringify({
      prompt: params.prompt,
      platform: params.platform,
      model: params.modelId,
      deepThink: params.deepThink,
      sessionId: params.sessionId,
      agentId: params.agentId,
      issueId: params.issueId,
      projectId: params.projectId,
      companyId: params.companyId,
      systemPrompt: params.systemPrompt,
    });

    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: params.daemonPort,
        path: "/chat",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postData),
          "x-freellm-auth": params.daemonToken,
        },
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          const errMsg = `Browser Daemon returned HTTP ${res.statusCode}`;
          params.context.onLog("stderr", `[FreeLLM Error] ${errMsg}\n`);
          resolve({
            exitCode: 1,
            fullResponse: "",
            lastStatus: "ERROR",
            hasError: true,
            errorMessage: errMsg,
          });
          return;
        }

        let fullResponse = "";
        let lastStatus: string | null = null;
        let hasError = false;
        let errorMessage: string | undefined;
        let conversationUrl: string | undefined;
        let conversationId: string | undefined;
        let isInitialized: boolean | undefined;

        const sseBuffer = new SSEChunkBuffer();
        const decoder = new TextDecoder("utf-8");

        const processPayload = async (payload: any) => {
          if (payload.type === "token" && payload.text) {
            fullResponse += payload.text;
            await params.context.onLog("stdout", payload.text);
          } else if (payload.type === "replace" && typeof payload.text === "string") {
            fullResponse = payload.text;
            await params.context.onLog("stdout", `\n[Updated Response]: ${payload.text}\n`);
          } else if (payload.type === "thinking") {
            await params.context.onLog("stdout", `[Thinking] ${payload.thinkingText || "..."}\n`);
          } else if (payload.type === "status") {
            lastStatus = payload.status;
            await params.context.onLog("stdout", `\n[Status: ${payload.status}]\n`);
          } else if (payload.type === "session_meta") {
            if (payload.conversationUrl) conversationUrl = payload.conversationUrl;
            if (payload.conversationId) conversationId = payload.conversationId;
            if (typeof payload.isInitialized === "boolean") isInitialized = payload.isInitialized;
          } else if (payload.type === "error") {
            hasError = true;
            errorMessage = payload.message;
            await params.context.onLog("stderr", `[FreeLLM Error] ${payload.message}\n`);
          }
        };

        res.on("data", async (chunkBuffer: Buffer) => {
          const decoded = decoder.decode(chunkBuffer, { stream: true });
          const events = sseBuffer.push(decoded);
          for (const ev of events) {
            await processPayload(ev);
          }
        });

        res.on("end", async () => {
          const remaining = sseBuffer.flush();
          for (const ev of remaining) {
            await processPayload(ev);
          }

          resolve({
            exitCode: hasError && !fullResponse ? 1 : 0,
            fullResponse,
            lastStatus,
            hasError,
            errorMessage,
            conversationUrl,
            conversationId,
            isInitialized,
          });
        });
      },
    );

    req.on("error", async (err) => {
      await params.context.onLog("stderr", `[FreeLLM Error] ${err.message}\n`);
      resolve({
        exitCode: 1,
        fullResponse: "",
        lastStatus: "ERROR",
        hasError: true,
        errorMessage: err.message,
      });
    });

    if (params.context.signal) {
      const onAbort = () => {
        req.destroy();
        try {
          const cancelData = JSON.stringify({
            sessionId: params.sessionId,
            platform: params.platform,
          });
          const cancelReq = http.request({
            hostname: "127.0.0.1",
            port: params.daemonPort,
            path: "/cancel",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(cancelData),
              "x-freellm-auth": params.daemonToken,
            },
          });
          cancelReq.write(cancelData);
          cancelReq.end();
        } catch {}

        resolve({
          exitCode: 130,
          fullResponse: "",
          lastStatus: "CANCELLED",
          hasError: true,
          cancelled: true,
          errorMessage: "Execution cancelled by operator",
        });
      };
      params.context.signal.addEventListener("abort", onAbort, { once: true });
    }

    req.write(postData);
    req.end();
  });
}

export async function execute(
  context: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  const modelId = (context.config?.model as string) || "deepseek-normal";
  const initialPrompt = extractPromptFromContext(context);
  const systemPrompt = extractSystemPromptFromContext(context);

  const platform: "gemini" | "deepseek" | "arena" = modelId.startsWith("gemini")
    ? "gemini"
    : modelId.startsWith("arena")
      ? "arena"
      : "deepseek";
  const deepThink =
    modelId === "deepseek-deepthink" || modelId.includes("thinking") || modelId.includes("r1");

  const daemonPort = Number(process.env.FREELLM_DAEMON_PORT) || 3150;
  const daemonToken = getDaemonToken();

  const issue = context.context?.paperclipIssue as Record<string, unknown> | undefined;
  const agentId = context.agent?.id ? String(context.agent.id) : undefined;
  const issueId = issue?.id ? String(issue.id) : undefined;
  const projectId = issue?.projectId ? String(issue.projectId) : undefined;
  const companyId = issue?.companyId ? String(issue.companyId) : undefined;

  // Bind session deterministically to (agentId + issueId) so each agent task gets an isolated conversation
  const sessionId =
    agentId && issueId
      ? `agent-${agentId}-issue-${issueId}`
      : agentId || issueId || `session-${platform}-${modelId}`;

  const workspaceRoot = context.cwd || process.cwd();
  const storageDir = path.resolve(workspaceRoot, ".freellm-runtime");
  const stagingDir = path.resolve(storageDir, "staging");
  const ledger = new ToolCallLedger(storageDir);

  const maxToolIterations = Number(context.config?.maxToolIterations) || 6;
  let currentPrompt = initialPrompt;
  let finalResponseText = "";
  let lastConversationUrl = "";
  let lastConversationId = "";

  for (let turn = 1; turn <= maxToolIterations; turn++) {
    if (context.signal?.aborted) {
      return {
        exitCode: 130,
        signal: "SIGINT",
        timedOut: false,
        errorMessage: "Execution cancelled by operator",
      };
    }

    await context.onLog(
      "stdout",
      `\n[FreeLLM] Turn ${turn}/${maxToolIterations} -> ${platform} (${modelId}, Session: ${sessionId.slice(0, 18)})...\n`,
    );

    const turnResult = await dispatchTurnToDaemon({
      daemonPort,
      daemonToken,
      prompt: currentPrompt,
      platform,
      modelId,
      deepThink,
      sessionId,
      agentId,
      issueId,
      projectId,
      companyId,
      systemPrompt: turn === 1 ? systemPrompt : undefined,
      context,
    });

    if (turnResult.conversationUrl) lastConversationUrl = turnResult.conversationUrl;
    if (turnResult.conversationId) lastConversationId = turnResult.conversationId;

    if (turnResult.cancelled || turnResult.lastStatus === "CANCELLED") {
      return {
        exitCode: 130,
        signal: "SIGINT",
        timedOut: false,
        errorMessage: "Execution cancelled by operator",
      };
    }

    if (turnResult.lastStatus === "NEEDS_LOGIN") {
      const loginMsg = `${platform} requires login. Please open 'المتصفح' (Browser) in the sidebar to log in to your account.`;
      await context.onLog("stderr", `\n[FreeLLM] ${loginMsg}\n`);
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: loginMsg,
        executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
      };
    }

    if (turnResult.lastStatus === "NEEDS_HUMAN_INTERVENTION") {
      const capMsg =
        "Captcha / Cloudflare verification detected. Browser tab brought to front; please solve the challenge manually.";
      await context.onLog("stderr", `\n[FreeLLM] ${capMsg}\n`);
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: capMsg,
        executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
      };
    }

    if (turnResult.lastStatus === "TIMEOUT") {
      return {
        exitCode: 1,
        signal: null,
        timedOut: true,
        errorMessage: turnResult.errorMessage || "Model response timed out before completion.",
      };
    }

    if (turnResult.exitCode !== 0 && !turnResult.fullResponse) {
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: turnResult.errorMessage || `Failed to generate response from ${platform}.`,
      };
    }

    finalResponseText = turnResult.fullResponse;

    // Extract structured tool calls ONLY after full response completion
    const toolCalls = extractStructuredToolCalls(finalResponseText);
    if (toolCalls.length === 0) {
      break;
    }

    await context.onLog(
      "stdout",
      `\n[FreeLLM Tool Loop] Detected ${toolCalls.length} structured tool call(s).\n`,
    );

    const toolFeedbackBlocks: string[] = [];
    let deliverableDone = false;

    for (const call of toolCalls) {
      if (context.signal?.aborted) {
        return {
          exitCode: 130,
          signal: "SIGINT",
          timedOut: false,
          errorMessage: "Execution cancelled during tool loop",
        };
      }

      await context.onLog("stdout", `[Tool Call ${call.id}] Executing '${call.tool}'...\n`);
      const outcome = await executeStructuredToolCall(call, {
        workspaceRoot,
        stagingDir,
        ledger,
        requireApprovalForWrite: false,
      });

      await context.onLog(
        "stdout",
        `[Tool Result ${call.id}] (${outcome.status}): ${outcome.output.slice(0, 240)}\n`,
      );

      toolFeedbackBlocks.push(
        `[TOOL_RESULT id="${call.id}" tool="${call.tool}" status="${outcome.status}"]\n${outcome.output}\n[/TOOL_RESULT]`,
      );

      if (outcome.deliverableCompleted) {
        deliverableDone = true;
      }
    }

    if (deliverableDone) {
      await context.onLog("stdout", `\n[FreeLLM] Deliverable submitted by agent. Completing run.\n`);
      break;
    }

    // Feed tool execution outputs back into the SAME conversation without repeating bootstrap
    currentPrompt = `${toolFeedbackBlocks.join("\n\n")}\n\nContinue with the next step based on these tool results, or call submit_deliverable when finished.`;
  }

  await context.onLog("stdout", "\n[FreeLLM] Run completed.\n");
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    summary: finalResponseText.slice(0, 400),
    sessionParams: {
      platform,
      model: modelId,
      sessionId,
      conversationUrl: lastConversationUrl,
      conversationId: lastConversationId,
      timestamp: new Date().toISOString(),
    },
    sessionDisplayId: lastConversationId
      ? `${platform}:${lastConversationId.slice(0, 10)}`
      : `${platform}-${modelId}`,
  };
}
