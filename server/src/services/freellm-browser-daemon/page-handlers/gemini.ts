import type { Page } from "playwright";
import { ResponseTurnTracker, type StreamEventPayload } from "../stream-buffer.js";

export type GeminiStreamChunk = StreamEventPayload;

export class GeminiHandler {
  private cancelled = false;

  constructor(private page: Page) {}

  async navigate(targetUrl = "https://gemini.google.com/app"): Promise<void> {
    await this.page.goto(targetUrl, { waitUntil: "domcontentloaded" });
  }

  async checkStatus(): Promise<"READY" | "NEEDS_LOGIN" | "NEEDS_HUMAN_INTERVENTION" | "QUOTA_EXCEEDED"> {
    if (this.page.isClosed()) return "NEEDS_LOGIN";
    const url = this.page.url();
    if (url.includes("accounts.google.com") || url.includes("/signin") || url.includes("/sign_in")) {
      return "NEEDS_LOGIN";
    }

    // Check challenge / bot verification
    const challenge = await this.page.$(
      "#challenge-running, #challenge-stage, .g-recaptcha, iframe[src*='recaptcha'], [id*='captcha']",
    );
    if (challenge) {
      return "NEEDS_HUMAN_INTERVENTION";
    }

    // Check quota / rate limit banner
    const quotaBanner = await this.page.$(
      ':has-text("You\'ve reached your limit"), :has-text("quota exceeded"), :has-text("Try again later")',
    );
    if (quotaBanner) {
      const isVisible = await quotaBanner.isVisible().catch(() => false);
      if (isVisible) return "QUOTA_EXCEEDED";
    }

    // Check if input area is available
    const input = await this.page.$('rich-textarea, div.ql-editor[role="textbox"], div[role="textbox"]');
    if (input) {
      return "READY";
    }

    // Check if sign-in button is explicitly visible
    const signinBtn = await this.page.$('button:has-text("Sign in"), a:has-text("Sign in")');
    if (signinBtn) {
      return "NEEDS_LOGIN";
    }

    return "READY";
  }

  async getAvailableModels(): Promise<string[]> {
    if (this.page.isClosed()) return [];
    try {
      const pickerBtn = await this.page.$('button[aria-label*="mode picker"], button:has-text("Gemini")');
      if (!pickerBtn) return ["gemini-default"];
      await pickerBtn.click();
      await this.page.waitForTimeout(300);
      const items = await this.page.$$('[role="menuitem"], .mat-mdc-menu-item');
      const models: string[] = [];
      for (const item of items) {
        const text = (await item.innerText().catch(() => "")).trim();
        if (text) models.push(text);
      }
      await this.page.keyboard.press("Escape").catch(() => {});
      return models.length > 0 ? models : ["gemini-default"];
    } catch {
      return ["gemini-default"];
    }
  }

  async selectModel(modelKey?: string): Promise<boolean> {
    if (!modelKey || modelKey === "gemini-default" || this.page.isClosed()) return true;
    try {
      const pickerBtn = await this.page.$('button[aria-label*="mode picker"], button:has-text("Gemini")');
      if (!pickerBtn) return false;

      const currentText = (await pickerBtn.innerText()) || "";
      const currentAria = (await pickerBtn.getAttribute("aria-label")) || "";

      let keyword = "";
      if (modelKey.includes("pro")) keyword = "Pro";
      else if (modelKey.includes("flash-lite")) keyword = "Flash-Lite";
      else if (modelKey.includes("flash")) keyword = "Flash";
      else if (modelKey.includes("argon")) keyword = "Argon";

      if (!keyword) return true;
      if (currentText.includes(keyword) || currentAria.includes(keyword)) {
        return true;
      }

      await pickerBtn.click();
      await this.page.waitForTimeout(400);

      let clicked = false;
      const items = await this.page.$$('[role="menuitem"], .mat-mdc-menu-item');
      for (const item of items) {
        const itemText = await item.innerText();
        if (itemText.includes(keyword)) {
          await item.click();
          clicked = true;
          await this.page.waitForTimeout(400);
          break;
        }
      }
      if (!clicked) {
        await this.page.keyboard.press("Escape").catch(() => {});
      }
      return clicked;
    } catch (e: any) {
      console.warn("[GeminiHandler] Failed to switch model:", e.message);
      return false;
    }
  }

  async startNewChat(): Promise<void> {
    if (this.page.isClosed()) return;
    try {
      const newChatBtn = await this.page.$(
        'a[href="/app"], button[aria-label*="New chat"], [data-test-id="new-chat-button"], button:has-text("New chat")',
      );
      if (newChatBtn) {
        await newChatBtn.click();
        await this.page.waitForTimeout(500);
      } else {
        await this.page.goto("https://gemini.google.com/app", { waitUntil: "domcontentloaded" });
      }
    } catch {
      await this.page.goto("https://gemini.google.com/app", { waitUntil: "domcontentloaded" }).catch(() => {});
    }
  }

  async stopGeneration(): Promise<boolean> {
    this.cancelled = true;
    if (this.page.isClosed()) return false;
    try {
      const stopBtn = await this.page.$(
        'button[aria-label*="Stop response"], button.stop-response-button, [aria-label*="Stop"]',
      );
      if (stopBtn) {
        await stopBtn.click();
        return true;
      }
    } catch {}
    return false;
  }

  getConversationUrl(): string {
    return this.page.url();
  }

