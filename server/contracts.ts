import { z } from 'zod';

const text = z.string().trim().min(1).max(12000);
export const assignmentSchema = z.object({
  outcome: text, deliverable: text,
  // Empty read scope is valid for work that only returns an answer and needs no files.
  read_scope: z.array(text).max(30), write_scope: z.array(text).max(30),
  exclusions: z.array(text).max(30), constraints: z.array(text).max(40), context_refs: z.array(text).max(40),
  skill_refs: z.array(z.string().trim().min(1).max(160)).max(12).optional(),
  acceptance: z.array(text).min(1).max(30), verification: z.array(text).min(1).max(30),
  ordinary_authority: z.array(text).min(1).max(30), escalation_conditions: z.array(text).min(1).max(30),
  receipt_requirements: z.array(text).min(1).max(20),
}).strict();
export type Assignment = z.infer<typeof assignmentSchema>;

export const workerContextPlanSchema=z.object({type:z.literal('context_plan'),queries:z.array(z.string().trim().min(1).max(500)).max(6),scope_summary:z.string().trim().min(1).max(3000)}).strict();
export const workerContextSummarySchema=z.object({type:z.literal('context_ready'),summary:z.string().trim().min(1).max(8000)}).strict();
export const workerContextPlanJsonSchema={type:'object',additionalProperties:false,required:['type','queries','scope_summary'],properties:{type:{type:'string',enum:['context_plan']},queries:{type:'array',maxItems:6,items:{type:'string',maxLength:500}},scope_summary:{type:'string',maxLength:3000}}};
export const workerContextSummaryJsonSchema={type:'object',additionalProperties:false,required:['type','summary'],properties:{type:{type:'string',enum:['context_ready']},summary:{type:'string',maxLength:8000}}};

