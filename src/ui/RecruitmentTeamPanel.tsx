import { useId } from 'react';
import './recruitment-team.css';

export type RecruitmentReceipt = {
  status: string;
  result: string;
  changes: string[];
  acceptance: { met: string[]; unmet: string[] };
  verification: { check: string; result: string; evidence?: string | null }[];
  risks: string[];
  knowledge: { consulted: string[]; updated: string[] };
  decision_required: string | null;
};

export type RecruitmentAssignment = {
  outcome: string;
  deliverable: string;
  read_scope: string[];
  write_scope: string[];
};

export type RecruitmentWorker = {
  workerId: string;
  name: string;
  status: string;
  canSteer?: boolean;
  effort: 'high' | 'xhigh' | 'max';
  branch: string;
  worktreePath: string;
  assignment: RecruitmentAssignment;
  receipt?: RecruitmentReceipt;
  error?: string;
};

export type RecruitmentIntegration = {
  status: string;
  canSteer?: boolean;
  branch: string;
  worktreePath: string;
  receipt?: RecruitmentReceipt;
  error?: string;
};

export type RecruitmentTeam = {
  teamId: string;
  status: string;
  workers: RecruitmentWorker[];
  integration?: RecruitmentIntegration;
};

export type RecruitmentTeamPanelProps = {
  team?: RecruitmentTeam;
  selectedWorkerId?: string;
  onSelectSteerWorker?: (workerId: string) => void;
};

function ValueList({ label, values }: { label: string; values: string[] }) {
  return (
    <div className="recruitment-team__receipt-block">
      <h5>{label}</h5>
      {values.length ? (
        <ul>{values.map((value, index) => <li key={`${index}-${value}`}>{value}</li>)}</ul>
      ) : <p className="recruitment-team__muted">None recorded</p>}
    </div>
  );
}

function ReceiptDetails({ receipt, label = 'Public receipt' }: { receipt: RecruitmentReceipt; label?: string }) {
  return (
    <details className="recruitment-team__disclosure">
      <summary>{label} · {receipt.status}</summary>
      <div className="recruitment-team__receipt">
        <p>{receipt.result}</p>
        <ValueList label="Changes" values={receipt.changes} />
        <ValueList label="Acceptance met" values={receipt.acceptance.met} />
        <ValueList label="Acceptance unmet" values={receipt.acceptance.unmet} />
        <div className="recruitment-team__receipt-block">
          <h5>Verification</h5>
          {receipt.verification.length ? (
            <ul>{receipt.verification.map((item, index) => (
              <li key={`${index}-${item.check}`}>
                <strong>{item.check}:</strong> {item.result}
                {item.evidence ? <p>{item.evidence}</p> : null}
              </li>
            ))}</ul>
          ) : <p className="recruitment-team__muted">None recorded</p>}
        </div>
        <ValueList label="Risks" values={receipt.risks} />
        <ValueList label="Knowledge consulted" values={receipt.knowledge.consulted} />
        <ValueList label="Knowledge updated" values={receipt.knowledge.updated} />
        {receipt.decision_required ? (
          <p className="recruitment-team__decision"><strong>Decision required:</strong> {receipt.decision_required}</p>
        ) : null}
      </div>
    </details>
  );
}

function WorkerCard({ worker, selected, onSelectSteerWorker }: { worker: RecruitmentWorker; selected: boolean; onSelectSteerWorker?: (workerId: string) => void }) {
  return (
    <li className="recruitment-team__card recruitment-team__worker-bar">
      <article aria-labelledby={`recruitment-worker-${worker.workerId}`}>
        <header className="recruitment-team__worker-bar-heading">
          <h3 id={`recruitment-worker-${worker.workerId}`}>{worker.name}</h3>
          <span className="recruitment-team__worker-effort">{worker.effort}</span>
          <span className="recruitment-team__status" role="status">{worker.status}</span>
        </header>
        <dl className="recruitment-team__metadata">
          <div><dt>Branch</dt><dd><code>{worker.branch}</code></dd></div>
        </dl>
        <details className="recruitment-team__disclosure recruitment-team__worktree">
          <summary>Full worktree path</summary>
          <code>{worker.worktreePath}</code>
        </details>
        {worker.error ? <p className="recruitment-team__error" role="alert">{worker.error}</p> : null}
        {onSelectSteerWorker&&worker.canSteer&&<button type="button" className="recruitment-team__steer" aria-pressed={selected} onClick={()=>onSelectSteerWorker(worker.workerId)}>{selected?'Selected for next update':'Steer this worker'}</button>}
        <section className="recruitment-team__assignment" aria-label={`${worker.name} assignment`}>
          <h4>Assignment</h4>
          <p><strong>Outcome:</strong> {worker.assignment.outcome}</p>
          <p><strong>Deliverable:</strong> {worker.assignment.deliverable}</p>
          <details className="recruitment-team__disclosure">
            <summary>Authorized scope</summary>
            <div className="recruitment-team__scope">
              <ValueList label="Read" values={worker.assignment.read_scope} />
              <ValueList label="Write" values={worker.assignment.write_scope} />
            </div>
          </details>
        </section>
        {worker.receipt ? <ReceiptDetails receipt={worker.receipt} /> : null}
      </article>
    </li>
  );
}

export function RecruitmentTeamPanel({ team, selectedWorkerId, onSelectSteerWorker }: RecruitmentTeamPanelProps) {
  const headingId = useId();
  if (!team) return null;

  return (
    <section className="recruitment-team" aria-labelledby={headingId}>
      <header className="recruitment-team__heading">
        <div>
          <h2 id={headingId}>Recruitment team</h2>
          <p>Team <code>{team.teamId}</code></p>
        </div>
        <div className="recruitment-team__heading-status">
          <span className="recruitment-team__worker-count" aria-label={`${team.workers.length} workers recruited`}>{team.workers.length} {team.workers.length===1?'worker':'workers'} recruited</span>
          <span className="recruitment-team__status" role="status">{team.status}</span>
        </div>
      </header>
      <ul className="recruitment-team__roster" aria-label={`Recruited workers (${team.workers.length})`}>
        {team.workers.map((worker) => <WorkerCard key={worker.workerId} worker={worker} selected={selectedWorkerId===worker.workerId} onSelectSteerWorker={onSelectSteerWorker} />)}
      </ul>
      {team.integration ? (
        <section className="recruitment-team__card" aria-labelledby={`${headingId}-integration`}>
          <header className="recruitment-team__card-heading">
            <h3 id={`${headingId}-integration`}>Integration</h3>
            <span className="recruitment-team__status" role="status">{team.integration.status}</span>
          </header>
          <dl className="recruitment-team__metadata">
            <div><dt>Branch</dt><dd><code>{team.integration.branch}</code></dd></div>
          </dl>
          <details className="recruitment-team__disclosure recruitment-team__worktree">
            <summary>Full worktree path</summary>
            <code>{team.integration.worktreePath}</code>
          </details>
          {team.integration.error ? <p className="recruitment-team__error" role="alert">{team.integration.error}</p> : null}
          {onSelectSteerWorker&&team.integration.canSteer&&<button type="button" className="recruitment-team__steer" aria-pressed={selectedWorkerId==='integration'} onClick={()=>onSelectSteerWorker('integration')}>{selectedWorkerId==='integration'?'Selected for next update':'Steer integration agent'}</button>}
          {team.integration.receipt ? <ReceiptDetails receipt={team.integration.receipt} /> : null}
        </section>
      ) : null}
    </section>
  );
}