  /**
   * Snapshot current conversation boundary before sending a prompt.
   */
  private async captureBoundary(responseSelector: string): Promise<{
    count: number;
    lastResponseText: string;
  }> {
    return this.page.evaluate((sel) => {
      const nodes = Array.from(document.querySelectorAll(sel));
      nodes.forEach((el, idx) => el.setAttribute("data-freellm-pre-turn", String(idx)));
      const lastNode = nodes[nodes.length - 1] as HTMLElement | undefined;
      return {
        count: nodes.length,
        lastResponseText: lastNode ? (lastNode.innerText || "").trim() : "",
      };
    }, responseSelector);
  }

  async *sendMessage(
    prompt: string,
    modelKey?: string,
  ): AsyncGenerator<GeminiStreamChunk, void, unknown> {
    this.cancelled = false;
    const status = await this.checkStatus();
    if (status !== "READY") {
      yield { type: "status", status };
      return;
    }

    await this.selectModel(modelKey);

    const responseSelector = "message-content, .response-content, .model-response-text, model-response";
    const boundary = await this.captureBoundary(responseSelector);

    const editor = await this.page.waitForSelector(
      'div.ql-editor[role="textbox"], rich-textarea div[contenteditable="true"], textarea',
      { timeout: 15000 },
    );
    await editor.click();
    await editor.fill(prompt);
    await this.page.waitForTimeout(300);

    const sendBtn = await this.page.$(
      'button[aria-label*="Send message"], button.send-button, [aria-label*="Submit"]',
    );
    if (sendBtn) {
      await sendBtn.click();
    } else {
      await this.page.keyboard.press("Enter");
    }

    const tracker = new ResponseTurnTracker();

    for (let i = 0; i < 360; i++) {
      if (this.cancelled) {
        yield { type: "status", status: "CANCELLED" };
        return;
      }

      await this.page.waitForTimeout(1000);

      if (this.cancelled) {
        yield { type: "status", status: "CANCELLED" };
        return;
      }

      // Check if Captcha / Challenge popped up
      const challenge = await this.page.$("#challenge-running, .g-recaptcha, iframe[src*='recaptcha']");
      if (challenge) {
        yield { type: "status", status: "NEEDS_HUMAN_INTERVENTION" };
        return;
      }

      // Check for stop button (indicates generation in progress)
      const stopBtn = await this.page.$(
        'button[aria-label*="Stop response"], button.stop-response-button, [aria-label*="Stop"]',
      );

      // Extract new turn thinking & answer strictly from unmarked / post-boundary response elements
      const turnSnapshot = await this.page.evaluate(
        ({ sel, baselineCount }) => {
          const allNodes = Array.from(document.querySelectorAll(sel)) as HTMLElement[];
          const newNodes = allNodes.filter((el, idx) => !el.hasAttribute("data-freellm-pre-turn") || idx >= baselineCount);
          const targetNode = newNodes[newNodes.length - 1];
          if (!targetNode) {
            return { hasNewElement: false, answerText: "", thinkingText: "" };
          }

          // Extract thought drawer text if present
          const thoughtContainer = targetNode.closest("model-response, .conversation-container") || targetNode.parentElement;
          const thoughtNode = thoughtContainer?.querySelector(
            'model-thoughts, .model-thoughts, [data-test-id*="thought"], .thinking-content',
          ) as HTMLElement | null;
          const thinkingText = thoughtNode ? (thoughtNode.innerText || "").trim() : "";

          // Clone or read answer text excluding thought block
          let answerText = (targetNode.innerText || "").trim();
          if (answerText.startsWith("Gemini said")) {
            answerText = answerText.replace(/^Gemini said\s*/i, "").trim();
          }

          return {
            hasNewElement: true,
            answerText,
            thinkingText,
          };
        },
        { sel: responseSelector, baselineCount: boundary.count },
      );

      if (turnSnapshot.thinkingText) {
        const thinkEvt = tracker.updateThinking(turnSnapshot.thinkingText);
        if (thinkEvt) yield thinkEvt;
      }

      if (turnSnapshot.hasNewElement) {
        // Guard against stale DOM re-matching the previous response text before new tokens arrive
        const isStaleDuplicate =
          boundary.count > 0 &&
          !tracker.isAnswerStarted &&
          turnSnapshot.answerText === boundary.lastResponseText &&
          !stopBtn;

        if (!isStaleDuplicate) {
          const ansEvt = tracker.updateAnswer(turnSnapshot.answerText);
          if (ansEvt) yield ansEvt;
        }
      } else if (stopBtn && !tracker.isThinkingStarted && !tracker.isAnswerStarted) {
        const thinkEvt = tracker.updateThinking("Thinking...");
        if (thinkEvt) yield thinkEvt;
      }

      // Generation completion condition:
      // New response element exists, answer has started, stop button is gone, and text remained stable for >= 3 checks
      if (tracker.isAnswerStarted && turnSnapshot.hasNewElement && !stopBtn && tracker.stabilityTicks >= 3) {
        yield { type: "status", status: "COMPLETED" };
        return;
      }
    }

    // Timeout reached without completion: NEVER report COMPLETED on timeout
    yield {
      type: "error",
      message: "انتهت مهلة انتظار اكتمال الرد من Gemini دون استقرار الإجابة النهائية.",
    };
    yield { type: "status", status: "TIMEOUT" };
  }
}
