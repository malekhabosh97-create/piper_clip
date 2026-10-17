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

  /**
   * Push a raw UTF-8 string chunk (decoded with TextDecoder({ stream: true }))
   * and extract all complete `data: {...}` events in strict arrival order.
   */
  push(chunk: string): StreamEventPayload[] {
    this.buffer += chunk;
    const events: StreamEventPayload[] = [];
    const lines = this.buffer.split(/\r?\n/);
    // Keep the last potentially incomplete line in buffer
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
      } catch {
        // Ignore malformed non-JSON comment lines
      }
    }
    return events;
  }

  /**
   * Flush any remaining complete event at stream end.
   */
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

/**
 * Tracks a model response as it mutates in DOM.
 * Handles append, in-place replacement, and shortening without assuming monotonic growth.
 */
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

    // Case 1: Pure append (new text starts with previous text)
    if (rawAnswer.length > this.currentAnswer.length && rawAnswer.startsWith(this.currentAnswer)) {
      const delta = rawAnswer.slice(this.currentAnswer.length);
      this.currentAnswer = rawAnswer;
      return { type: "token", text: delta };
    }

    // Case 2: Text was shortened, corrected in-place, or replaced mid-stream
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
