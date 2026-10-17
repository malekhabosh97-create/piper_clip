/**
 * SSE Stream Buffer & Response Stabilizer
 * Preserves incomplete multi-byte UTF-8 / TCP chunks across boundaries,
 * guarantees strict event ordering, and handles in-place text replacement or shortening.
 */

export interface StreamEventPayload {
  type: "token" | "thinking" | "status" | "error" | "replace" | "done" | "tool_call" | "session_meta";
  text?: string;
  thinkingText?: string;
  status?: string;
  message?: string;
  conversationUrl?: string;
  conversationId?: string;
  isInitialized?: boolean;
  toolCall?: {
    id: string;
    tool: string;
    args: Record<string, unknown>;
  };
}

export class SSEChunkBuffer {
  private buffer = "";

  push(chunk: string): StreamEventPayload[] {
    this.buffer += chunk;
    const events: StreamEventPayload[] = [];
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data:")) continue;
      const jsonStr = trimmed.slice(5).trim();
      if (!jsonStr) continue;
      try {
        const parsed = JSON.parse(jsonStr) as StreamEventPayload;
        if (parsed && typeof parsed.type === "string") {
          events.push(parsed);
        }
      } catch {}
    }
    return events;
  }

  flush(): StreamEventPayload[] {
    if (!this.buffer.trim()) {
      this.buffer = "";
      return [];
    }
    const remaining = this.buffer + "\n";
    this.buffer = "";
    return this.push(remaining);
  }
}

export class ResponseTurnTracker {
  private currentAnswer = "";
  private currentThinking = "";
  private stableCount = 0;
  private hasStartedAnswer = false;
  private hasStartedThinking = false;

  updateThinking(rawThinking: string): StreamEventPayload | null {
    const cleaned = rawThinking.trim();
    if (!cleaned) return null;
    if (cleaned !== this.currentThinking) {
      this.currentThinking = cleaned;
      this.hasStartedThinking = true;
      return { type: "thinking", thinkingText: cleaned };
    }
    return null;
  }

  updateAnswer(rawAnswer: string): StreamEventPayload | null {
    if (rawAnswer.length === 0 && !this.hasStartedAnswer) {
      return null;
    }

    if (rawAnswer === this.currentAnswer) {
      if (this.hasStartedAnswer) {
        this.stableCount++;
      }
      return null;
    }

    this.hasStartedAnswer = true;
    this.stableCount = 0;

    if (rawAnswer.length > this.currentAnswer.length && rawAnswer.startsWith(this.currentAnswer)) {
      const delta = rawAnswer.slice(this.currentAnswer.length);
      this.currentAnswer = rawAnswer;
      return { type: "token", text: delta };
    }

    this.currentAnswer = rawAnswer;
    return { type: "replace", text: rawAnswer };
  }

  get answer(): string {
    return this.currentAnswer;
  }

  get thinking(): string {
    return this.currentThinking;
  }

  get isAnswerStarted(): boolean {
    return this.hasStartedAnswer;
  }

  get isThinkingStarted(): boolean {
    return this.hasStartedThinking;
  }

  get stabilityTicks(): number {
    return this.stableCount;
  }
}
