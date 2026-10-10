import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { api } from '../lib/engine';
import { errorText } from '../lib/supabase';

// Rotierender Fang-Code (alle 30 s neu), als QR und Zahl.
export default function CatchCode({ gameId, onClose }: { gameId: string; onClose: () => void }) {
  const [code, setCode] = useState<{ code: string; valid_s: number; qr: string } | null>(null);
  const [img, setImg] = useState<string | null>(null);
  const [left, setLeft] = useState(0);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const c = await api.catchCode(gameId);
        setCode(c);
        setLeft(c.valid_s);
        setImg(await QRCode.toDataURL(c.qr, { width: 320, margin: 1 }));
        t = setTimeout(load, c.valid_s * 1000 + 300);
      } catch (e) {
        setErr(errorText(e));
      }
    };
    void load();
    return () => clearTimeout(t);
  }, [gameId]);

  useEffect(() => {
    const i = setInterval(() => setLeft((l) => Math.max(0, l - 1)), 1000);
    return () => clearInterval(i);
  }, []);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="card stack" style={{ width: '100%', maxWidth: 380, textAlign: 'center', background: '#fff', color: '#000' }}>
        <strong>Du wurdest erwischt? Zeig diesen Code.</strong>
        {err && <div className="notice error">{err}</div>}
        {img && <img src={img} alt="Fang-QR-Code" style={{ width: '100%', imageRendering: 'pixelated' }} />}
        <div className="code-big" style={{ color: '#000' }} data-testid="catch-code">{code?.code ?? '······'}</div>
        <div className="small">Neuer Code in {left} s</div>
        <button className="block" onClick={onClose}>Schliessen</button>
      </div>
    </div>
  );
}