export const directAnswerSchema = z.object({
  type:z.literal('direct_answer'), answer:text, policy_basis:z.string().trim().min(1).max(400),
}).strict();
export const routeNameSchema = z.enum(['direct_answer','simple_implementation','hard_task']);
export const routeRuleSchema = z.enum([
  'direct_explanation_or_transform','simple_bounded_correction','simple_internal_rename','simple_mechanical_dependency_upgrade','simple_established_documentation','simple_routine_git',
  'hard_new_feature','hard_multi_component_change','hard_migration','hard_major_dependency_upgrade','hard_public_contract_change','hard_lifecycle_change',
  'hard_unknown_cause_diagnosis','hard_mixed_scope','hard_significant_uncertainty','hard_explicit_project_knowledge'
]);
export const ROUTE_RULES={
  direct_explanation_or_transform:'direct_answer',
  simple_bounded_correction:'simple_implementation',
  simple_internal_rename:'simple_implementation',
  simple_mechanical_dependency_upgrade:'simple_implementation',
  simple_established_documentation:'simple_implementation',
  simple_routine_git:'simple_implementation',
  hard_new_feature:'hard_task',
  hard_multi_component_change:'hard_task',
  hard_migration:'hard_task',
  hard_major_dependency_upgrade:'hard_task',
  hard_public_contract_change:'hard_task',
  hard_lifecycle_change:'hard_task',
  hard_unknown_cause_diagnosis:'hard_task',
  hard_mixed_scope:'hard_task',
  hard_significant_uncertainty:'hard_task',
  hard_explicit_project_knowledge:'hard_task',
} as const;
export const routeDecisionSchema=z.object({route:routeNameSchema,rule_id:routeRuleSchema,justification:z.string().trim().min(1).max(400)}).strict().superRefine((decision,ctx)=>{
  if(ROUTE_RULES[decision.rule_id]!==decision.route)ctx.addIssue({code:'custom',path:['rule_id'],message:'Routing rule does not authorize this route.'});
});
export type RouteDecision=z.infer<typeof routeDecisionSchema>;
export const directExecutorOutcomeSchema=z.object({
  type:z.enum(['answer','escalate']),answer:z.string().trim().max(12000).nullable(),escalation:z.string().trim().max(2000).nullable(),
  route:z.enum(['simple_implementation','hard_task']).nullable(),justification:z.string().trim().max(400).nullable(),
}).strict().superRefine((value,ctx)=>{
  if(value.type==='answer'){
    if(!value.answer)ctx.addIssue({code:'custom',path:['answer'],message:'A direct answer requires answer text.'});
    if(value.escalation||value.route||value.justification)ctx.addIssue({code:'custom',path:['type'],message:'An answer cannot contain escalation fields.'});
  }else{
    if(value.answer!==null)ctx.addIssue({code:'custom',path:['answer'],message:'An escalation cannot contain a public answer.'});
    if(!value.escalation||!value.route||!value.justification)ctx.addIssue({code:'custom',path:['escalation'],message:'Escalation requires reason, route and justification.'});
  }
});
export const simpleExecutorOutcomeSchema=z.object({
  type:z.enum(['complete','escalate']),receipt:z.lazy(()=>receiptSchema).nullable(),
  escalation:z.object({decision_needed:text,completed_actions:z.array(text).max(30),evidence:z.array(text).max(30)}).strict().nullable(),
}).strict().superRefine((value,ctx)=>{
  if(value.type==='complete'){
    if(!value.receipt)ctx.addIssue({code:'custom',path:['receipt'],message:'A completed implementation requires a receipt.'});
    if(value.escalation)ctx.addIssue({code:'custom',path:['escalation'],message:'A completion cannot contain escalation fields.'});
  }else{
    if(value.receipt)ctx.addIssue({code:'custom',path:['receipt'],message:'An escalation cannot contain a receipt.'});
    if(!value.escalation)ctx.addIssue({code:'custom',path:['escalation'],message:'An escalation requires evidence and completed actions.'});
  }
});
export const delegationPlanSchema = z.object({
  type:z.literal('delegate'), assignment:assignmentSchema,
}).strict();
const initialOrchestratorWireSchema = z.object({
  type: z.enum(['direct_answer','delegate']),
  answer: z.string().nullable(),
  policy_basis: z.string().nullable(),
  assignment: assignmentSchema.nullable(),
}).strict();
export const initialOrchestratorSchema = initialOrchestratorWireSchema.transform((value,ctx)=>{
  if(value.type==='direct_answer'){
    if(!value.answer?.trim())ctx.addIssue({code:'custom',path:['answer'],message:'Direct answers require answer text.'});
    if(!value.policy_basis?.trim())ctx.addIssue({code:'custom',path:['policy_basis'],message:'Direct answers require a policy basis.'});
    if(value.assignment!==null)ctx.addIssue({code:'custom',path:['assignment'],message:'Direct answers cannot include a delegated assignment.'});
    if(ctx.issues.length)return z.NEVER;
    return {type:'direct_answer' as const,answer:value.answer!.trim(),policy_basis:value.policy_basis!.trim()};
  }
  if(value.answer!==null||value.policy_basis!==null)ctx.addIssue({code:'custom',path:['type'],message:'Delegation cannot include a direct answer.'});
  if(!value.assignment)ctx.addIssue({code:'custom',path:['assignment'],message:'Delegation requires a complete assignment.'});
  if(ctx.issues.length)return z.NEVER;
  return {type:'delegate' as const,assignment:value.assignment!};
});
export type InitialOrchestratorOutcome = z.infer<typeof initialOrchestratorSchema>;

export const receiptSchema = z.object({
  status: z.enum(['complete', 'incomplete', 'blocked', 'failed']),
  result: text,
  changes: z.array(text).max(40),
  acceptance: z.object({ met: z.array(text).max(30), unmet: z.array(text).max(30) }).strict(),
  verification: z.array(z.object({ check: text, result: z.enum(['passed', 'failed', 'not_run']), evidence: z.string().max(4000).nullable().optional() }).strict()).max(40),
  risks: z.array(text).max(40),
  knowledge: z.object({ consulted: z.array(text).max(40), updated: z.array(text).max(40) }).strict(),
  decision_required: z.string().max(4000).nullable(),
}).strict();
export type Receipt = z.infer<typeof receiptSchema>;

export const reviewSchema = z.object({
  outcome: z.enum(['accept','correction','incomplete','blocked','failed']),
  note: z.string().max(4000), assignment: assignmentSchema.nullable(), decision_required: z.string().max(4000).nullable(),
}).strict().superRefine((x,ctx)=>{
  if(x.outcome==='correction'&&!x.assignment)ctx.addIssue({code:'custom',path:['assignment'],message:'Correction requires one complete assignment.'});
  if(x.outcome!=='correction'&&x.assignment)ctx.addIssue({code:'custom',path:['assignment'],message:'Only correction outcomes may include an assignment.'});
  if(x.outcome==='accept'&&x.decision_required)ctx.addIssue({code:'custom',path:['decision_required'],message:'Accepted receipts cannot require a decision.'});
});

