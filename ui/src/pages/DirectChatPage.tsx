import React, { useState, useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useCompany } from "@/context/CompanyContext";
import {
  Send,
  Square,
  Sparkles,
  Bot,
  User,
  PlusCircle,
  Trash2,
  ExternalLink,
  Crown,
  CheckCircle2,
  Copy,
  Check,
} from "lucide-react";

interface Agent {
  id: string;
  name: string;
  role: string;
  title?: string;
  adapterConfig?: { model?: string };
  avatarUrl?: string;
}

interface ChatMessage {
  id: string;
  sender: "user" | "agent";
  text: string;
  thinkingText?: string;
  conversationUrl?: string;
  timestamp: string;
  actionProposal?: {
    action: "create_agent";
    name: string;
    role: string;
    title?: string;
    model?: string;
    systemPrompt?: string;
  } | null;
  createdAgentId?: string;
}

export function DirectChatPage() {
  const { selectedCompanyId } = useCompany();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputPrompt, setInputPrompt] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [browserStatus, setBrowserStatus] = useState<any>({
    deepseek: "CHECKING",
    gemini: "CHECKING",
    arena: "CHECKING",
  });
  const [sessionMeta, setSessionMeta] = useState<{
    conversationUrl?: string;
    conversationId?: string;
    isInitialized?: boolean;
  }>({});
  const [isCreatingAgent, setIsCreatingAgent] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);

  const [newAgentForm, setNewAgentForm] = useState({
    name: "",
    role: "engineer",
    title: "",
    model: "gemini-argon",
    systemPrompt: "",
  });

  const abortControllerRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const fetchAgents = async () => {
    if (!selectedCompanyId) return;
    try {
      const res = await fetch(`/api/companies/${selectedCompanyId}/agents`);
      if (res.ok) {
        const data = await res.json();
        setAgents(data);
        if (!selectedAgentId && data.length > 0) {
          const ceo = data.find((a: Agent) => a.role === "ceo" || a.name.includes("CEO"));
          setSelectedAgentId(ceo ? ceo.id : data[0].id);
        }
      }
    } catch (e) {
      console.error("Failed to fetch agents", e);
    }
  };

  const fetchBrowserStatus = async () => {
    try {
      const res = await fetch("/api/browser/status");
      if (res.ok) {
        const data = await res.json();
        setBrowserStatus(data);
      }
    } catch {
      setBrowserStatus({ deepseek: "DISCONNECTED", gemini: "DISCONNECTED", arena: "DISCONNECTED" });
    }
  };

  useEffect(() => {
    fetchAgents();
    fetchBrowserStatus();
    const timer = setInterval(fetchBrowserStatus, 5000);
    return () => clearInterval(timer);
  }, [selectedCompanyId]);

  // Load Chat History centrally from Paperclip Server (not browser localStorage)
  useEffect(() => {
    if (!selectedAgentId) return;
    let active = true;
    fetch(`/api/browser/agent-history/${selectedAgentId}`)
      .then((r) => (r.ok ? r.json() : { messages: [] }))
      .then((data) => {
        if (active && Array.isArray(data.messages)) {
          setMessages(data.messages);
        }
      })
      .catch(() => {
        if (active) setMessages([]);
      });
    return () => {
      active = false;
    };
  }, [selectedAgentId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const selectedAgent = agents.find((a) => a.id === selectedAgentId);
  const activeModel = selectedAgent?.adapterConfig?.model || "gemini-argon";
  const activePlatform = activeModel.startsWith("gemini")
    ? "gemini"
    : activeModel.startsWith("arena")
      ? "arena"
      : "deepseek";
  const isPlatformReady =
    activePlatform === "gemini"
      ? browserStatus.gemini === "READY"
      : activePlatform === "arena"
        ? browserStatus.arena === "READY"
        : browserStatus.deepseek === "READY";

  const parseActionProposal = (text: string) => {
    try {
      const match = text.match(/```(?:json)?\s*(\{[\s\S]*?"action"\s*:\s*"create_agent"[\s\S]*?\})\s*```/);
      let parsed = match && match[1] ? JSON.parse(match[1]) : null;

      if (!parsed) {
        const rawMatch = text.match(/\{[\s\S]*?"action"\s*:\s*"create_agent"[\s\S]*?\}/);
        if (rawMatch) parsed = JSON.parse(rawMatch[0]);
      }

      if (parsed) {
        if (parsed.agent) {
          return {
            action: "create_agent" as const,
            name: parsed.agent.name || "Specialist Agent",
            role: parsed.agent.role || "engineer",
            title: parsed.agent.role || parsed.agent.name,
            model: parsed.agent.model || "gemini-argon",
            systemPrompt: parsed.agent.system_prompt || parsed.agent.description || "",
          };
        }
        return parsed;
      }
    } catch {}
    return null;
  };

  const handleSendMessage = async (textToSend?: string) => {
    const text = (textToSend !== undefined ? textToSend : inputPrompt).trim();
    if (!text || isStreaming || !selectedAgentId) return;

    setInputPrompt("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }

    const userMessage: ChatMessage = {
      id: "usr_" + Date.now(),
      sender: "user",
      text,
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    };

    const agentMessageId = "agt_" + Date.now();
    const placeholderAgentMessage: ChatMessage = {
      id: agentMessageId,
      sender: "agent",
      text: "",
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    };

    setMessages((prev) => [...prev, userMessage, placeholderAgentMessage]);
    setIsStreaming(true);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const res = await fetch("/api/browser/agent-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: selectedAgentId,
          prompt: text,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "فشل الاتصال بالخادم" }));
        throw new Error(err.error || `Error ${res.status}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("لا يمكن قراءة البث (No stream reader)");

      const decoder = new TextDecoder();
      let sseLineBuffer = "";
      let accumulatedText = "";
      let accumulatedThinking = "";
      let latestConvUrl = "";

      const processSseLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) return;
        const jsonStr = trimmed.slice(5).trim();
        if (!jsonStr) return;
        try {
          const data = JSON.parse(jsonStr);
          if (data.type === "token" && data.text) {
            accumulatedText += data.text;
          } else if (data.type === "replace" && typeof data.text === "string") {
            // CRITICAL FIX: Handle in-place replacement or shortening of response text
            accumulatedText = data.text;
          } else if (data.type === "thinking" && data.thinkingText) {
            accumulatedThinking = data.thinkingText;
          } else if (data.type === "session_meta") {
            if (data.conversationUrl) latestConvUrl = data.conversationUrl;
            setSessionMeta((prev) => ({
              conversationUrl: data.conversationUrl || prev.conversationUrl,
              conversationId: data.conversationId || prev.conversationId,
              isInitialized: data.isInitialized ?? prev.isInitialized,
            }));
          } else if (data.type === "content" && data.content) {
            accumulatedText += data.content;
          } else if (data.type === "error") {
            accumulatedText += `\n\n> [!WARNING]\n> ${data.message || "حدث خطأ أثناء التوليد"}`;
          }
        } catch {}
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // CRITICAL FIX: Buffer incomplete lines across fragmented network chunks
        sseLineBuffer += decoder.decode(value, { stream: true });
        const lines = sseLineBuffer.split(/\r?\n/);
        sseLineBuffer = lines.pop() ?? "";

        for (const line of lines) {
          processSseLine(line);
        }

        const proposal = parseActionProposal(accumulatedText);
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === agentMessageId
              ? {
                  ...msg,
                  text: accumulatedText,
                  thinkingText: accumulatedThinking || undefined,
                  conversationUrl: latestConvUrl || undefined,
                  actionProposal: proposal,
                }
              : msg,
          ),
        );
      }

      if (sseLineBuffer.trim()) {
        processSseLine(sseLineBuffer);
      }

      const finalProposal = parseActionProposal(accumulatedText);
      const completedAgentMsg: ChatMessage = {
        id: agentMessageId,
        sender: "agent",
        text: accumulatedText,
        thinkingText: accumulatedThinking || undefined,
        conversationUrl: latestConvUrl || undefined,
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        actionProposal: finalProposal,
      };

      setMessages((prev) =>
        prev.map((msg) => (msg.id === agentMessageId ? completedAgentMsg : msg)),
      );

      // Persist agent response to central server history
      await fetch(`/api/browser/agent-history/${selectedAgentId}/append`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: completedAgentMsg }),
      }).catch(() => {});
    } catch (err: any) {
      if (err.name !== "AbortError") {
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === agentMessageId
              ? {
                  ...msg,
                  text:
                    msg.text ||
                    `⚠️ تعذر استلام الرد: ${err.message}.\nيرجى التأكد من أن المتصفح يعمل وأن التبويب مسجل الدخول إليه.`,
                }
              : msg,
          ),
        );
      }
    } finally {
      setIsStreaming(false);
      abortControllerRef.current = null;
    }
  };

  // CRITICAL FIX: Stop generation both in UI stream AND inside real browser tab via /api/browser/cancel
  const handleStopStreaming = async () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      setIsStreaming(false);
    }
    try {
      await fetch("/api/browser/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: selectedAgentId ? `agent-${selectedAgentId}` : undefined,
          platform: activePlatform,
        }),
      });
    } catch {}
  };

  const handleClearHistory = async () => {
    setMessages([]);
    if (selectedAgentId) {
      await fetch(`/api/browser/agent-history/${selectedAgentId}`, {
        method: "DELETE",
      }).catch(() => {});
    }
  };

  const handleExecuteAgentCreation = async (
    msgId: string,
    proposal: {
      action: "create_agent";
      name: string;
      role: string;
      title?: string;
      model?: string;
      systemPrompt?: string;
    },
  ) => {
    setIsCreatingAgent(true);
    try {
      const res = await fetch("/api/browser/create-agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId: selectedCompanyId,
          name: proposal.name,
          role: proposal.role || "engineer",
          title: proposal.title || proposal.name,
          model: proposal.model || "gemini-argon",
          systemPrompt: proposal.systemPrompt || "",
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "فشل إنشاء الإيجنت" }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const created = await res.json();
      await fetchAgents();
      setMessages((prev) =>
        prev.map((m) => (m.id === msgId ? { ...m, createdAgentId: created.id } : m)),
      );
    } catch (e: any) {
      console.error("حدث خطأ أثناء إنشاء الإيجنت:", e.message);
    } finally {
      setIsCreatingAgent(false);
    }
  };

  const handleManualCreateAgent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newAgentForm.name.trim()) return;
    setIsCreatingAgent(true);
    try {
      const res = await fetch("/api/browser/create-agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId: selectedCompanyId,
          name: newAgentForm.name,
          role: newAgentForm.role,
          title: newAgentForm.title || `${newAgentForm.name} (${newAgentForm.role.toUpperCase()})`,
          model: newAgentForm.model,
          systemPrompt: newAgentForm.systemPrompt,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "فشل إنشاء الإيجنت" }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const created = await res.json();
      await fetchAgents();
      setSelectedAgentId(created.id);
      setShowCreateModal(false);
      setNewAgentForm({
        name: "",
        role: "engineer",
        title: "",
        model: "gemini-argon",
        systemPrompt: "",
      });
    } catch (e: any) {
      console.error("فشل إنشاء الإيجنت:", e.message);
    } finally {
      setIsCreatingAgent(false);
    }
  };

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleBringBrowserToFront = async () => {
    try {
      await fetch("/api/browser/tab/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: selectedAgentId ? `agent-${selectedAgentId}` : undefined,
          platform: activePlatform,
        }),
      });
    } catch (e: any) {
      console.error("تعذر فتح التبويب:", e.message);
    }
  };

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] max-w-6xl mx-auto p-4 gap-4">
      <header className="flex flex-wrap items-center justify-between gap-4 p-4 rounded-xl border border-border bg-card shadow-xs">
        <div className="flex items-center gap-3">
          <div className="relative">
            <div className="w-12 h-12 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center text-primary font-bold text-lg shadow-inner">
              {selectedAgent?.role === "ceo" ? (
                <Crown className="w-6 h-6 text-amber-400" />
              ) : (
                <Bot className="w-6 h-6" />
              )}
            </div>
            <span
              className={`absolute -bottom-1 -right-1 w-3.5 h-3.5 rounded-full border-2 border-card ${
                isPlatformReady ? "bg-emerald-500 animate-pulse" : "bg-amber-500"
              }`}
            />
          </div>

          <div className="flex flex-col">
            <div className="flex items-center gap-2">
              <label htmlFor="agent-select" className="text-xs text-muted-foreground font-semibold">
                الإيجنت المتحدث:
              </label>
              <select
                id="agent-select"
                value={selectedAgentId}
                onChange={(e) => setSelectedAgentId(e.target.value)}
                className="bg-background border border-border text-foreground font-semibold text-sm rounded-md px-2.5 py-1 focus:outline-hidden focus:ring-1 focus:ring-primary cursor-pointer"
              >
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.role.toUpperCase()}) - {a.adapterConfig?.model || "FreeLLM"}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <span className="text-xs text-muted-foreground">{selectedAgent?.title || "AI Agent"}</span>
              <Badge variant="outline" className="text-[11px] py-0 px-1.5 border-primary/30 text-primary">
                {activeModel}
              </Badge>
              <Badge
                variant="outline"
                className={`text-[11px] py-0 px-1.5 ${
                  isPlatformReady
                    ? "border-emerald-500/40 text-emerald-400 bg-emerald-500/10"
                    : "border-amber-500/40 text-amber-400 bg-amber-500/10"
                }`}
              >
                {isPlatformReady ? "متصل بالمتصفح الحي" : "غير متصل / يحتاج فحص"}
              </Badge>
              {sessionMeta.conversationId && (
                <Badge variant="outline" className="text-[10px] py-0 px-1.5 font-mono">
                  الجلسة: {sessionMeta.conversationId.slice(0, 10)}
                </Badge>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleBringBrowserToFront}
            className="text-xs gap-1.5 border-border hover:bg-muted"
            title="إظهار تبويب محادثة هذا الوكيل المستقلة في المتصفح"
          >
            <ExternalLink className="w-3.5 h-3.5 text-primary" />
            <span>تبويب الوكيل المستقل</span>
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowCreateModal(true)}
            className="text-xs gap-1.5 border-primary/30 text-primary hover:bg-primary/10"
          >
            <PlusCircle className="w-3.5 h-3.5" />
            <span>+ إضافة إيجنت</span>
          </Button>

          {messages.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleClearHistory}
              className="text-xs text-muted-foreground hover:text-destructive"
              title="مسح المحادثة"
            >
              <Trash2 className="w-4 h-4" />
            </Button>
          )}
        </div>
      </header>

      <main className="flex-1 overflow-y-auto rounded-xl border border-border bg-card/50 p-4 space-y-5">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center max-w-lg mx-auto space-y-4 py-12">
            <div className="w-16 h-16 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center text-primary">
              <Sparkles className="w-8 h-8" />
            </div>
            <div className="space-y-1.5">
              <h2 className="text-lg font-bold text-foreground">
                محادثة مباشرة ومستقلة مع {selectedAgent?.name || "الإيجنت"}
              </h2>
              <p className="text-xs text-muted-foreground leading-relaxed">
                كل وكيل يعمل في تبويب محادثة مستقل خاص به، مع تهيئة دوره لمرة واحدة وحفظ الجلسة والسجل مركزياً في الخادم.
              </p>
            </div>
          </div>
        ) : (
          messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex gap-3 ${msg.sender === "user" ? "flex-row-reverse" : "flex-row"}`}
            >
              <div
                className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-1 ${
                  msg.sender === "user"
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted border border-border text-foreground"
                }`}
              >
                {msg.sender === "user" ? <User className="w-4 h-4" /> : <Bot className="w-4 h-4" />}
              </div>

              <div
                className={`flex flex-col max-w-[82%] ${
                  msg.sender === "user" ? "items-end" : "items-start"
                }`}
              >
                <div className="flex items-center gap-2 mb-1 px-1">
                  <span className="text-[11px] font-semibold text-muted-foreground">
                    {msg.sender === "user" ? "أنت" : selectedAgent?.name || "الإيجنت"}
                  </span>
                  <span className="text-[10px] text-muted-foreground/70">{msg.timestamp}</span>
                  {msg.sender === "agent" && msg.text && (
                    <button
                      onClick={() => copyToClipboard(msg.text, msg.id)}
                      className="text-muted-foreground hover:text-foreground transition-colors"
                      title="نسخ الرد"
                    >
                      {copiedId === msg.id ? (
                        <Check className="w-3 h-3 text-emerald-400" />
                      ) : (
                        <Copy className="w-3 h-3" />
                      )}
                    </button>
                  )}
                </div>

                <div
                  className={`rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                    msg.sender === "user"
                      ? "bg-primary text-primary-foreground rounded-tr-xs"
                      : "bg-muted/70 border border-border text-foreground rounded-tl-xs"
                  }`}
                >
                  {msg.thinkingText && (
                    <details className="mb-2 text-xs text-muted-foreground bg-background/60 p-2 rounded border border-border">
                      <summary className="cursor-pointer font-medium">عملية التفكير (Thinking)</summary>
                      <pre className="mt-1.5 whitespace-pre-wrap font-mono text-[11px]">
                        {msg.thinkingText}
                      </pre>
                    </details>
                  )}
                  {msg.sender === "user" ? (
                    <div className="whitespace-pre-wrap">{msg.text}</div>
                  ) : (
                    <div className="prose prose-sm dark:prose-invert max-w-none">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {msg.text || (isStreaming ? "جاري التفكير والكتابة من المتصفح..." : "")}
                      </ReactMarkdown>
                    </div>
                  )}

                  {msg.actionProposal && (
                    <div className="mt-3 pt-3 border-t border-border/60 flex items-center justify-between gap-3">
                      <div className="text-xs">
                        <span className="font-semibold text-primary">مقترح إنشاء إيجنت: </span>
                        <span>
                          {msg.actionProposal.name} ({msg.actionProposal.role})
                        </span>
                      </div>
                      {msg.createdAgentId ? (
                        <Badge variant="outline" className="text-emerald-400 border-emerald-500/40 gap-1">
                          <CheckCircle2 className="w-3.5 h-3.5" /> تم الإنشاء
                        </Badge>
                      ) : (
                        <Button
                          size="sm"
                          disabled={isCreatingAgent}
                          onClick={() => handleExecuteAgentCreation(msg.id, msg.actionProposal!)}
                          className="text-xs font-semibold gap-1.5 shadow-sm"
                        >
                          <PlusCircle className="w-4 h-4" />
                          {isCreatingAgent ? "جاري إنشاء الإيجنت..." : "اعتماد وإنشاء الإيجنت الآن"}
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))
        )}
        <div ref={messagesEndRef} />
      </main>

      <footer className="relative flex flex-col gap-2 p-2 rounded-xl border border-border bg-card shadow-sm">
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            rows={1}
            value={inputPrompt}
            onChange={(e) => {
              setInputPrompt(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = `${Math.min(e.target.scrollHeight, 180)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSendMessage();
              }
            }}
            placeholder={`اكتب رسالتك إلى ${selectedAgent?.name || "الوكيل"} هنا... (Shift+Enter لسطر جديد)`}
            className="flex-1 bg-transparent border-0 resize-none p-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-hidden max-h-44 min-h-[44px]"
          />

          {isStreaming ? (
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={handleStopStreaming}
              className="h-10 px-3.5 gap-1.5 font-medium shrink-0"
            >
              <Square className="w-4 h-4 fill-current" />
              <span>إيقاف</span>
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              disabled={!inputPrompt.trim() || !selectedAgentId}
              onClick={() => handleSendMessage()}
              className="h-10 px-4 gap-1.5 font-semibold shrink-0 shadow-xs"
            >
              <span>إرسال</span>
              <Send className="w-4 h-4" />
            </Button>
          )}
        </div>

        <div className="flex items-center justify-between px-2 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <Sparkles className="w-3.5 h-3.5 text-primary" />
            يتم حفظ المحادثة مركزياً في الخادم مع تهيئة الوكيل لمرة واحدة وعزل التبويب
          </span>
          <span>{inputPrompt.length} حرف</span>
        </div>
      </footer>

      {showCreateModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-card border border-border rounded-2xl w-full max-w-md p-6 space-y-4 shadow-xl">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold text-foreground flex items-center gap-2">
                <PlusCircle className="w-5 h-5 text-primary" />
                <span>إضافة إيجنت جديد للشركة</span>
              </h3>
              <button
                onClick={() => setShowCreateModal(false)}
                className="text-muted-foreground hover:text-foreground text-sm font-bold"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleManualCreateAgent} className="space-y-3.5">
              <div>
                <label className="text-xs font-semibold text-foreground">اسم الإيجنت *</label>
                <input
                  type="text"
                  required
                  placeholder="مثال: Senior Python Developer"
                  value={newAgentForm.name}
                  onChange={(e) => setNewAgentForm({ ...newAgentForm, name: e.target.value })}
                  className="w-full mt-1 bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:ring-1 focus:ring-primary focus:outline-hidden"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-foreground">الدور (Role)</label>
                  <select
                    value={newAgentForm.role}
                    onChange={(e) => setNewAgentForm({ ...newAgentForm, role: e.target.value })}
                    className="w-full mt-1 bg-background border border-border rounded-lg px-2.5 py-2 text-sm text-foreground focus:ring-1 focus:ring-primary focus:outline-hidden"
                  >
                    <option value="engineer">مهندس (Engineer)</option>
                    <option value="cto">CTO (مخطط ومعماري)</option>
                    <option value="qa">QA (مختبر ومراجع)</option>
                    <option value="pm">PM (مدير تنفيذ ودمج)</option>
                    <option value="researcher">Researcher (بحث وتطوير)</option>
                    <option value="general">عام (General)</option>
                  </select>
                </div>

                <div>
                  <label className="text-xs font-semibold text-foreground">الموديل المخصص</label>
                  <select
                    value={newAgentForm.model}
                    onChange={(e) => setNewAgentForm({ ...newAgentForm, model: e.target.value })}
                    className="w-full mt-1 bg-background border border-border rounded-lg px-2.5 py-2 text-sm text-foreground focus:ring-1 focus:ring-primary focus:outline-hidden"
                  >
                    <option value="gemini-argon">Gemini 4 Argon</option>
                    <option value="gemini-pro">Gemini 3.1 Pro</option>
                    <option value="gemini-flash">Gemini 3.8 Flash</option>
                    <option value="deepseek-normal">DeepSeek V3 (Normal)</option>
                    <option value="deepseek-deepthink">DeepSeek R1 (DeepThink)</option>
                    <option value="arena-direct">LMArena (Direct Chat)</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="text-xs font-semibold text-foreground">المسمى الوظيفي (Title)</label>
                <input
                  type="text"
                  placeholder="مثال: مطور الذكاء الاصطناعي والتطبيقات"
                  value={newAgentForm.title}
                  onChange={(e) => setNewAgentForm({ ...newAgentForm, title: e.target.value })}
                  className="w-full mt-1 bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:ring-1 focus:ring-primary focus:outline-hidden"
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-foreground">التعليمات والتوجيهات (System Prompt)</label>
                <textarea
                  rows={3}
                  placeholder="حدد دور الإيجنت واختصاصه وكيف ينجز المهام..."
                  value={newAgentForm.systemPrompt}
                  onChange={(e) => setNewAgentForm({ ...newAgentForm, systemPrompt: e.target.value })}
                  className="w-full mt-1 bg-background border border-border rounded-lg p-2.5 text-xs text-foreground focus:ring-1 focus:ring-primary focus:outline-hidden resize-none"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setShowCreateModal(false)}
                  className="text-xs"
                >
                  إلغاء
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  disabled={isCreatingAgent || !newAgentForm.name.trim()}
                  className="text-xs font-semibold"
                >
                  {isCreatingAgent ? "جاري الإنشاء..." : "إنشاء الإيجنت الآن"}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
