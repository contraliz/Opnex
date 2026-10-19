import { z } from 'zod';

const text = z.string().trim().min(1).max(12000);
export const assignmentSchema = z.object({
  outcome: text, deliverable: text,
  // Empty read scope is valid for work that only returns an answer and needs no files.
  read_scope: z.array(text).max(30), write_scope: z.array(text).max(30),
  exclusions: z.array(text).max(30), constraints: z.array(text).max(40), context_refs: z.array(text).max(40),
  acceptance: z.array(text).min(1).max(30), verification: z.array(text).min(1).max(30),
  ordinary_authority: z.array(text).min(1).max(30), escalation_conditions: z.array(text).min(1).max(30),
  receipt_requirements: z.array(text).min(1).max(20),
}).strict();
export type Assignment = z.infer<typeof assignmentSchema>;

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
  if(x.type==='receipt'&&(x.decision_needed||x.evidence.length||x.options.length||x.recommendation||x.consequences.length))ctx.addIssue({code:'custom',path:['type'],message:'Receipt outcome cannot include escalation fields.'});
  if(x.type==='escalation'&&(x.receipt||!x.decision_needed||!x.evidence.length||!x.options.length))ctx.addIssue({code:'custom',path:['type'],message:'Escalation requires a decision, evidence and options, and no receipt.'});
});

export const userTaskSchema = z.object({ message: text, taskId: z.string().uuid().optional() }).strict();
export const approvalDecisionSchema = z.object({ requestId: z.union([z.string(), z.number()]), decision: z.enum(['accept','decline','cancel']) }).strict();
export type ApprovalPolicy = 'on-request' | 'untrusted' | 'never';
export const settingsSchema = z.object({
  projectRoot: z.string().trim().min(1).max(1024), agentmemProjectId: z.string().trim().min(1).max(128),
  orchestratorModel: z.string().trim().min(1).max(200), orchestratorEffort: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
  approvalPolicy: z.enum(['on-request','untrusted','never']).default('on-request'),
}).strict();

export const assignmentJsonSchema = { type: 'object', additionalProperties: false, required: ['outcome','deliverable','read_scope','write_scope','exclusions','constraints','context_refs','acceptance','verification','ordinary_authority','escalation_conditions','receipt_requirements'], properties: {
  outcome: { type: 'string' }, deliverable: { type: 'string' }, read_scope: { type: 'array', items: { type: 'string' } }, write_scope: { type: 'array', items: { type: 'string' } }, exclusions: { type: 'array', items: { type: 'string' } }, constraints: { type: 'array', items: { type: 'string' } }, context_refs: { type: 'array', items: { type: 'string' } }, acceptance: { type: 'array', items: { type: 'string' } }, verification: { type: 'array', items: { type: 'string' } }, ordinary_authority: { type: 'array', items: { type: 'string' } }, escalation_conditions: { type: 'array', items: { type: 'string' } }, receipt_requirements: { type: 'array', items: { type: 'string' } },
}};
const receiptJsonSchema = { type:'object',additionalProperties:false,required:['status','result','changes','acceptance','verification','risks','knowledge','decision_required'],properties:{status:{type:'string',enum:['complete','incomplete','blocked','failed']},result:{type:'string'},changes:{type:'array',items:{type:'string'}},acceptance:{type:'object',additionalProperties:false,required:['met','unmet'],properties:{met:{type:'array',items:{type:'string'}},unmet:{type:'array',items:{type:'string'}}}},verification:{type:'array',items:{type:'object',additionalProperties:false,required:['check','result','evidence'],properties:{check:{type:'string'},result:{type:'string',enum:['passed','failed','not_run']},evidence:{type:['string','null']}}}},risks:{type:'array',items:{type:'string'}},knowledge:{type:'object',additionalProperties:false,required:['consulted','updated'],properties:{consulted:{type:'array',items:{type:'string'}},updated:{type:'array',items:{type:'string'}}}},decision_required:{type:['string','null']}}};
export const workerOutcomeJsonSchema = { type:'object',additionalProperties:false,required:['type','receipt','decision_needed','evidence','options','recommendation','consequences'],properties:{type:{type:'string',enum:['receipt','escalation']},receipt:{anyOf:[receiptJsonSchema,{type:'null'}]},decision_needed:{type:['string','null']},evidence:{type:'array',items:{type:'string'}},options:{type:'array',items:{type:'string'}},recommendation:{type:['string','null']},consequences:{type:'array',items:{type:'string'}}} };
export const reviewJsonSchema = {type:'object',additionalProperties:false,required:['outcome','note','assignment','decision_required'],properties:{outcome:{type:'string',enum:['accept','correction','incomplete','blocked','failed']},note:{type:'string'},assignment:{anyOf:[assignmentJsonSchema,{type:'null'}]},decision_required:{type:['string','null']}}};