export const workerOutcomeSchema = z.object({
  type: z.enum(['receipt','escalation']), receipt: receiptSchema.nullable(),
  decision_needed: z.string().max(4000).nullable(), evidence: z.array(text).max(12), options: z.array(text).max(8),
  recommendation: z.string().max(4000).nullable(), consequences: z.array(text).max(12),
}).strict().superRefine((x,ctx)=>{
  if(x.type==='receipt'&&!x.receipt)ctx.addIssue({code:'custom',path:['receipt'],message:'Receipt outcome requires a receipt.'});
  // The generated JSON Schema cannot express branch-exclusive nullable fields
  // portably. Treat `type` as authoritative for receipts and ignore otherwise
  // valid escalation-only fields; rejecting them here made the wire schema
  // accept a result that this validator rejected as a `type` error.
  if(x.type==='escalation'){
    if(x.receipt)ctx.addIssue({code:'custom',path:['receipt'],message:'Escalation outcomes cannot contain a receipt.'});
    if(!x.decision_needed?.trim())ctx.addIssue({code:'custom',path:['decision_needed'],message:'Escalation requires a decision.'});
    if(!x.evidence.length)ctx.addIssue({code:'custom',path:['evidence'],message:'Escalation requires evidence.'});
    if(!x.options.length)ctx.addIssue({code:'custom',path:['options'],message:'Escalation requires options.'});
  }
});

export function workerOutcomeFailureSummary(error:unknown){
  const issues=(error as {issues?:Array<{path?:PropertyKey[];code?:string}>}|null)?.issues;
  if(!Array.isArray(issues)||!issues.length)return 'The result could not be validated.';
  const messages=issues.map(issue=>{
    const field=issue.path?.map(String).join('.')||'result';
    if(field==='type')return 'outcome type must be "receipt" or "escalation"';
    if(field==='receipt')return 'receipt must be present and complete for a receipt outcome, and omitted for an escalation';
    if(field==='decision_needed')return 'an escalation needs a decision';
    if(field==='evidence')return 'an escalation needs evidence';
    if(field==='options')return 'an escalation needs options';
    return `invalid ${field.replaceAll('_',' ')}`;
  });
  return [...new Set(messages)].join('; ');
}

const attachmentPayload=z.object({name:z.string().min(1).max(160),type:z.string().max(100),size:z.number().int().positive().max(5*1024*1024),data:z.string().min(1).max(Math.ceil(5*1024*1024*4/3)+8)}).strict();
export const userTaskSchema = z.object({ message:z.string().trim().max(12000).default(''), attachments:z.array(attachmentPayload).max(5).default([]), skillIds:z.array(z.string().uuid()).max(12).default([]), taskId:z.string().uuid().optional() }).strict().refine(value=>!!value.message||value.attachments.length>0,{message:'Add a message or attach at least one supported file.'});
export const sessionTitleSchema = z.object({ title: z.string().trim().min(1, 'Session name cannot be empty.').max(120, 'Session name must be 120 characters or fewer.') }).strict();
export const approvalDecisionSchema = z.object({ requestId: z.union([z.string(), z.number()]), decision: z.enum(['accept','decline','cancel']), content:z.record(z.string(),z.unknown()).optional() }).strict();
export type ApprovalPolicy = 'on-request' | 'untrusted' | 'never' | 'full-access';
export const settingsSchema = z.object({
    projectRoot: z.string().trim().min(1).max(1024), agentmemProjectId: z.string().trim().max(64).regex(/^$|^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/).default(''), agentmemAutoSetup: z.boolean().default(false),
  orchestratorModel: z.string().trim().min(1).max(200), orchestratorEffort: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
  approvalPolicy: z.enum(['on-request','untrusted','never','full-access']).default('on-request'),
}).strict();

