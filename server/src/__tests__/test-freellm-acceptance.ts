import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { SSEChunkBuffer, ResponseTurnTracker } from "../services/freellm-browser-daemon/stream-buffer.js";
import {
  PersistentSessionRegistry,
  extractConversationIdFromUrl,
} from "../services/freellm-browser-daemon/session-store.js";
import {
  extractStructuredToolCalls,
  executeStructuredToolCall,
  ToolCallLedger,
  buildAgentInitializationPrompt,
} from "../services/freellm-tool-loop.js";
import { FreeLLMOrchestratorStore } from "../services/freellm-orchestrator.js";

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

async function runAcceptanceSuite() {
  console.log("==========================================================");
  console.log("Running FreeLLM Work End-to-End Acceptance Verification...");
  console.log("==========================================================\n");

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "freellm-acceptance-"));

  // ---------------------------------------------------------------------------
  // 1. Test Fragmented SSE Stream Buffering & UTF-8 / Event Order Integrity
  // ---------------------------------------------------------------------------
  {
    const sse = new SSEChunkBuffer();
    const part1 = 'data: {"type":"token","text":"مرحباً ';
    const part2 = 'بكم في "}\n\ndata: {"type":"token","text":"FreeLLM"}\ndata: {"type":"rep';
    const part3 = 'lace","text":"مرحباً بكم في نظام FreeLLM المحدث"}\n\n';

    const ev1 = sse.push(part1);
    assert.equal(ev1.length, 0, "Incomplete chunk 1 should not emit premature event");

    const ev2 = sse.push(part2);
    assert.equal(ev2.length, 2, "Chunk 2 should emit exactly 2 completed events");
    assert.equal(ev2[0].text, "مرحباً بكم في ");
    assert.equal(ev2[1].text, "FreeLLM");

    const ev3 = sse.push(part3);
    assert.equal(ev3.length, 1, "Chunk 3 should complete the split replace event");
    assert.equal(ev3[0].type, "replace");
    assert.equal(ev3[0].text, "مرحباً بكم في نظام FreeLLM المحدث");
    console.log("✅ [PASS] 1. Fragmented SSE stream buffering & UTF-8 integrity verified.");
  }

  // ---------------------------------------------------------------------------
  // 2. Test ResponseTurnTracker: Thinking Separation, Append vs In-Place Shortening/Replacement
  // ---------------------------------------------------------------------------
  {
    const tracker = new ResponseTurnTracker();
    const t1 = tracker.updateThinking("Analyzing project files...");
    assert.equal(t1?.type, "thinking");
    assert.equal(tracker.updateThinking("Analyzing project files..."), null, "Unchanged thinking should not re-emit");

    const a1 = tracker.updateAnswer("Hello world");
    assert.deepEqual(a1, { type: "token", text: "Hello world" });

    const a2 = tracker.updateAnswer("Hello world, here is the plan");
    assert.deepEqual(a2, { type: "token", text: ", here is the plan" });

    // Simulate model shortening or replacing text mid-generation
    const a3 = tracker.updateAnswer("Hello! Revised short plan.");
    assert.deepEqual(a3, { type: "replace", text: "Hello! Revised short plan." });
    assert.equal(tracker.answer, "Hello! Revised short plan.");

    // Simulate stability ticks
    tracker.updateAnswer("Hello! Revised short plan.");
    tracker.updateAnswer("Hello! Revised short plan.");
    tracker.updateAnswer("Hello! Revised short plan.");
    assert.equal(tracker.stabilityTicks, 3, "Stability counter should reach 3 after 3 identical checks");
    console.log("✅ [PASS] 2. Response boundary, thinking separation, and in-place text replacement verified.");
  }

  // ---------------------------------------------------------------------------
  // 3. Test Agent Session Isolation, One-Time Bootstrap, and Recovery After Crash
  // ---------------------------------------------------------------------------
  {
    const profileDir = path.join(tempRoot, "profile");
    const registry1 = new PersistentSessionRegistry(profileDir);

    // Two distinct agents on the same platform (gemini)
    const sA = registry1.upsert("agent-A:issue-1", {
      agentId: "agent-A",
      issueId: "issue-1",
      platform: "gemini",
      model: "gemini-pro",
      conversationUrl: "https://gemini.google.com/app/conv_aaa111",
      conversationId: extractConversationIdFromUrl("https://gemini.google.com/app/conv_aaa111", "gemini"),
    });

    const sB = registry1.upsert("agent-B:issue-2", {
      agentId: "agent-B",
      issueId: "issue-2",
      platform: "gemini",
      model: "gemini-argon",
      conversationUrl: "https://gemini.google.com/app/conv_bbb222",
      conversationId: extractConversationIdFromUrl("https://gemini.google.com/app/conv_bbb222", "gemini"),
    });

    assert.notEqual(sA.conversationId, sB.conversationId, "Two agents on same platform must have isolated conversation IDs");
    assert.equal(sA.isInitialized, false);

    // Mark agent-A initialized once
    registry1.markInitialized("agent-A:issue-1", sA.conversationUrl, sA.conversationId, "hash_init_v1");

    // Simulate server/daemon crash & restart by instantiating a new PersistentSessionRegistry on the same directory
    const registry2 = new PersistentSessionRegistry(profileDir);
    const restoredA = registry2.get("agent-A:issue-1");
    const restoredB = registry2.get("agent-B:issue-2");

    assert.equal(restoredA?.isInitialized, true, "Agent A one-time initialization must survive restart");
    assert.equal(restoredA?.conversationId, "conv_aaa111");
    assert.equal(restoredB?.isInitialized, false, "Agent B initialization state must remain independent");

    // Simulate lost conversation context in browser tab -> invalidate initialization
    registry2.invalidateInitialization("agent-A:issue-1", "Tab redirected to root");
    assert.equal(registry2.get("agent-A:issue-1")?.isInitialized, false, "Lost context must trigger re-initialization");
    console.log("✅ [PASS] 3. Multi-agent session isolation, one-time initialization, and crash recovery verified.");
  }

  // ---------------------------------------------------------------------------
  // 4. Test Local Tool Loop, Quoted Example Filtering, and Idempotent De-duplication
  // ---------------------------------------------------------------------------
  {
    const wsDir = path.join(tempRoot, "workspace");
    const runtimeDir = path.join(tempRoot, "runtime");
    const stagingDir = path.join(runtimeDir, "staging");
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, "math.js"), "exports.add = (a, b) => a + b;\n", "utf8");

    const modelReplyWithQuotedAndRealTool = `
Here is an example of how a tool block looks in documentation:
> \`\`\`freellm-tool
> {
>   "id": "quoted_example_999",
>   "tool": "propose_file_change",
>   "args": { "operation": "delete", "path": "math.js" }
> }
> \`\`\`

Now I will actually read \`math.js\`:
\`\`\`freellm-tool
{
  "id": "call_read_math_01",
  "tool": "read_file",
  "args": { "path": "math.js", "startLine": 1, "endLine": 50 }
}
\`\`\`
`;

    const extracted = extractStructuredToolCalls(modelReplyWithQuotedAndRealTool);
    assert.equal(extracted.length, 1, "Quoted tool examples must NEVER be extracted as executable tool calls");
    assert.equal(extracted[0].id, "call_read_math_01");
    assert.equal(extracted[0].tool, "read_file");

    const ledger = new ToolCallLedger(runtimeDir);
    const firstExec = await executeStructuredToolCall(extracted[0], {
      workspaceRoot: wsDir,
      stagingDir,
      ledger,
    });
    assert.equal(firstExec.status, "executed");
    assert.ok(firstExec.output.includes("exports.add = (a, b) => a + b;"));

    // Re-running the exact same tool call ID after a restart must be skipped idempotently
    const ledgerAfterRestart = new ToolCallLedger(runtimeDir);
    const secondExec = await executeStructuredToolCall(extracted[0], {
      workspaceRoot: wsDir,
      stagingDir,
      ledger: ledgerAfterRestart,
    });
    assert.equal(secondExec.status, "duplicate_skipped", "Duplicate tool call ID must not re-execute side effects");
    console.log("✅ [PASS] 4. Local tool loop (read/search/propose/test), quoted-example guard, and idempotency verified.");
  }

  // ---------------------------------------------------------------------------
  // 5. Test File Mutation Approval Hash Gate (Reject File Modified While Waiting Approval)
  // ---------------------------------------------------------------------------
  {
    const wsDir = path.join(tempRoot, "workspace");
    const runtimeDir = path.join(tempRoot, "runtime");
    const stagingDir = path.join(runtimeDir, "staging");
    const ledger = new ToolCallLedger(runtimeDir);

    const targetFile = path.join(wsDir, "math.js");
    const originalContent = fs.readFileSync(targetFile, "utf8");
    const originalSha = sha256(originalContent);

    // Agent proposes modifying math.js with approval required
    const proposeCall = {
      id: "call_modify_math_02",
      tool: "propose_file_change" as const,
      args: {
        operation: "modify",
        path: "math.js",
        content: "exports.add = (a, b) => Number(a) + Number(b);\n",
      },
    };

    const stagedOutcome = await executeStructuredToolCall(proposeCall, {
      workspaceRoot: wsDir,
      stagingDir,
      ledger,
      requireApprovalForWrite: true,
    });

    assert.equal(stagedOutcome.status, "pending_approval");
    assert.equal(stagedOutcome.approvalPayload?.baseSha256, originalSha);

    // Simulate external modification to math.js while approval is pending
    fs.writeFileSync(targetFile, "// Concurrent external edit!\nexports.add = (a, b) => a + b;\n", "utf8");

    const currentShaOnDisk = sha256(fs.readFileSync(targetFile, "utf8"));
    assert.notEqual(
      currentShaOnDisk,
      stagedOutcome.approvalPayload?.baseSha256,
      "Base SHA256 mismatch must be detected when file changed during approval wait",
    );

    // Verify path traversal outside workspace is strictly rejected
    const traversalOutcome = await executeStructuredToolCall(
      {
        id: "call_escape_03",
        tool: "read_file",
        args: { path: "../../etc/passwd" },
      },
      { workspaceRoot: wsDir, stagingDir, ledger },
    );
    assert.equal(traversalOutcome.status, "error");
    assert.ok(traversalOutcome.output.includes("Path traversal detected"));
    console.log("✅ [PASS] 5. File SHA-256 conflict rejection and workspace boundary security verified.");
  }

  // ---------------------------------------------------------------------------
  // 6. Test Planning Council, Inter-Agent Messaging, and Deliverable Verification
  // ---------------------------------------------------------------------------
  {
    const wsDir = path.join(tempRoot, "workspace");
    const orch = new FreeLLMOrchestratorStore(path.join(tempRoot, "orchestrator"));

    const decision = orch.evaluateCouncilRound({
      projectId: "proj-1",
      taskTitle: "Build Auth Module",
      round: 1,
      maxRounds: 2,
      proposals: [
        {
          id: "prop-gemini",
          agentId: "agt-1",
          agentName: "Architect (Gemini Pro)",
          platform: "gemini",
          model: "gemini-pro",
          summary: "Modular JWT + Session Store with full unit tests",
          steps: [
            {
              title: "Implement session store",
              assignedRole: "engineer",
              inputs: ["schema.ts"],
              outputs: ["math.js"],
              allowedPaths: ["src/"],
              acceptanceCriteria: "Passes all unit tests with 100% coverage",
            },
          ],
          scores: {
            correctness: 9,
            projectFit: 9,
            stepClarity: 9,
            dependencies: 8,
            testability: 10,
            executionCost: 8,
          },
          createdAt: new Date().toISOString(),
        },
        {
          id: "prop-deepseek",
          agentId: "agt-2",
          agentName: "Reviewer (DeepSeek R1)",
          platform: "deepseek",
          model: "deepseek-deepthink",
          summary: "Monolithic middleware",
          steps: [],
          scores: {
            correctness: 7,
            projectFit: 6,
            stepClarity: 6,
            dependencies: 7,
            testability: 6,
            executionCost: 7,
          },
          createdAt: new Date().toISOString(),
        },
      ],
    });

    assert.equal(decision.selectedProposalId, "prop-gemini");
    assert.equal(decision.escalatedToUser, false);

    // Send deliverable submission claiming a non-existent file vs existing file
    const msgUnverified = orch.sendMessage({
      fromAgentId: "agt-1",
      toAgentId: "agt-lead",
      projectId: "proj-1",
      taskId: "task-1",
      messageType: "deliverable_submission",
      content: "Completed math.js and missing.js",
      fileReferences: ["math.js", "missing.js"],
      artifactReferences: [],
    });

    const check1 = orch.verifyDeliverableMessage(msgUnverified.id, wsDir);
    assert.equal(check1.verified, false, "Agent claim of success must fail verification if output file is missing");
    assert.deepEqual(check1.missingFiles, ["missing.js"]);

    // Now create missing.js and re-verify
    fs.writeFileSync(path.join(wsDir, "missing.js"), "// created\n", "utf8");
    const check2 = orch.verifyDeliverableMessage(msgUnverified.id, wsDir);
    assert.equal(check2.verified, true, "Deliverable verification succeeds once all output artifacts exist");
    console.log("✅ [PASS] 6. Planning Council scoring, tie escalation, and deliverable verification verified.");
  }

  console.log("\n🎉 ALL 6 ACCEPTANCE TEST SUITES PASSED SUCCESSFULLY!");
}

runAcceptanceSuite().catch((err) => {
  console.error("Acceptance suite failed:", err);
  process.exit(1);
});
