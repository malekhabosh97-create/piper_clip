import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export interface ProposalEvaluationScores {
  correctness: number;
  projectFit: number;
  stepClarity: number;
  dependencies: number;
  testability: number;
  executionCost: number;
}

export interface CouncilProposal {
  id: string;
  agentId: string;
  agentName: string;
  platform: string;
  model: string;
  summary: string;
  steps: Array<{
    title: string;
    assignedRole: string;
    inputs: string[];
    outputs: string[];
    allowedPaths: string[];
    acceptanceCriteria: string;
    dependsOnStepIndices?: number[];
  }>;
  scores?: ProposalEvaluationScores;
  totalWeightedScore?: number;
  createdAt: string;
}

export interface CouncilDecisionRecord {
  id: string;
  projectId: string;
  taskTitle: string;
  round: number;
  maxRounds: number;
  proposals: CouncilProposal[];
  selectedProposalId: string | null;
  rationale: string;
  escalatedToUser: boolean;
  escalationReason?: string;
  decidedAt: string;
}

export type AgentMessageType =
  | "assignment"
  | "question"
  | "blocker"
  | "review_request"
  | "deliverable_submission"
  | "revision_request";

export interface InternalAgentMessage {
  id: string;
  fromAgentId: string;
  toAgentId: string;
  projectId: string;
  taskId: string;
  messageType: AgentMessageType;
  content: string;
  fileReferences: string[];
  artifactReferences: string[];
  acknowledgedAt?: string;
  verifiedCompletion?: boolean;
  createdAt: string;
}

export interface ProjectMemoryIndex {
  projectId: string;
  workspaceRoot: string;
  indexedAt: string;
  techStack: string[];
  runCommands: string[];
  testCommands: string[];
  topLevelStructure: string[];
  keyFilesHash: Record<string, string>;
  approvedDecisions: Array<{
    id: string;
    summary: string;
    decidedAt: string;
    fileRefs: string[];
  }>;
}

export interface RndBacklogItem {
  id: string;
  discoveredByAgentId: string;
  title: string;
  category: "platform" | "free_model" | "tool" | "workflow";
  stabilityScore: number;
  benefitScore: number;
  sandboxTested: boolean;
  status: "proposed" | "sandbox_testing" | "approved" | "rejected";
  notes: string;
  createdAt: string;
}

function sha256File(filePath: string): string {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex").slice(0, 16);
  } catch {
    return "";
  }
}

export class FreeLLMOrchestratorStore {
  private storageDir: string;

  constructor(storageDir: string) {
    this.storageDir = storageDir;
    fs.mkdirSync(this.storageDir, { recursive: true });
  }

  private readJson<T>(filename: string, fallback: T): T {
    const p = path.resolve(this.storageDir, filename);
    try {
      if (fs.existsSync(p)) {
        return JSON.parse(fs.readFileSync(p, "utf8")) as T;
      }
    } catch {}
    return fallback;
  }

