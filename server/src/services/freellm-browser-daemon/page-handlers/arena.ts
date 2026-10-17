import type { Page } from "playwright";
import { ResponseTurnTracker, type StreamEventPayload } from "../stream-buffer.js";

export type ArenaStreamChunk = StreamEventPayload;

export class ArenaHandler {
  private cancelled = false;

  constructor(private page: Page) {}

  async navigate(targetUrl = "https://lmarena.ai/?mode=direct"): Promise<void> {
    await this.page.goto(targetUrl, { waitUntil: "domcontentloaded" });
  }

  async checkStatus(): Promise<"READY" | "NEEDS_LOGIN" | "NEEDS_HUMAN_INTERVENTION" | "QUOTA_EXCEEDED"> {
    if (this.page.isClosed()) return "NEEDS_LOGIN";

    // Check Cloudflare / Turnstile Challenge
    const cf = await this.page.$(
      "#challenge-running, #challenge-stage, .cf-turnstile, iframe[src*='challenges.cloudflare'], [id*='captcha']",
    );
    if (cf) {
      return "NEEDS_HUMAN_INTERVENTION";
    }

    const rateLimit = await this.page.$(
      ':has-text("Rate limit reached"), :has-text("Too many requests"), :has-text("quota exceeded")',
    );
    if (rateLimit) {
      const visible = await rateLimit.isVisible().catch(() => false);
      if (visible) return "QUOTA_EXCEEDED";
    }

    const textarea = await this.page.$("textarea, [contenteditable='true'][role='textbox']");
    if (textarea) {
      return "READY";
    }

    return "READY";
  }

  async ensureDirectChatMode(modelKey?: string): Promise<boolean> {
    if (this.page.isClosed()) return false;
    try {
      // Ensure Direct Chat tab/mode is active
      const directTab = await this.page.$(
        'button:has-text("Direct Chat"), a:has-text("Direct Chat"), [role="tab"]:has-text("Direct")',
      );
      if (directTab) {
        const isSelected = await directTab.evaluate(
          (el) =>
            el.getAttribute("aria-selected") === "true" ||
            el.classList.contains("active") ||
            el.getAttribute("data-state") === "active",
        );
        if (!isSelected) {
          await directTab.click();
          await this.page.waitForTimeout(400);
        }
      }

      // Accept terms dialog if visible
      const agreeBtn = await this.page.$('button:has-text("Agree"), button:has-text("Accept"), button:has-text("I Agree")');
      if (agreeBtn) {
        const visible = await agreeBtn.isVisible().catch(() => false);
        if (visible) {
          await agreeBtn.click();
          await this.page.waitForTimeout(300);
        }
      }

      if (modelKey && modelKey !== "arena-direct" && modelKey !== "arena-default") {
        const targetKeyword = modelKey.replace(/^arena-/, "").replace(/-/g, " ");
        const modelPicker = await this.page.$(
          'button[role="combobox"], input[aria-label*="model" i], .model-selector',
        );
        if (modelPicker) {
          await modelPicker.click();
          await this.page.waitForTimeout(300);
          const options = await this.page.$$('[role="option"], li[role="option"]');
          for (const opt of options) {
            const txt = (await opt.innerText().catch(() => "")).toLowerCase();
            if (txt.includes(targetKeyword.toLowerCase())) {
              await opt.click();
              await this.page.waitForTimeout(300);
              break;
            }
          }
          await this.page.keyboard.press("Escape").catch(() => {});
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  async stopGeneration(): Promise<boolean> {
    this.cancelled = true;
    if (this.page.isClosed()) return false;
    try {
      const stopBtn = await this.page.$(
        'button[aria-label*="Stop" i], button:has-text("Stop"), button.stop-button',
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
  ): AsyncGenerator<ArenaStreamChunk, void, unknown> {
    this.cancelled = false;
    const status = await this.checkStatus();
    if (status !== "READY") {
      yield { type: "status", status };
      return;
    }

    await this.ensureDirectChatMode(modelKey);

    const responseSelector =
      '[data-testid="bot"], .bot-message, .message-content, .prose, .markdown-body';
    const boundary = await this.captureBoundary(responseSelector);

    const input = await this.page.waitForSelector(
      "textarea, [contenteditable='true'][role='textbox']",
      { timeout: 15000 },
    );
    await input.click();
    await input.fill(prompt);
    await this.page.waitForTimeout(300);

    const sendBtn = await this.page.$(
      'button[type="submit"], button[aria-label*="Send" i], button.submit-button',
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

      const cf = await this.page.$("#challenge-running, .cf-turnstile");
      if (cf) {
        yield { type: "status", status: "NEEDS_HUMAN_INTERVENTION" };
        return;
      }

      const stopBtn = await this.page.$(
        'button[aria-label*="Stop" i], button:has-text("Stop"), button.stop-button',
      );

      const turnSnapshot = await this.page.evaluate(
        ({ sel, baselineCount }) => {
          const allNodes = Array.from(document.querySelectorAll(sel)) as HTMLElement[];
          const newNodes = allNodes.filter(
            (el, idx) => !el.hasAttribute("data-freellm-pre-turn") || idx >= baselineCount,
          );
          const targetNode = newNodes[newNodes.length - 1];
          if (!targetNode) {
            return { hasNewElement: false, answerText: "" };
          }
          return {
            hasNewElement: true,
            answerText: (targetNode.innerText || "").trim(),
          };
        },
        { sel: responseSelector, baselineCount: boundary.count },
      );

      if (turnSnapshot.hasNewElement) {
        const isStaleDuplicate =
          boundary.count > 0 &&
          !tracker.isAnswerStarted &&
          turnSnapshot.answerText === boundary.lastResponseText &&
          !stopBtn;

        if (!isStaleDuplicate && turnSnapshot.answerText !== prompt.trim()) {
          const ansEvt = tracker.updateAnswer(turnSnapshot.answerText);
          if (ansEvt) yield ansEvt;
        }
      } else if (stopBtn && !tracker.isThinkingStarted && !tracker.isAnswerStarted) {
        const thinkEvt = tracker.updateThinking("Thinking...");
        if (thinkEvt) yield thinkEvt;
      }

      if (tracker.isAnswerStarted && turnSnapshot.hasNewElement && !stopBtn && tracker.stabilityTicks >= 3) {
        yield { type: "status", status: "COMPLETED" };
        return;
      }
    }

    yield {
      type: "error",
      message: "انتهت مهلة انتظار اكتمال الرد من LMArena دون استقرار الإجابة النهائية.",
    };
    yield { type: "status", status: "TIMEOUT" };
  }
}
