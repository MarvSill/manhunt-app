import { useEffect, useState } from 'react';

export interface GuideStep { target?: string; title: string; text: string }

/**
 * Helfer, der Schritt für Schritt durch eine Seite führt. Startet nur auf Wunsch.
 * `target` ist der Wert eines data-guide-Attributs; das Element wird hervorgehoben.
 */
export default function Guide({ steps, onClose }: { steps: GuideStep[]; onClose: () => void }) {
  const list = steps.filter((s) => !s.target || document.querySelector(`[data-guide="${s.target}"]`));
  const [i, setI] = useState(0);
  const step = list[Math.min(i, list.length - 1)];

  useEffect(() => {
    if (!step?.target) return;
    const el = document.querySelector(`[data-guide="${step.target}"]`);
    if (!el) return;
    el.classList.add('guide-focus');
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return () => el.classList.remove('guide-focus');
  }, [step]);

  if (!step) return null;
  return (
    <div className="guide-card card stack" role="dialog" aria-label="Helfer">
      <div className="row">
        <span className="muted small spacer">Helfer · Schritt {i + 1} von {list.length}</span>
        <button type="button" className="ghost small" onClick={onClose} aria-label="Helfer schliessen">✕</button>
      </div>
      <strong>{step.title}</strong>
      <span className="small">{step.text}</span>
      <div className="row">
        <button type="button" className="small" disabled={i === 0} onClick={() => setI(i - 1)}>← Zurück</button>
        <span className="spacer" />
        {i < list.length - 1
          ? <button type="button" className="small primary" onClick={() => setI(i + 1)}>Weiter →</button>
          : <button type="button" className="small primary" onClick={onClose}>Fertig</button>}
      </div>
    </div>
  );
}
