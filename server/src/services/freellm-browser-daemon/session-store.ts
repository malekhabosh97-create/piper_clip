import fs from "node:fs";
import path from "node:path";

export type SupportedPlatform = "gemini" | "deepseek" | "arena";

export interface PersistedAgentSession {
  sessionId: string;
  agentId?: string;
  companyId?: string;
  projectId?: string;
  issueId?: string;
  platform: SupportedPlatform;
  model: string;
  conversationUrl: string;
  conversationId: string;
  isInitialized: boolean;
  initializedAt?: string;
  systemPromptHash?: string;
  lastSummary?: string;
  lastResponsePreview?: string;
  turnCount: number;
  status: "IDLE" | "GENERATING" | "NEEDS_LOGIN" | "NEEDS_HUMAN_INTERVENTION" | "QUOTA_EXCEEDED" | "CANCELLED" | "ERROR";
  lastError?: string;
  lastActiveAt: number;
}

export class PersistentSessionRegistry {
  private sessions = new Map<string, PersistedAgentSession>();
  private storeFilePath: string;

  constructor(profileDir: string) {
    fs.mkdirSync(profileDir, { recursive: true });
    this.storeFilePath = path.resolve(profileDir, "sessions-registry.json");
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    try {
      if (fs.existsSync(this.storeFilePath)) {
        const raw = fs.readFileSync(this.storeFilePath, "utf8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (item && typeof item.sessionId === "string") {
              // Reset transient GENERATING status on startup recovery
              if (item.status === "GENERATING") {
                item.status = "IDLE";
              }
              this.sessions.set(item.sessionId, item);
            }
          }
        }
      }
    } catch (err) {
      console.warn("[SessionRegistry] Could not load sessions-registry.json:", err);
    }
  }

  private saveToDisk(): void {
    try {
      const data = Array.from(this.sessions.values());
      const tmpPath = `${this.storeFilePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
      fs.renameSync(tmpPath, this.storeFilePath);
    } catch (err) {
      console.warn("[SessionRegistry] Could not persist sessions-registry.json:", err);
    }
  }

  get(sessionId: string): PersistedAgentSession | undefined {
    return this.sessions.get(sessionId);
  }

  upsert(sessionId: string, patch: Partial<PersistedAgentSession> & { platform: SupportedPlatform; model: string }): PersistedAgentSession {
    const existing = this.sessions.get(sessionId);
    const updated: PersistedAgentSession = {
      sessionId,
      agentId: patch.agentId ?? existing?.agentId,
      companyId: patch.companyId ?? existing?.companyId,
      projectId: patch.projectId ?? existing?.projectId,
      issueId: patch.issueId ?? existing?.issueId,
      platform: patch.platform ?? existing?.platform ?? "deepseek",
      model: patch.model ?? existing?.model ?? "deepseek-normal",
      conversationUrl: patch.conversationUrl ?? existing?.conversationUrl ?? "",
      conversationId: patch.conversationId ?? existing?.conversationId ?? "",
      isInitialized: patch.isInitialized ?? existing?.isInitialized ?? false,
      initializedAt: patch.initializedAt ?? existing?.initializedAt,
      systemPromptHash: patch.systemPromptHash ?? existing?.systemPromptHash,
      lastSummary: patch.lastSummary ?? existing?.lastSummary,
      lastResponsePreview: patch.lastResponsePreview ?? existing?.lastResponsePreview,
      turnCount: patch.turnCount ?? existing?.turnCount ?? 0,
      status: patch.status ?? existing?.status ?? "IDLE",
      lastError: patch.lastError !== undefined ? patch.lastError : existing?.lastError,
      lastActiveAt: Date.now(),
    };
    this.sessions.set(sessionId, updated);
    this.saveToDisk();
    return updated;
  }

  markInitialized(
    sessionId: string,
    conversationUrl: string,
    conversationId: string,
    systemPromptHash: string,
  ): PersistedAgentSession | undefined {
    const existing = this.sessions.get(sessionId);
    if (!existing) return undefined;
    existing.isInitialized = true;
    existing.initializedAt = new Date().toISOString();
    existing.conversationUrl = conversationUrl;
    existing.conversationId = conversationId;
    existing.systemPromptHash = systemPromptHash;
    existing.lastActiveAt = Date.now();
    this.saveToDisk();
    return existing;
  }

  invalidateInitialization(sessionId: string, reason?: string): void {
    const existing = this.sessions.get(sessionId);
    if (!existing) return;
    existing.isInitialized = false;
    if (reason) existing.lastError = reason;
    this.saveToDisk();
  }

  list(): PersistedAgentSession[] {
    return Array.from(this.sessions.values()).sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }

  delete(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.saveToDisk();
  }
}

export function extractConversationIdFromUrl(url: string, platform: SupportedPlatform): string {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (platform === "gemini") {
      // e.g. https://gemini.google.com/app/c123456789abcdef
      const appIdx = segments.indexOf("app");
      if (appIdx >= 0 && segments[appIdx + 1]) {
        return segments[appIdx + 1];
      }
    } else if (platform === "deepseek") {
      // e.g. https://chat.deepseek.com/a/chat/s/uuid
      const sIdx = segments.indexOf("s");
      if (sIdx >= 0 && segments[sIdx + 1]) {
        return segments[sIdx + 1];
      }
    } else if (platform === "arena") {
      const cIdx = segments.indexOf("c");
      if (cIdx >= 0 && segments[cIdx + 1]) {
        return segments[cIdx + 1];
      }
    }
    return parsed.SearchParams?.get("id") || segments[segments.length - 1] || "";
  } catch {
    return "";
  }
}
