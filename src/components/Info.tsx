import { useState } from 'react';
import { createPortal } from 'react-dom';

/** Kleiner ⓘ-Knopf: öffnet eine ausführliche Erklärung. */
export default function Info({ title, text }: { title: string; text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="info-btn" aria-label={`Erklärung: ${title}`}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(true); }}>i</button>
      {open && createPortal(
        <div className="overlay" role="dialog" aria-label={title} onClick={(e) => { e.stopPropagation(); setOpen(false); }}>
          <div className="card stack info-sheet" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ margin: 0 }}>{title}</h2>
            {text.split('\n\n').map((p, i) => <p key={i} style={{ margin: 0, whiteSpace: 'pre-line' }}>{p}</p>)}
            <button type="button" className="primary" onClick={(e) => { e.stopPropagation(); setOpen(false); }}>Verstanden</button>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
