import type { Receipt } from './contracts.js';
import type { AgentReceiptRecord, ReceiptProducerRole, ReceiptProvenance, TaskPass } from './state.js';

export type ReceiptProvenanceDetails=Pick<ReceiptProvenance,'origin'|'workerId'|'teamId'|'passId'>;

export function receiptProvenance(role:ReceiptProducerRole,threadId:string,turnId:string,receipt:Receipt,recordedAt=new Date().toISOString(),details:ReceiptProvenanceDetails={}):ReceiptProvenance{
  return {producerRole:role,threadId,turnId,recordedAt,artifactRefs:[...receipt.changes],origin:details.origin||'model_turn',...details};
}

export function recordAgentReceipt(pass:TaskPass,role:ReceiptProducerRole,threadId:string,turnId:string,receipt:Receipt,recordedAt=new Date().toISOString(),details:ReceiptProvenanceDetails={}):AgentReceiptRecord{
  const provenance=receiptProvenance(role,threadId,turnId,receipt,recordedAt,{passId:pass.id,...details});
  const record={...provenance,receipt:structuredClone(receipt)};
  const rows=pass.agentReceipts??(pass.agentReceipts=[]);
  const existing=rows.findIndex(row=>row.producerRole===role&&row.threadId===threadId&&row.turnId===turnId);
  if(existing<0)rows.push(record);else rows[existing]=record;
  pass.receiptProvenance=provenance;
  return record;
}
