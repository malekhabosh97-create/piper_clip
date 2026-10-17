export const freellmModels = [
  { id: "deepseek-normal", label: "DeepSeek V3 (Normal Mode)" },
  { id: "deepseek-deepthink", label: "DeepSeek R1 (DeepThink / Thinking Mode)" },
  { id: "gemini-default", label: "Google Gemini (Default Active Mode)" },
  { id: "gemini-pro", label: "Google Gemini (3.1 Pro - Advanced Reasoning)" },
  { id: "gemini-flash", label: "Google Gemini (3.8 Flash - Fast & Capable)" },
  { id: "gemini-flash-lite", label: "Google Gemini (3.5 Flash-Lite - Fastest Answers)" },
  { id: "gemini-argon", label: "Google Gemini (4 Argon - Complex Tasks)" },
  { id: "arena-direct", label: "LMArena (Direct Chat Mode)" },
];

export async function listModels(): Promise<Array<{ id: string; label: string }>> {
  return freellmModels;
}
