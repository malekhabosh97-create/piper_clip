import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { chromium, type BrowserContext, type Page } from "playwright";
import { acquireAtomicLock, releaseAtomicLock } from "./atomic-lock.js";
import { WindowManager } from "./window-manager.js";
import { DeepSeekHandler } from "./page-handlers/deepseek.js";
import { GeminiHandler } from "./page-handlers/gemini.js";
import { ArenaHandler } from "./page-handlers/arena.js";
import {
  PersistentSessionRegistry,
  extractConversationIdFromUrl,
  type SupportedPlatform,
} from "./session-store.js";

export interface DaemonConfig {
  port?: number;
  profileDir?: string;
  lockFile?: string;
}

export interface BrowserSession {
  sessionId: string;
  agentId?: string;
  issueId?: string;
  projectId?: string;
  platform: SupportedPlatform;
  model: string;
  page: Page;
  conversationUrl: string;
  conversationId: string;
  isInitialized: boolean;
  systemPromptHash?: string;
  lastActiveAt: number;
  handler: GeminiHandler | DeepSeekHandler | ArenaHandler;
}

function sha256Short(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

function getBaseUrlForPlatform(platform: SupportedPlatform): string {
  if (platform === "gemini") return "https://gemini.google.com/app";
  if (platform === "arena") return "https://lmarena.ai/?mode=direct";
  return "https://chat.deepseek.com";
}

function createHandlerForPlatform(
  platform: SupportedPlatform,
  page: Page,
): GeminiHandler | DeepSeekHandler | ArenaHandler {
  if (platform === "gemini") return new GeminiHandler(page);
  if (platform === "arena") return new ArenaHandler(page);
  return new DeepSeekHandler(page);
}

export class FreeLLMBrowserDaemon {
  private context: BrowserContext | null = null;
  private defaultPages = new Map<SupportedPlatform, Page>();
  private sessions = new Map<string, BrowserSession>();
  private sessionLocks = new Map<string, Promise<void>>();
  private activeGenerators = new Set<string>();
  private registry: PersistentSessionRegistry;
  private windowManager: WindowManager | null = null;
  private authToken: string;
  private server: http.Server | null = null;
  private profileDir: string;

  constructor(private config: DaemonConfig = {}) {
    this.authToken = crypto.randomBytes(24).toString("hex");
    this.profileDir =
      this.config.profileDir ?? process.env.FREELLM_PROFILE_DIR ?? "C:\\Users\\malek\\.piperclip-browser-profile";
    fs.mkdirSync(this.profileDir, { recursive: true });
    this.registry = new PersistentSessionRegistry(this.profileDir);
  }

  get token(): string {
    return this.authToken;
  }

  /**
   * Ensure browser connection: connects to real Chrome/Edge on CDP port (default 9223).
   */
  private async ensureBrowser(): Promise<boolean> {
    try {
      const cdpPort = process.env.FREELLM_CDP_PORT ? Number(process.env.FREELLM_CDP_PORT) : 9223;
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, { timeout: 3000 });
      const contexts = browser.contexts();
      this.context = contexts[0] ?? (await browser.newContext());

      const allPages = this.context.pages();

      // Ensure base DeepSeek page for health/status inspection
      let dsPage = allPages.find((p) => p.url().includes("deepseek.com"));
      if (!dsPage) {
        dsPage = await this.context.newPage();
        await dsPage.goto("https://chat.deepseek.com", { waitUntil: "domcontentloaded" }).catch(() => {});
      }
      this.defaultPages.set("deepseek", dsPage);
      if (!this.windowManager) {
        this.windowManager = new WindowManager(dsPage);
      }

      // Ensure base Gemini page for health/status inspection
      let geminiPage = allPages.find((p) => p.url().includes("gemini.google.com"));
      if (!geminiPage) {
        geminiPage = await this.context.newPage();
        await geminiPage.goto("https://gemini.google.com/app", { waitUntil: "domcontentloaded" }).catch(() => {});
      }
      this.defaultPages.set("gemini", geminiPage);

      // Check existing Arena page if open
      const arenaPage = allPages.find((p) => p.url().includes("lmarena.ai"));
      if (arenaPage) {
        this.defaultPages.set("arena", arenaPage);
      }

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Verify whether a restored conversation tab genuinely retains prior conversation context.
   * Having an open tab alone does not prove context survival.
   */
  private async verifyContextIntact(
    page: Page,
    platform: SupportedPlatform,
    expectedUrl: string,
  ): Promise<boolean> {
    if (page.isClosed()) return false;
    const currentUrl = page.url();
    const baseUrl = getBaseUrlForPlatform(platform);

    // If expectedUrl had a specific conversation ID path, ensure the browser didn't redirect back to root/new chat
    const expectedConvId = extractConversationIdFromUrl(expectedUrl, platform);
    const currentConvId = extractConversationIdFromUrl(currentUrl, platform);
    if (expectedConvId && expectedConvId !== currentConvId) {
      return false;
    }

    // Also verify DOM actually contains at least one prior message turn
    const hasMessages = await page
      .evaluate((plat) => {
        if (plat === "gemini") {
          return document.querySelectorAll("message-content, model-response").length > 0;
        }
        if (plat === "arena") {
          return document.querySelectorAll('[data-testid="bot"], .bot-message, .prose').length > 0;
        }
        return document.querySelectorAll(".ds-markdown, .fbb737a4").length > 0;
      }, platform)
      .catch(() => false);

    // If URL is still at root base URL and no messages exist in DOM, context is lost
    if (!hasMessages && (currentUrl === baseUrl || !currentConvId)) {
      return false;
    }

    return hasMessages;
  }

  /**
   * Get or allocate a dedicated browser session for a specific agent/task.
   * Never shares the default status tab with an active agent session.
   */
  private async getOrCreateSession(
    sessionId: string,
    platform: SupportedPlatform,
    model: string,
    meta?: { agentId?: string; issueId?: string; projectId?: string; companyId?: string },
  ): Promise<{ session: BrowserSession; contextWasLost: boolean }> {
    const persisted = this.registry.get(sessionId);
    const existing = this.sessions.get(sessionId);

    // If session exists in memory and page is still open, verify platform hasn't switched
    if (existing && !existing.page.isClosed() && existing.platform === platform) {
      existing.model = model;
      existing.lastActiveAt = Date.now();
      let contextWasLost = false;

      if (existing.isInitialized) {
        const intact = await this.verifyContextIntact(
          existing.page,
          platform,
          existing.conversationUrl,
        );
        if (!intact) {
          existing.isInitialized = false;
          contextWasLost = true;
          this.registry.invalidateInitialization(sessionId, "Conversation context lost in browser tab");
        }
      }
      return { session: existing, contextWasLost };
    }

    if (!this.context) {
      throw new Error("المتصفح غير متصل. يرجى التأكد من تشغيل المتصفح من سطح المكتب.");
    }

    // Close old page if platform switched
    if (existing && !existing.page.isClosed()) {
      await existing.page.close().catch(() => {});
    }

    // Allocate a dedicated tab for this session
    const page = await this.context.newPage();
    const startUrl = getBaseUrlForPlatform(platform);
    const targetUrl =
      persisted && persisted.platform === platform && persisted.conversationUrl
        ? persisted.conversationUrl
        : startUrl;

    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    const handler = createHandlerForPlatform(platform, page);

    let isInitialized = Boolean(persisted && persisted.platform === platform && persisted.isInitialized);
    let contextWasLost = false;

    if (isInitialized) {
      const intact = await this.verifyContextIntact(page, platform, targetUrl);
      if (!intact) {
        isInitialized = false;
        contextWasLost = true;
        this.registry.invalidateInitialization(sessionId, "Restored URL did not retain conversation messages");
      }
    }

    const currentUrl = page.url();
    const convId = extractConversationIdFromUrl(currentUrl, platform);

    const session: BrowserSession = {
      sessionId,
      agentId: meta?.agentId ?? persisted?.agentId,
      issueId: meta?.issueId ?? persisted?.issueId,
      projectId: meta?.projectId ?? persisted?.projectId,
      platform,
      model,
      page,
      conversationUrl: currentUrl,
      conversationId: convId,
      isInitialized,
      systemPromptHash: persisted?.systemPromptHash,
      lastActiveAt: Date.now(),
      handler,
    };

    this.registry.upsert(sessionId, {
      ...meta,
      platform,
      model,
      conversationUrl: currentUrl,
      conversationId: convId,
      isInitialized,
      status: "IDLE",
    });

    page.on("close", () => {
      this.sessions.delete(sessionId);
    });

    this.sessions.set(sessionId, session);
    return { session, contextWasLost };
  }

  async start(): Promise<number> {
    const port = this.config.port ?? 3150;
    const lockFile =
      this.config.lockFile ?? path.resolve(this.profileDir, "browser.lock");

    acquireAtomicLock(lockFile, port, this.authToken);

    process.on("exit", () => releaseAtomicLock(lockFile));
    process.on("SIGINT", () => {
      releaseAtomicLock(lockFile);
      process.exit(0);
    });
    process.on("SIGTERM", () => {
      releaseAtomicLock(lockFile);
      process.exit(0);
    });

    await this.ensureBrowser().catch(() => {});

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));
      this.server.listen(port, "127.0.0.1", () => {
        console.log(`FreeLLM Browser Daemon listening on 127.0.0.1:${port}`);
        resolve(port);
      });
      this.server.on("error", reject);
    });
  }

  private authenticate(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const auth = req.headers["x-freellm-auth"];
    if (auth !== this.authToken) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return false;
    }
    return true;
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    if (req.url === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (!this.authenticate(req, res)) return;

    if (req.url === "/status" && req.method === "GET") {
      const isOnline = await this.ensureBrowser();
      if (!isOnline) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            deepseek: "DISCONNECTED",
            gemini: "DISCONNECTED",
            arena: "DISCONNECTED",
            activeSessions: 0,
            persistedSessions: this.registry.list().length,
            isGenerating: false,
          }),
        );
        return;
      }

      const dsPage = this.defaultPages.get("deepseek");
      const geminiPage = this.defaultPages.get("gemini");
      const arenaPage = this.defaultPages.get("arena");

      const dsStatus = dsPage ? await new DeepSeekHandler(dsPage).checkStatus() : "DISCONNECTED";
      const geminiStatus = geminiPage ? await new GeminiHandler(geminiPage).checkStatus() : "DISCONNECTED";
      const arenaStatus = arenaPage ? await new ArenaHandler(arenaPage).checkStatus() : "READY";

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          deepseek: dsStatus,
          gemini: geminiStatus,
          arena: arenaStatus,
          activeSessions: this.sessions.size,
          persistedSessions: this.registry.list().length,
          isGenerating: this.activeGenerators.size > 0,
        }),
      );
      return;
    }

    if (req.url === "/sessions" && req.method === "GET") {
      const persistedList = this.registry.list().map((p) => {
        const live = this.sessions.get(p.sessionId);
        return {
          ...p,
          tabOpen: Boolean(live && !live.page.isClosed()),
          isGenerating: this.activeGenerators.has(p.sessionId),
        };
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(persistedList));
      return;
    }

    if (req.url === "/window/show" && req.method === "POST") {
      await this.ensureBrowser();
      if (this.windowManager) await this.windowManager.showWindow();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    if (req.url === "/window/minimize" && req.method === "POST") {
      await this.ensureBrowser();
      if (this.windowManager) await this.windowManager.minimizeWindow();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    if (req.url === "/tab/open" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const { platform, sessionId } = JSON.parse(body || "{}");
          await this.ensureBrowser();

          let targetPage: Page | undefined;
          if (sessionId && this.sessions.has(sessionId)) {
            targetPage = this.sessions.get(sessionId)?.page;
          } else if (platform) {
            if (platform === "arena" && !this.defaultPages.has("arena") && this.context) {
              const p = await this.context.newPage();
              await p.goto("https://lmarena.ai/?mode=direct", { waitUntil: "domcontentloaded" }).catch(() => {});
              this.defaultPages.set("arena", p);
            }
            targetPage = this.defaultPages.get(platform as SupportedPlatform);
          }

          if (targetPage && !targetPage.isClosed()) {
            await targetPage.bringToFront();
            if (this.windowManager) await this.windowManager.showWindow();
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: true, sessionId, platform }));
            return;
          }
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Target tab not found" }));
        } catch (e: any) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    if (req.url === "/cancel" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const { sessionId, platform } = JSON.parse(body || "{}");
          let stopped = false;
          if (sessionId && this.sessions.has(sessionId)) {
            const session = this.sessions.get(sessionId);
            if (session && !session.page.isClosed()) {
              stopped = await session.handler.stopGeneration();
            }
            this.registry.upsert(sessionId, {
              platform: session?.platform || platform || "deepseek",
              model: session?.model || "deepseek-normal",
              status: "CANCELLED",
            });
          } else if (platform && this.defaultPages.has(platform as SupportedPlatform)) {
            const page = this.defaultPages.get(platform as SupportedPlatform);
            if (page && !page.isClosed()) {
              const handler = createHandlerForPlatform(platform as SupportedPlatform, page);
              stopped = await handler.stopGeneration();
            }
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, stopped }));
        } catch (e: any) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    if (req.url === "/chat" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const {
            prompt,
            platform: rawPlatform = "deepseek",
            model = "deepseek-normal",
            deepThink = false,
            sessionId: rawSessionId,
            agentId,
            issueId,
            projectId,
            companyId,
            systemPrompt,
            lastSummary,
          } = JSON.parse(body);

          const platform: SupportedPlatform =
            rawPlatform === "gemini" || model.startsWith("gemini")
              ? "gemini"
              : rawPlatform === "arena" || model.startsWith("arena")
                ? "arena"
                : "deepseek";

          // Guarantee every request uses an isolated session key (never fall back to shared platform tab)
          const effectiveSessionId =
            rawSessionId ||
            (agentId && issueId ? `${agentId}:${issueId}` : agentId) ||
            `ephemeral-${platform}-${Date.now()}`;

          const isOnline = await this.ensureBrowser();
          if (!isOnline) {
            res.writeHead(503, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "المتصفح غير متصل. يرجى تشغيل المتصفح من سطح المكتب." }));
            return;
          }

          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });

          // Session Lock to prevent concurrent requests colliding on the same session tab
          const prevLock = this.sessionLocks.get(effectiveSessionId) || Promise.resolve();
          let releaseLock: () => void;
          const currentLock = new Promise<void>((r) => (releaseLock = r));
          this.sessionLocks.set(effectiveSessionId, currentLock);

          await prevLock;
          this.activeGenerators.add(effectiveSessionId);

          try {
            const { session, contextWasLost } = await this.getOrCreateSession(
              effectiveSessionId,
              platform,
              model,
              { agentId, issueId, projectId, companyId },
            );
            const targetHandler = session.handler;
            const persisted = this.registry.get(effectiveSessionId);

            this.registry.upsert(effectiveSessionId, {
              platform,
              model,
              status: "GENERATING",
            });

            // One-time Bootstrap / System Prompt if session is not yet initialized (or if context was lost)
            const currentPromptHash = systemPrompt ? sha256Short(systemPrompt) : "";
            const needsBootstrap =
              Boolean(systemPrompt) &&
              (!session.isInitialized ||
                contextWasLost ||
                (session.systemPromptHash && session.systemPromptHash !== currentPromptHash));

            if (needsBootstrap && systemPrompt) {
              const recoveryNote =
                contextWasLost || persisted?.lastSummary || lastSummary
                  ? `\n\n[PREVIOUS STATE SUMMARY FOR RECOVERY]\n${lastSummary || persisted?.lastSummary || "Resuming ongoing task after browser session reload."}`
                  : "";

              const bootstrapPrompt = `[SYSTEM INITIALIZATION & AGENT IDENTITY]\n${systemPrompt}${recoveryNote}\n\n[INSTRUCTION]\nAcknowledge your role and tool protocol in one concise sentence and await the task.`;

              let initCompleted = false;
              let initStatus: string | undefined;
              let initAnswer = "";

              const streamGen =
                platform === "gemini"
                  ? (targetHandler as GeminiHandler).sendMessage(bootstrapPrompt, model)
                  : platform === "arena"
                    ? (targetHandler as ArenaHandler).sendMessage(bootstrapPrompt, model)
                    : (targetHandler as DeepSeekHandler).sendMessage(bootstrapPrompt, false);

              for await (const chunk of streamGen) {
                if (chunk.type === "token" && chunk.text) {
                  initAnswer += chunk.text;
                } else if (chunk.type === "replace" && chunk.text) {
                  initAnswer = chunk.text;
                } else if (chunk.type === "status") {
                  initStatus = chunk.status;
                  if (
                    chunk.status === "NEEDS_LOGIN" ||
                    chunk.status === "NEEDS_HUMAN_INTERVENTION" ||
                    chunk.status === "QUOTA_EXCEEDED" ||
                    chunk.status === "CANCELLED"
                  ) {
                    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                    this.registry.upsert(effectiveSessionId, {
                      platform,
                      model,
                      status: chunk.status as any,
                    });
                    if (chunk.status === "NEEDS_HUMAN_INTERVENTION" && this.windowManager) {
                      await session.page.bringToFront().catch(() => {});
                      await this.windowManager.showWindow().catch(() => {});
                    }
                    return;
                  }
                  if (chunk.status === "COMPLETED") {
                    initCompleted = true;
                  }
                }
              }

              // CRITICAL FIX: Only mark initialized if the model actually answered and completed
              if (initCompleted && initAnswer.trim().length > 0) {
                const updatedUrl = session.page.url();
                const updatedConvId = extractConversationIdFromUrl(updatedUrl, platform);
                session.isInitialized = true;
                session.conversationUrl = updatedUrl;
                session.conversationId = updatedConvId;
                session.systemPromptHash = currentPromptHash;

                this.registry.markInitialized(
                  effectiveSessionId,
                  updatedUrl,
                  updatedConvId,
                  currentPromptHash,
                );

                res.write(
                  `data: ${JSON.stringify({
                    type: "session_meta",
                    status: "INITIALIZED",
                    conversationUrl: updatedUrl,
                    conversationId: updatedConvId,
                    isInitialized: true,
                  })}\n\n`,
                );
              } else {
                res.write(
                  `data: ${JSON.stringify({
                    type: "error",
                    message: `فشلت تهيئة محادثة الوكيل (Status: ${initStatus || "INCOMPLETE"})`,
                  })}\n\n`,
                );
                return;
              }
            }

            // Stream user task prompt
            let finalAnswer = "";
            let finalStatus = "IDLE";

            const mainGen =
              platform === "gemini"
                ? (targetHandler as GeminiHandler).sendMessage(prompt, model)
                : platform === "arena"
                  ? (targetHandler as ArenaHandler).sendMessage(prompt, model)
                  : (targetHandler as DeepSeekHandler).sendMessage(prompt, !!deepThink);

            for await (const chunk of mainGen) {
              if (chunk.type === "token" && chunk.text) {
                finalAnswer += chunk.text;
              } else if (chunk.type === "replace" && chunk.text) {
                finalAnswer = chunk.text;
              } else if (chunk.type === "status" && chunk.status) {
                finalStatus = chunk.status;
                if (chunk.status === "NEEDS_HUMAN_INTERVENTION" && this.windowManager) {
                  await session.page.bringToFront().catch(() => {});
                  await this.windowManager.showWindow().catch(() => {});
                }
              }
              res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            }

            const finalUrl = session.page.url();
            const finalConvId = extractConversationIdFromUrl(finalUrl, platform);
            session.conversationUrl = finalUrl;
            session.conversationId = finalConvId;
            session.lastActiveAt = Date.now();

            const existingRecord = this.registry.get(effectiveSessionId);
            this.registry.upsert(effectiveSessionId, {
              platform,
              model,
              conversationUrl: finalUrl,
              conversationId: finalConvId,
              isInitialized: session.isInitialized,
              turnCount: (existingRecord?.turnCount ?? 0) + 1,
              lastResponsePreview: finalAnswer.slice(0, 300),
              lastSummary: finalAnswer.slice(0, 500) || existingRecord?.lastSummary,
              status:
                finalStatus === "COMPLETED"
                  ? "IDLE"
                  : (finalStatus as any) || "IDLE",
            });

            res.write(
              `data: ${JSON.stringify({
                type: "session_meta",
                conversationUrl: finalUrl,
                conversationId: finalConvId,
                isInitialized: session.isInitialized,
              })}\n\n`,
            );
          } finally {
            this.activeGenerators.delete(effectiveSessionId);
            releaseLock!();
            res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
            res.end();
          }
        } catch (err: any) {
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
          } else {
            res.write(`data: ${JSON.stringify({ type: "error", message: err.message })}\n\n`);
            res.end();
          }
        }
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  async stop(): Promise<void> {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    for (const session of this.sessions.values()) {
      if (!session.page.isClosed()) {
        await session.page.close().catch(() => {});
      }
    }
    this.sessions.clear();
  }
}