export const assignmentJsonSchema = { type: 'object', additionalProperties: false, required: ['outcome','deliverable','read_scope','write_scope','exclusions','constraints','context_refs','skill_refs','acceptance','verification','ordinary_authority','escalation_conditions','receipt_requirements'], properties: {
  outcome: { type: 'string' }, deliverable: { type: 'string' }, read_scope: { type: 'array', items: { type: 'string' } }, write_scope: { type: 'array', items: { type: 'string' } }, exclusions: { type: 'array', items: { type: 'string' } }, constraints: { type: 'array', items: { type: 'string' } }, context_refs: { type: 'array', items: { type: 'string' } }, skill_refs: { type: 'array', items: { type: 'string' } }, acceptance: { type: 'array', items: { type: 'string' } }, verification: { type: 'array', items: { type: 'string' } }, ordinary_authority: { type: 'array', items: { type: 'string' } }, escalation_conditions: { type: 'array', items: { type: 'string' } }, receipt_requirements: { type: 'array', items: { type: 'string' } },
}};
// Codex structured outputs require a top-level object. Branch-exclusive fields
// are nullable in the wire shape; initialOrchestratorSchema enforces exclusivity.
export const initialOrchestratorJsonSchema = { type:'object',additionalProperties:false,required:['type','answer','policy_basis','assignment'],properties:{
  type:{type:'string',enum:['direct_answer','delegate']},
  answer:{type:['string','null']},
  policy_basis:{type:['string','null']},
  assignment:{anyOf:[assignmentJsonSchema,{type:'null'}]},
}};
const receiptJsonSchema = { type:'object',additionalProperties:false,required:['status','result','changes','acceptance','verification','risks','knowledge','decision_required'],properties:{status:{type:'string',enum:['complete','incomplete','blocked','failed']},result:{type:'string'},changes:{type:'array',items:{type:'string'}},acceptance:{type:'object',additionalProperties:false,required:['met','unmet'],properties:{met:{type:'array',items:{type:'string'}},unmet:{type:'array',items:{type:'string'}}}},verification:{type:'array',items:{type:'object',additionalProperties:false,required:['check','result','evidence'],properties:{check:{type:'string'},result:{type:'string',enum:['passed','failed','not_run']},evidence:{type:['string','null']}}}},risks:{type:'array',items:{type:'string'}},knowledge:{type:'object',additionalProperties:false,required:['consulted','updated'],properties:{consulted:{type:'array',items:{type:'string'}},updated:{type:'array',items:{type:'string'}}}},decision_required:{type:['string','null']}}};
const routeRuleIds=Object.keys(ROUTE_RULES);
export const routeDecisionJsonSchema={type:'object',additionalProperties:false,required:['route','rule_id','justification'],properties:{route:{type:'string',enum:['direct_answer','simple_implementation','hard_task']},rule_id:{type:'string',enum:routeRuleIds},justification:{type:'string'}}};
export const directExecutorJsonSchema={type:'object',additionalProperties:false,required:['type','answer','escalation','route','justification'],properties:{type:{type:'string',enum:['answer','escalate']},answer:{type:['string','null']},escalation:{type:['string','null']},route:{type:['string','null'],enum:['simple_implementation','hard_task',null]},justification:{type:['string','null']}}};
export const simpleExecutorJsonSchema={type:'object',additionalProperties:false,required:['type','receipt','escalation'],properties:{type:{type:'string',enum:['complete','escalate']},receipt:{anyOf:[receiptJsonSchema,{type:'null'}]},escalation:{anyOf:[{type:'object',additionalProperties:false,required:['decision_needed','completed_actions','evidence'],properties:{decision_needed:{type:'string'},completed_actions:{type:'array',items:{type:'string'}},evidence:{type:'array',items:{type:'string'}}}},{type:'null'}]}}};
export const workerOutcomeJsonSchema = { type:'object',additionalProperties:false,required:['type','receipt','decision_needed','evidence','options','recommendation','consequences'],properties:{type:{type:'string',enum:['receipt','escalation']},receipt:{anyOf:[receiptJsonSchema,{type:'null'}]},decision_needed:{type:['string','null']},evidence:{type:'array',items:{type:'string'}},options:{type:'array',items:{type:'string'}},recommendation:{type:['string','null']},consequences:{type:'array',items:{type:'string'}}} };
export const reviewJsonSchema = {type:'object',additionalProperties:false,required:['outcome','note','assignment','decision_required'],properties:{outcome:{type:'string',enum:['accept','correction','incomplete','blocked','failed']},note:{type:'string'},assignment:{anyOf:[assignmentJsonSchema,{type:'null'}]},decision_required:{type:['string','null']}}};
