import type { ConfigIssue } from '../shared/validation';

const LABEL = { error: 'Fehler', warning: 'Warnung', autofix: 'Automatisch korrigiert' } as const;
const CLASS = { error: 'error', warning: 'warning', autofix: 'info' } as const;

export default function IssueList({ issues }: { issues: ConfigIssue[] }) {
  if (issues.length === 0) return <div className="notice ok">Regeln geprüft: keine Widersprüche.</div>;
  return (
    <div className="stack">
      {issues.map((i) => (
        <div key={i.code} className={`notice ${CLASS[i.level]}`}>
          <strong>{LABEL[i.level]}:</strong> {i.message}
        </div>
      ))}
    </div>
  );
}
