import type { Receipt } from './contracts.js';
import type { AgentReceiptRecord, ReceiptProvenance, TaskPass } from './state.js';

export function receiptProvenance(role:'simple'|'worker',threadId:string,turnId:string,receipt:Receipt,recordedAt=new Date().toISOString()):ReceiptProvenance{
  return {producerRole:role,threadId,turnId,recordedAt,artifactRefs:[...receipt.changes]};
}

export function recordAgentReceipt(pass:TaskPass,role:'simple'|'worker',threadId:string,turnId:string,receipt:Receipt,recordedAt=new Date().toISOString()):AgentReceiptRecord{
  const provenance=receiptProvenance(role,threadId,turnId,receipt,recordedAt);
  const record={...provenance,receipt:structuredClone(receipt)};
  const rows=pass.agentReceipts??(pass.agentReceipts=[]);
  const existing=rows.findIndex(row=>row.producerRole===role&&row.threadId===threadId&&row.turnId===turnId);
  if(existing<0)rows.push(record);else rows[existing]=record;
  pass.receiptProvenance=provenance;
  return record;
}
