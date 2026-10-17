import type { Page } from "playwright";
import { ResponseTurnTracker, type StreamEventPayload } from "../stream-buffer.js";

export type DeepSeekStreamChunk = StreamEventPayload;

export class DeepSeekHandler {
  private cancelled = false;

  constructor(private page: Page) {}

  async navigate(targetUrl = "https://chat.deepseek.com"): Promise<void> {
    await this.page.goto(targetUrl, { waitUntil: "domcontentloaded" });
  }

  async checkStatus(): Promise<"READY" | "NEEDS_LOGIN" | "NEEDS_HUMAN_INTERVENTION" | "QUOTA_EXCEEDED"> {
    if (this.page.isClosed()) return "NEEDS_LOGIN";
    const url = this.page.url();
    if (url.includes("/login") || url.includes("/sign_in")) {
      return "NEEDS_LOGIN";
    }

    const cf = await this.page.$(
      "#challenge-running, #challenge-stage, .cf-turnstile, iframe[src*='challenges.cloudflare']",
    );
    if (cf) {
      return "NEEDS_HUMAN_INTERVENTION";
    }

    const busyBanner = await this.page.$(
      ':has-text("The server is busy. Please try again later."), :has-text("rate limit")',
    );
    if (busyBanner) {
      const visible = await busyBanner.isVisible().catch(() => false);
      if (visible) return "QUOTA_EXCEEDED";
    }

    const loginBtn = await this.page.$("button:has-text('Log in'), button:has-text('Sign in'), a[href*='login']");
    const textarea = await this.page.$("textarea#chat-input, textarea");

    if (!textarea && loginBtn) {
      return "NEEDS_LOGIN";
    }

    return "READY";
  }

  async setDeepThinkMode(enabled: boolean): Promise<boolean> {
    if (this.page.isClosed()) return false;
    try {
      const deepThinkBtn = await this.page.$(
        "button:has-text('DeepThink'), div[role='button']:has-text('DeepThink'), [aria-label*='DeepThink']",
      );
      if (deepThinkBtn) {
        const isChecked = await deepThinkBtn.evaluate((el) => {
          return (
            el.getAttribute("aria-checked") === "true" ||
            el.getAttribute("aria-pressed") === "true" ||
            el.classList.contains("active") ||
            el.classList.contains("selected") ||
            el.classList.contains("ds-toggle-button--selected")
          );
        });
        if (isChecked !== enabled) {
          await deepThinkBtn.click();
          await this.page.waitForTimeout(300);
        }
        return true;
      }
      return false;
    } catch (e: any) {
      console.warn("Could not toggle DeepThink:", e.message);
      return false;
    }
  }

  async startNewChat(): Promise<void> {
    if (this.page.isClosed()) return;
    try {
      const newChatBtn = await this.page.$(
        'button:has-text("New chat"), div[role="button"]:has-text("New chat"), a[href="/"]',
      );
      if (newChatBtn) {
        await newChatBtn.click();
        await this.page.waitForTimeout(500);
      } else {
        await this.page.goto("https://chat.deepseek.com", { waitUntil: "domcontentloaded" });
      }
    } catch {
      await this.page.goto("https://chat.deepseek.com", { waitUntil: "domcontentloaded" }).catch(() => {});
    }
  }

  async stopGeneration(): Promise<boolean> {
    this.cancelled = true;
    if (this.page.isClosed()) return false;
    try {
      const stopBtn = await this.page.$("button[aria-label*='Stop'], .ds-icon--stop, button:has-text('Stop')");
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

  private async captureBoundary(messageSelector: string): Promise<{
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
    }, messageSelector);
  }

  async *sendMessage(
    prompt: string,
    deepThink: boolean = false,
  ): AsyncGenerator<DeepSeekStreamChunk, void, unknown> {
    this.cancelled = false;
    const status = await this.checkStatus();
    if (status !== "READY") {
      yield { type: "status", status };
      return;
    }

    await this.setDeepThinkMode(deepThink);

    const messageSelector = ".ds-markdown, .fbb737a4";
    const boundary = await this.captureBoundary(messageSelector);

    const textarea = await this.page.waitForSelector("textarea#chat-input, textarea", { timeout: 15000 });
    await textarea.click();
    await textarea.fill(prompt);
    await this.page.waitForTimeout(300);
    await this.page.keyboard.press("Enter");

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

      const stopBtn = await this.page.$("button[aria-label*='Stop'], .ds-icon--stop, button:has-text('Stop')");

      const turnSnapshot = await this.page.evaluate(
        ({ sel, baselineCount }) => {
          const allNodes = Array.from(document.querySelectorAll(sel)) as HTMLElement[];
          const newNodes = allNodes.filter((el, idx) => !el.hasAttribute("data-freellm-pre-turn") || idx >= baselineCount);
          if (newNodes.length === 0) {
            return { hasNewAnswer: false, answerText: "", thinkingText: "" };
          }

          let thinkingText = "";
          let answerText = "";
          let hasNewAnswer = false;

          for (const node of newNodes) {
            const isInsideThought = Boolean(
              node.closest(".ds-think-content, .ds-thinking, [class*='think'], .thought-container"),
            );
            if (isInsideThought) {
              thinkingText += (node.innerText || "").trim() + "\n";
            } else {
              answerText = (node.innerText || "").trim();
              hasNewAnswer = true;
            }
          }

          return {
            hasNewAnswer,
            answerText,
            thinkingText: thinkingText.trim(),
          };
        },
        { sel: messageSelector, baselineCount: boundary.count },
      );

      if (turnSnapshot.thinkingText) {
        const thinkEvt = tracker.updateThinking(turnSnapshot.thinkingText);
        if (thinkEvt) yield thinkEvt;
      } else {
        const thinkingHeader = await this.page.$(
          ".ds-thinking-header, :has-text('Thinking...'), :has-text('Thought for')",
        );
        if (thinkingHeader && !tracker.isThinkingStarted && !tracker.isAnswerStarted) {
          const thinkEvt = tracker.updateThinking("Thinking...");
          if (thinkEvt) yield thinkEvt;
        }
      }

      if (turnSnapshot.hasNewAnswer) {
        const isStaleDuplicate =
          boundary.count > 0 &&
          !tracker.isAnswerStarted &&
          turnSnapshot.answerText === boundary.lastResponseText &&
          !stopBtn;

        if (!isStaleDuplicate) {
          const ansEvt = tracker.updateAnswer(turnSnapshot.answerText);
          if (ansEvt) yield ansEvt;
        }
      }

      if (tracker.isAnswerStarted && turnSnapshot.hasNewAnswer && !stopBtn && tracker.stabilityTicks >= 3) {
        yield { type: "status", status: "COMPLETED" };
        return;
      }
    }

    yield {
      type: "error",
      message: "انتهت مهلة انتظار اكتمال الرد من DeepSeek دون استقرار الإجابة النهائية.",
    };
    yield { type: "status", status: "TIMEOUT" };
  }
}
