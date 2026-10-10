import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { joinGame } from '../lib/games';
import { errorText } from '../lib/supabase';

export default function JoinPage() {
  const params = useParams();
  const navigate = useNavigate();
  const [code, setCode] = useState(params.code ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoTried = useRef(false);

  async function join(c: string) {
    setError(null);
    setBusy(true);
    try {
      const game = await joinGame(c);
      navigate(`/spiel/${game.id}`, { replace: true });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  // Einladungslink /beitreten/123456: direkt beitreten.
  useEffect(() => {
    if (params.code && /^\d{6}$/.test(params.code) && !autoTried.current) {
      autoTried.current = true;
      void join(params.code);
    }
  }, [params.code]);

  function submit(e: FormEvent) {
    e.preventDefault();
    void join(code.replace(/\D/g, ''));
  }

  return (
    <div className="app">
      <div className="topbar">
        <Link to="/" className="button ghost small">←</Link>
        <h1>Spiel beitreten</h1>
      </div>
      <form className="stack" onSubmit={submit}>
        <label className="field">
          6-stelliger Code vom Host
          <input
            className="code-big"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder="000000"
          />
        </label>
        {error && <div className="notice error">{error}</div>}
        <button className="primary block" disabled={busy || code.length !== 6}>
          Beitreten
        </button>
      </form>
    </div>
  );
}
