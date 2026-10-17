import { Router } from "express";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import { agents as agentsTable, companies } from "@paperclipai/db";
import { eq } from "drizzle-orm";

export function freellmBrowserRouter(db?: Db): Router {
  const router = Router();

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

  function forwardToDaemon(pathName: string, method: string, res: any, reqBody?: any) {
    const daemonPort = Number(process.env.FREELLM_DAEMON_PORT) || 3150;
    const token = getDaemonToken();
    const payload = reqBody ? JSON.stringify(reqBody) : undefined;
    const headers: Record<string, string> = {
      "x-freellm-auth": token,
      "Content-Type": "application/json",
    };
    if (payload) {
      headers["Content-Length"] = String(Buffer.byteLength(payload));
    }

    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: daemonPort,
        path: pathName,
        method,
        headers,
      },
      (daemonRes) => {
        res.writeHead(daemonRes.statusCode || 200, daemonRes.headers);
        daemonRes.pipe(res);
      },
    );
    req.setTimeout(0);
    res.on("close", () => {
      req.destroy();
    });
    req.on("error", (err) => {
      if (!res.headersSent) {
        res.status(502).json({ error: "Browser Daemon unreachable", message: err.message });
      }
    });
    if (payload) {
      req.write(payload);
    }
    req.end();
  }

  router.get("/status", (_req, res) => forwardToDaemon("/status", "GET", res));
  router.get("/sessions", (_req, res) => forwardToDaemon("/sessions", "GET", res));
  router.post("/show", (_req, res) => forwardToDaemon("/window/show", "POST", res));
  router.post("/minimize", (_req, res) => forwardToDaemon("/window/minimize", "POST", res));
  router.post("/tab/open", (req, res) => forwardToDaemon("/tab/open", "POST", res, req.body));
  router.post("/cancel", (req, res) => forwardToDaemon("/cancel", "POST", res, req.body));
  router.post("/chat", (req, res) => forwardToDaemon("/chat", "POST", res, req.body));

  router.post("/agent-chat", async (req, res) => {
    try {
      const { agentId, prompt } = req.body;
      if (!agentId || !prompt) {
        res.status(400).json({ error: "Missing agentId or prompt" });
        return;
      }

      let model = "gemini-argon";
      let systemPrompt = "";
      if (db) {
        const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.id, agentId));
        if (agent) {
          const cfg = (agent.adapterConfig as any) || {};
          if (cfg.model) model = cfg.model;
          if (cfg.instructionsFilePath && fs.existsSync(cfg.instructionsFilePath)) {
            try {
              systemPrompt = fs.readFileSync(cfg.instructionsFilePath, "utf8").trim();
            } catch {}
          }
        }
      }

      const platform = model.startsWith("gemini") ? "gemini" : "deepseek";
      const deepThink = model.includes("thinking") || model.includes("r1");

      forwardToDaemon("/chat", "POST", res, {
        prompt,
        platform,
        model,
        deepThink,
        sessionId: agentId,
        systemPrompt: systemPrompt || undefined,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/create-agent", async (req, res) => {
    try {
      const { companyId, name, role = "general", title, model = "gemini-argon", systemPrompt } = req.body;
      if (!name) {
        res.status(400).json({ error: "Agent name is required" });
        return;
      }

      let targetCompanyId = companyId;
      if (!targetCompanyId && db) {
        const [comp] = await db.select().from(companies).limit(1);
        if (comp) targetCompanyId = comp.id;
      }

      if (!targetCompanyId) {
        res.status(400).json({ error: "Company ID required" });
        return;
      }

      const serverPort = Number(process.env.PORT) || 3100;
      const agentPayload = JSON.stringify({
        name,
        role,
        title: title || `${name} (${role.toUpperCase()})`,
        adapterType: "freellm_browser",
        adapterConfig: { model },
        permissions: { canCreateAgents: true, canCreateSkills: true },
      });

      const createReq = http.request(
        {
          hostname: "127.0.0.1",
          port: serverPort,
          path: `/api/companies/${targetCompanyId}/agents`,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(agentPayload),
          },
        },
        (createRes) => {
          let data = "";
          createRes.on("data", (c) => (data += c));
          createRes.on("end", () => {
            try {
              const createdAgent = JSON.parse(data);
              if (systemPrompt && createdAgent?.adapterConfig?.instructionsFilePath) {
                try {
                  fs.writeFileSync(createdAgent.adapterConfig.instructionsFilePath, systemPrompt, "utf8");
                } catch (e) {
                  console.error("Failed to write custom instructions:", e);
                }
              }
              res.status(createRes.statusCode || 201).json(createdAgent);
            } catch (err: any) {
              res.status(500).json({ error: "Failed to parse agent creation response", raw: data });
            }
          });
        },
      );
      createReq.on("error", (e) => res.status(502).json({ error: e.message }));
      createReq.write(agentPayload);
      createReq.end();
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
