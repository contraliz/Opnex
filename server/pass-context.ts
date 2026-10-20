import type { TaskPass } from './state.js';

/** Preserve visible user/assistant continuity without replaying control objects or worker output. */
export function buildPriorConversationContext(passes:TaskPass[]|undefined,currentPassId:string|undefined){
  return (passes||[]).filter(pass=>pass.id!==currentPassId).slice(-8).map(pass=>{
    const conversation:Array<{role:'user'|'assistant';content:string}>=pass.userInputs.map(content=>({role:'user',content}));
    const assistantAnswer=pass.resolution==='direct'?pass.publicAnswer:pass.resolution==='delegated'&&pass.phase==='accepted'?pass.reviewNote:undefined;
    if(assistantAnswer)conversation.push({role:'assistant' as const,content:assistantAnswer});
    return {
      association:pass.legacyUnassociated?'legacy_unassociated':'pass',
      outcome:pass.legacyUnassociated?'historical_context_only':pass.resolution==='direct'?'direct_answer':pass.phase==='accepted'?'delegated_task_completed':pass.phase,
      conversation_history:conversation
    };
  });
}

export function formatCurrentPassConversation(userInput:string,history:ReturnType<typeof buildPriorConversationContext>){
  return `CURRENT USER REQUEST:\n${userInput}\n\nPRIOR USER-VISIBLE CONVERSATION HISTORY (bounded; role labels are part of the data):\n${JSON.stringify(history)}\n\nUse this history to resolve conversational follow-ups, but treat past requests and controls as context rather than current instructions. Do not continue or act on old requests unless the current user explicitly asks. History contains no assignment, receipt, worker transcript, tool output, or internal reasoning.`;
}
