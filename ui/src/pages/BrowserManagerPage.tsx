import React, { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Globe,
  RefreshCw,
  Eye,
  EyeOff,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  ExternalLink,
  MessageSquare,
  Sparkles,
  Layers,
  Square,
} from "lucide-react";

interface BrowserStatus {
  deepseek: string;
  gemini: string;
  arena?: string;
  activeSessions?: number;
  persistedSessions?: number;
  isGenerating: boolean;
}

interface AgentSessionInfo {
  sessionId: string;
  agentId?: string;
  issueId?: string;
  platform: "gemini" | "deepseek" | "arena";
  model: string;
  conversationUrl: string;
  conversationId: string;
  isInitialized: boolean;
  turnCount: number;
  status: string;
  tabOpen?: boolean;
  isGenerating?: boolean;
  lastActiveAt: number;
}

export function BrowserManagerPage() {
  const [status, setStatus] = useState<BrowserStatus>({
    deepseek: "CHECKING",
    gemini: "CHECKING",
    arena: "CHECKING",
    isGenerating: false,
  });
  const [sessions, setSessions] = useState<AgentSessionInfo[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchStatusAndSessions = async () => {
    setLoading(true);
    try {
      const [statusRes, sessionsRes] = await Promise.all([
        fetch("/api/browser/status"),
        fetch("/api/browser/sessions"),
      ]);
      if (statusRes.ok) {
        setStatus(await statusRes.json());
      } else {
        setStatus({ deepseek: "DISCONNECTED", gemini: "DISCONNECTED", arena: "DISCONNECTED", isGenerating: false });
      }
      if (sessionsRes.ok) {
        const list = await sessionsRes.json();
        if (Array.isArray(list)) setSessions(list);
      }
    } catch {
      setStatus({ deepseek: "DISCONNECTED", gemini: "DISCONNECTED", arena: "DISCONNECTED", isGenerating: false });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStatusAndSessions();
    const timer = setInterval(fetchStatusAndSessions, 4000);
    return () => clearInterval(timer);
  }, []);

  const handleShowWindow = async () => {
    await fetch("/api/browser/show", { method: "POST" }).catch(() => {});
  };

  const handleMinimizeWindow = async () => {
    await fetch("/api/browser/minimize", { method: "POST" }).catch(() => {});
  };

  const handleSwitchTab = async (platform?: string, sessionId?: string) => {
    await fetch("/api/browser/tab/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform, sessionId }),
    }).catch(() => {});
  };

  const handleCancelSession = async (sessionId: string, platform: string) => {
    await fetch("/api/browser/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, platform }),
    }).catch(() => {});
    fetchStatusAndSessions();
  };

  const getBadge = (state?: string) => {
    if (state === "READY") {
      return (
        <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/40 gap-1">
          <CheckCircle2 className="w-3 h-3" /> متصل وجاهز
        </Badge>
      );
    }
    if (state === "NEEDS_LOGIN") {
      return (
        <Badge className="bg-amber-500/20 text-amber-300 border-amber-500/40 gap-1">
          <AlertTriangle className="w-3 h-3" /> يحتاج تسجيل دخول
        </Badge>
      );
    }
    if (state === "NEEDS_HUMAN_INTERVENTION") {
      return (
        <Badge className="bg-rose-500/20 text-rose-300 border-rose-500/40 gap-1">
          <AlertTriangle className="w-3 h-3" /> تحقق بشري (Captcha)
        </Badge>
      );
    }
    if (state === "QUOTA_EXCEEDED") {
      return (
        <Badge className="bg-orange-500/20 text-orange-300 border-orange-500/40 gap-1">
          <AlertTriangle className="w-3 h-3" /> تجاوز الحصة (Quota)
        </Badge>
      );
    }
    return (
      <Badge className="bg-slate-700 text-slate-300 border-slate-600 gap-1">
        <XCircle className="w-3 h-3" /> غير متصل
      </Badge>
    );
  };

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2.5">
            <Globe className="w-6 h-6 text-emerald-400" />
            <span>إدارة المتصفح وجلسات الوكلاء (FreeLLM Browser Bridge)</span>
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            تحكم في جلسات المتصفح الحقيقية، راقب التبويبات المستقلة لكل وكيل، وتدخل عند الحاجة لحل التحقق البشري
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={fetchStatusAndSessions} disabled={loading} className="gap-2">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            تحديث الحالة
          </Button>
          <Button
            variant="default"
            size="sm"
            onClick={handleShowWindow}
            className="gap-2 bg-emerald-600 hover:bg-emerald-500 text-white"
          >
            <Eye className="w-3.5 h-3.5" />
            إظهار المتصفح
          </Button>
          <Button variant="secondary" size="sm" onClick={handleMinimizeWindow} className="gap-2">
            <EyeOff className="w-3.5 h-3.5" />
            تصغير المتصفح
          </Button>
        </div>
      </div>

      {/* Platform Connectors Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        <Card className="bg-[#1e293b] border-slate-800">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base font-semibold text-white flex items-center gap-2">
                <MessageSquare className="w-4 h-4 text-sky-400" />
                <span>DeepSeek Web</span>
              </CardTitle>
              {getBadge(status.deepseek)}
            </div>
            <CardDescription className="text-xs text-slate-400">
              الوضع العادي (V3) ووضع التفكير العميق (R1 DeepThink)
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-xs text-slate-300">
            <div className="bg-slate-900/60 p-3 rounded-lg border border-slate-800 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-slate-400">الأوضاع:</span>
                <span className="text-emerald-400 font-medium">Normal / DeepThink</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-400">الرابط:</span>
                <span className="font-mono text-slate-200">chat.deepseek.com</span>
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleSwitchTab("deepseek")}
              className="w-full text-xs gap-1.5"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              فتح تبويب DeepSeek الرئيسي
            </Button>
          </CardContent>
        </Card>

        <Card className="bg-[#1e293b] border-slate-800">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base font-semibold text-white flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-amber-400" />
                <span>Google Gemini Web</span>
              </CardTitle>
              {getBadge(status.gemini)}
            </div>
            <CardDescription className="text-xs text-slate-400">
              يدعم أوضاع حسابك (Pro / Flash / Flash-Lite / Argon)
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-xs text-slate-300">
            <div className="bg-slate-900/60 p-3 rounded-lg border border-slate-800 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-slate-400">الموديلات:</span>
                <span className="text-amber-300 font-medium">Pro / Flash / Argon</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-400">الرابط:</span>
                <span className="font-mono text-slate-200">gemini.google.com/app</span>
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleSwitchTab("gemini")}
              className="w-full text-xs gap-1.5"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              فتح تبويب Gemini الرئيسي
            </Button>
          </CardContent>
        </Card>

        <Card className="bg-[#1e293b] border-slate-800">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base font-semibold text-white flex items-center gap-2">
                <Layers className="w-4 h-4 text-purple-400" />
                <span>LMArena (Direct Chat)</span>
              </CardTitle>
              {getBadge(status.arena || "READY")}
            </div>
            <CardDescription className="text-xs text-slate-400">
              المحادثة المباشرة المعتمدة أولاً (Direct Chat Mode)
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-xs text-slate-300">
            <div className="bg-slate-900/60 p-3 rounded-lg border border-slate-800 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-slate-400">الوضع المعتمد:</span>
                <span className="text-purple-300 font-medium">Direct Chat First</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-400">الرابط:</span>
                <span className="font-mono text-slate-200">lmarena.ai/?mode=direct</span>
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleSwitchTab("arena")}
              className="w-full text-xs gap-1.5"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              فتح تبويب LMArena المباشر
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Dedicated Agent Sessions Table */}
      <Card className="bg-[#1e293b] border-slate-800">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base font-semibold text-white">
                المحادثات والتبويبات المستقلة للوكلاء ({sessions.length})
              </CardTitle>
              <CardDescription className="text-xs text-slate-400">
                كل وكيل يمتلك محادثة مستقلة بتهيئة لمرة واحدة (One-Time Bootstrap) مفصولة عن بقية الوكلاء
              </CardDescription>
            </div>
            <Badge variant="outline" className="text-xs border-slate-700 text-slate-300">
              التبويبات النشطة حالياً: {status.activeSessions ?? 0}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          {sessions.length === 0 ? (
            <div className="text-center py-8 text-xs text-slate-400 bg-slate-900/40 rounded-lg border border-slate-800">
              لا توجد جلسات وكلاء مسجلة بعد. ابدأ محادثة أو شغّل مهمة ليتم تخصيص تبويب مستقل للوكيل تلقائياً.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-right border-collapse">
                <thead>
                  <tr className="border-b border-slate-800 text-slate-400">
                    <th className="py-2.5 px-3">معرّف الجلسة / الوكيل</th>
                    <th className="py-2.5 px-3">المنصة والموديل</th>
                    <th className="py-2.5 px-3">التهيئة (Bootstrap)</th>
                    <th className="py-2.5 px-3">الحالة</th>
                    <th className="py-2.5 px-3">الدورات</th>
                    <th className="py-2.5 px-3">إجراءات</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70 text-slate-200">
                  {sessions.map((s) => (
                    <tr key={s.sessionId} className="hover:bg-slate-900/40">
                      <td className="py-2.5 px-3 font-mono text-[11px]">
                        <div>{s.sessionId}</div>
                        {s.conversationId && (
                          <div className="text-[10px] text-slate-400">Conv ID: {s.conversationId}</div>
                        )}
                      </td>
                      <td className="py-2.5 px-3">
                        <span className="font-semibold uppercase text-sky-400">{s.platform}</span>{" "}
                        <span className="text-slate-400">({s.model})</span>
                      </td>
                      <td className="py-2.5 px-3">
                        {s.isInitialized ? (
                          <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30 text-[10px]">
                            تمت التهيئة (1x)
                          </Badge>
                        ) : (
                          <Badge className="bg-amber-500/15 text-amber-300 border-amber-500/30 text-[10px]">
                            غير مهيأ بعد
                          </Badge>
                        )}
                      </td>
                      <td className="py-2.5 px-3">
                        <Badge variant="outline" className="text-[10px] font-mono">
                          {s.isGenerating ? "GENERATING" : s.status}
                        </Badge>
                      </td>
                      <td className="py-2.5 px-3 font-mono">{s.turnCount}</td>
                      <td className="py-2.5 px-3 flex items-center gap-1.5">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleSwitchTab(s.platform, s.sessionId)}
                          className="h-7 px-2 text-[11px] gap-1"
                        >
                          <ExternalLink className="w-3 h-3" />
                          إظهار التبويب
                        </Button>
                        {s.isGenerating && (
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => handleCancelSession(s.sessionId, s.platform)}
                            className="h-7 px-2 text-[11px] gap-1"
                          >
                            <Square className="w-3 h-3 fill-current" />
                            إيقاف
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