  private writeJson<T>(filename: string, data: T): void {
    const p = path.resolve(this.storageDir, filename);
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmp, p);
  }

  scoreProposal(scores: ProposalEvaluationScores): number {
    const weights = {
      correctness: 0.25,
      projectFit: 0.2,
      stepClarity: 0.15,
      dependencies: 0.15,
      testability: 0.15,
      executionCost: 0.1,
    };
    const weighted =
      scores.correctness * weights.correctness +
      scores.projectFit * weights.projectFit +
      scores.stepClarity * weights.stepClarity +
      scores.dependencies * weights.dependencies +
      scores.testability * weights.testability +
      scores.executionCost * weights.executionCost;
    return Number(weighted.toFixed(2));
  }

  evaluateCouncilRound(params: {
    projectId: string;
    taskTitle: string;
    round: number;
    maxRounds?: number;
    proposals: CouncilProposal[];
  }): CouncilDecisionRecord {
    const maxRounds = params.maxRounds ?? 2;
    const evaluated = params.proposals.map((p) => {
      const scores: ProposalEvaluationScores = p.scores ?? {
        correctness: 8,
        projectFit: 8,
        stepClarity: Math.min(10, Math.max(5, p.steps.length * 2)),
        dependencies: 8,
        testability: p.steps.some((s) => s.acceptanceCriteria.length > 10) ? 9 : 6,
        executionCost: 8,
      };
      return {
        ...p,
        scores,
        totalWeightedScore: this.scoreProposal(scores),
      };
    });

    evaluated.sort((a, b) => (b.totalWeightedScore ?? 0) - (a.totalWeightedScore ?? 0));
    const top = evaluated[0];
    const runnerUp = evaluated[1];

    const isCloseTie =
      top &&
      runnerUp &&
      Math.abs((top.totalWeightedScore ?? 0) - (runnerUp.totalWeightedScore ?? 0)) < 0.35;
    const escalate = Boolean(isCloseTie && params.round >= maxRounds);

    const record: CouncilDecisionRecord = {
      id: `council_${Date.now()}`,
      projectId: params.projectId,
      taskTitle: params.taskTitle,
      round: params.round,
      maxRounds,
      proposals: evaluated,
      selectedProposalId: escalate ? null : (top?.id ?? null),
      rationale: escalate
        ? `تعادل متقارب بين مقترح ${top?.agentName} (${top?.totalWeightedScore}) ومقترح ${runnerUp?.agentName} (${runnerUp?.totalWeightedScore}) بعد بلوغ الحد الأقصى لجولات النقاش (${maxRounds}). تم التصعيد للمستخدم لحسم القرار.`
        : `تم اختيار مقترح ${top?.agentName} بمجموع موزون (${top?.totalWeightedScore}/10) لتفوقه في وضوح الخطوات وقابلية الاختبار وملاءمة المشروع.`,
      escalatedToUser: escalate,
      escalationReason: escalate ? "Unresolved council tie after max discussion rounds" : undefined,
      decidedAt: new Date().toISOString(),
    };

    const history = this.readJson<CouncilDecisionRecord[]>("council-decisions.json", []);
    history.unshift(record);
    this.writeJson("council-decisions.json", history.slice(0, 100));
    return record;
  }

  listCouncilDecisions(): CouncilDecisionRecord[] {
    return this.readJson<CouncilDecisionRecord[]>("council-decisions.json", []);
  }

  sendMessage(msg: Omit<InternalAgentMessage, "id" | "createdAt">): InternalAgentMessage {
    const messages = this.readJson<InternalAgentMessage[]>("agent-messages.json", []);
    const record: InternalAgentMessage = {
      ...msg,
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      createdAt: new Date().toISOString(),
    };
    messages.unshift(record);
    this.writeJson("agent-messages.json", messages.slice(0, 500));
    return record;
  }

  acknowledgeMessage(messageId: string): InternalAgentMessage | null {
    const messages = this.readJson<InternalAgentMessage[]>("agent-messages.json", []);
    const target = messages.find((m) => m.id === messageId);
    if (!target) return null;
    target.acknowledgedAt = new Date().toISOString();
    this.writeJson("agent-messages.json", messages);
    return target;
  }

  verifyDeliverableMessage(messageId: string, workspaceRoot: string): {
    verified: boolean;
    missingFiles: string[];
  } {
    const messages = this.readJson<InternalAgentMessage[]>("agent-messages.json", []);
    const target = messages.find((m) => m.id === messageId);
    if (!target) return { verified: false, missingFiles: ["Message not found"] };

    const missingFiles: string[] = [];
    for (const relFile of target.fileReferences) {
      const abs = path.resolve(workspaceRoot, relFile);
      if (!fs.existsSync(abs)) {
        missingFiles.push(relFile);
      }
    }

    target.verifiedCompletion = missingFiles.length === 0;
    this.writeJson("agent-messages.json", messages);
    return { verified: target.verifiedCompletion, missingFiles };
  }

  listMessages(filter?: { taskId?: string; toAgentId?: string }): InternalAgentMessage[] {
    const all = this.readJson<InternalAgentMessage[]>("agent-messages.json", []);
    if (!filter) return all;
    return all.filter(
      (m) =>
        (!filter.taskId || m.taskId === filter.taskId) &&
        (!filter.toAgentId || m.toAgentId === filter.toAgentId),
    );
  }

  buildOrRefreshProjectIndex(projectId: string, workspaceRoot: string): ProjectMemoryIndex {
    const existing = this.readJson<Record<string, ProjectMemoryIndex>>("project-indices.json", {});
    const prev = existing[projectId];

    const topLevel: string[] = [];
    const techStack = new Set<string>();
    const runCommands: string[] = [];
    const testCommands: string[] = [];
    const keyFilesHash: Record<string, string> = {};

    if (fs.existsSync(workspaceRoot)) {
      const entries = fs.readdirSync(workspaceRoot, { withFileTypes: true });
      for (const e of entries) {
        if (e.name.startsWith(".git") || e.name === "node_modules") continue;
        topLevel.push(e.isDirectory() ? `${e.name}/` : e.name);
      }

      const pkgPath = path.resolve(workspaceRoot, "package.json");
      if (fs.existsSync(pkgPath)) {
        techStack.add("Node.js / TypeScript");
        keyFilesHash["package.json"] = sha256File(pkgPath);
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
          const scripts = pkg.scripts || {};
          if (scripts.dev) runCommands.push(`npm run dev (${scripts.dev})`);
          if (scripts.build) runCommands.push(`npm run build`);
          if (scripts.test) testCommands.push(`npm test (${scripts.test})`);
        } catch {}
      }
    }

    const index: ProjectMemoryIndex = {
      projectId,
      workspaceRoot,
      indexedAt: new Date().toISOString(),
      techStack: Array.from(techStack),
      runCommands,
      testCommands,
      topLevelStructure: topLevel.slice(0, 60),
      keyFilesHash,
      approvedDecisions: prev?.approvedDecisions ?? [],
    };

    existing[projectId] = index;
    this.writeJson("project-indices.json", existing);
    return index;
  }

  addRndProposal(item: Omit<RndBacklogItem, "id" | "createdAt">): RndBacklogItem {
    const list = this.readJson<RndBacklogItem[]>("rnd-backlog.json", []);
    const created: RndBacklogItem = {
      ...item,
      id: `rnd_${Date.now()}`,
      createdAt: new Date().toISOString(),
    };
    list.unshift(created);
    this.writeJson("rnd-backlog.json", list);
    return created;
  }

  listRndProposals(): RndBacklogItem[] {
    return this.readJson<RndBacklogItem[]>("rnd-backlog.json", []);
  }
}
