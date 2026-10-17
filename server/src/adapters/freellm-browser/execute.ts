import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";

function calculateSha256(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

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
    return `Hello, I am ${context.agent.name}. How can I assist with this workspace?`;
  }

  return "Hello from FreeLLM Work";
}

function extractSystemPromptFromContext(context: AdapterExecutionContext): string {
  const instructionsPath =
    (context.config?.instructionsFilePath as string) ||
    ((context.agent as any)?.adapterConfig as any)?.instructionsFilePath;

  if (instructionsPath && fs.existsSync(instructionsPath)) {
    try {
      return fs.readFileSync(instructionsPath, "utf8").trim();
    } catch {}
  }

  if (context.agent?.name && context.agent?.role) {
    return `You are ${context.agent.name}, acting as ${context.agent.role} in FreeLLM Work.`;
  }

  return "";
}

export async function execute(
  context: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  const modelId =
    (context.config?.model as string) || "deepseek-normal";
  const prompt = extractPromptFromContext(context);
  const systemPrompt = extractSystemPromptFromContext(context);

  const isGemini = modelId.startsWith("gemini-");
  const platform = isGemini ? "gemini" : "deepseek";
  const deepThink = modelId === "deepseek-deepthink" || modelId.includes("thinking") || modelId.includes("r1");
  const daemonPort = Number(process.env.FREELLM_DAEMON_PORT) || 3150;
  const daemonToken = getDaemonToken();

  const sessionId = context.agent?.id || ((context.context?.paperclipIssue as any)?.id as string) || `session-${platform}-${modelId}`;

  const platformName = isGemini ? `Google Gemini (${modelId})` : `DeepSeek (${deepThink ? "DeepThink" : "Normal"})`;
  await context.onLog("stdout", `[FreeLLM] Dispatching to ${platformName} (Session: ${sessionId.slice(0, 8)})...\n`);

  return new Promise((resolve) => {
    const postData = JSON.stringify({
      prompt,
      platform,
      model: modelId,
      deepThink,
      sessionId,
      systemPrompt: systemPrompt || undefined,
    });

    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: daemonPort,
        path: "/chat",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postData),
          "x-freellm-auth": daemonToken,
        },
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          const errMsg = `Browser Daemon returned HTTP ${res.statusCode}`;
          context.onLog("stderr", `[FreeLLM Error] ${errMsg}\n`);
          resolve({
            exitCode: 1,
            signal: null,
            timedOut: false,
            errorMessage: errMsg,
          });
          return;
        }

        let fullResponse = "";
        let lastStatus: string | null = null;
        let hasError = false;
        let streamBuffer = "";

        const processPayload = async (payload: any) => {
          if (payload.type === "token" && payload.text) {
            fullResponse += payload.text;
            await context.onLog("stdout", payload.text);
          } else if (payload.type === "replace" && payload.text) {
            fullResponse = payload.text;
            await context.onLog("stdout", `\n[Updated]: ${payload.text}\n`);
          } else if (payload.type === "thinking") {
            await context.onLog("stdout", "[Thinking...]\n");
          } else if (payload.type === "status") {
            lastStatus = payload.status;
            await context.onLog("stdout", `[Status: ${payload.status}]\n`);
          } else if (payload.type === "error") {
            hasError = true;
            await context.onLog("stderr", `[FreeLLM Error] ${payload.message}\n`);
          }
        };

        // CRITICAL FIX: Buffer SSE chunks to prevent loss on fragmented TCP packets
        res.on("data", async (chunkBuffer: Buffer) => {
          streamBuffer += chunkBuffer.toString("utf8");
          const lines = streamBuffer.split("\n");
          streamBuffer = lines.pop() ?? ""; // keep incomplete fragment

          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith("data: ")) {
              try {
                const payload = JSON.parse(trimmed.slice(6));
                await processPayload(payload);
              } catch {}
            }
          }
        });

        res.on("end", async () => {
          if (streamBuffer.trim().startsWith("data: ")) {
            try {
              const payload = JSON.parse(streamBuffer.trim().slice(6));
              await processPayload(payload);
            } catch {}
          }

          if (lastStatus === "NEEDS_LOGIN") {
            const loginMsg = `${platformName} requires login. Please open 'المتصفح' (Browser) in the sidebar to log in to your account.`;
            await context.onLog("stderr", `\n[FreeLLM] ${loginMsg}\n`);
            resolve({
              exitCode: 1,
              signal: null,
              timedOut: false,
              errorMessage: loginMsg,
              executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
            });
            return;
          }

          if (lastStatus === "NEEDS_HUMAN_INTERVENTION") {
            const capMsg = "Captcha / Cloudflare challenge detected. Please open 'المتصفح' in the sidebar to solve the challenge.";
            await context.onLog("stderr", `\n[FreeLLM] ${capMsg}\n`);
            resolve({
              exitCode: 1,
              signal: null,
              timedOut: false,
              errorMessage: capMsg,
              executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
            });
            return;
          }

          if (hasError && !fullResponse) {
            resolve({
              exitCode: 1,
              signal: null,
              timedOut: false,
              errorMessage: `Failed to generate response from ${platformName}.`,
            });
            return;
          }

          await context.onLog("stdout", "\n[FreeLLM] Generation completed successfully.\n");

          resolve({
            exitCode: 0,
            signal: null,
            timedOut: false,
            summary: fullResponse.slice(0, 300),
            sessionParams: {
              platform,
              model: modelId,
              sessionId,
              timestamp: new Date().toISOString(),
            },
            sessionDisplayId: `${platform}-${modelId}`,
          });
        });
      },
    );

    req.on("error", async (err) => {
      await context.onLog("stderr", `[FreeLLM Error] ${err.message}\n`);
      resolve({
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: err.message,
      });
    });

    // CRITICAL FIX: Real cancellation at provider level
    if (context.signal) {
      context.signal.addEventListener("abort", () => {
        req.destroy();

        // Send cancel request to daemon to click Stop button in real browser tab
        try {
          const cancelData = JSON.stringify({ sessionId, platform });
          const cancelReq = http.request({
            hostname: "127.0.0.1",
            port: daemonPort,
            path: "/cancel",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(cancelData),
              "x-freellm-auth": daemonToken,
            },
          });
          cancelReq.write(cancelData);
          cancelReq.end();
        } catch {}

        resolve({
          exitCode: 130,
          signal: "SIGINT",
          timedOut: false,
          errorMessage: "Execution cancelled by operator",
        });
      });
    }

    req.write(postData);
    req.end();
  });
}
