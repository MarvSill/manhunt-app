import jsQR from 'jsqr';
import { useEffect, useRef, useState } from 'react';

// QR-Scanner: BarcodeDetector, wo vorhanden, sonst jsQR. Fällt auf Code-Eingabe zurück.
export default function Scanner({ onCode, onClose }: { onCode: (code: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const [manual, setManual] = useState('');
  const done = useRef(false);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    type Detector = { detect: (v: HTMLVideoElement) => Promise<{ rawValue: string }[]> };
    const BD = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => Detector }).BarcodeDetector;
    const detector = BD ? new BD({ formats: ['qr_code'] }) : null;
    const found = (raw: string) => {
      if (done.current) return;
      const m = raw.match(/(\d{6})/);
      if (!m) return;
      done.current = true;
      navigator.vibrate?.(100);
      onCode(m[1]);
    };
    const loop = async () => {
      const v = video.current;
      if (!v || done.current) return;
      if (v.readyState >= 2) {
        try {
          if (detector) {
            const r = await detector.detect(v);
            if (r[0]) found(r[0].rawValue);
          } else if (canvas.current) {
            const c = canvas.current;
            c.width = v.videoWidth;
            c.height = v.videoHeight;
            const ctx = c.getContext('2d', { willReadFrequently: true })!;
            ctx.drawImage(v, 0, 0);
            const img = ctx.getImageData(0, 0, c.width, c.height);
            const r = jsQR(img.data, img.width, img.height);
            if (r) found(r.data);
          }
        } catch {
          // nächster Frame
        }
      }
      raf = requestAnimationFrame(() => void loop());
    };
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (video.current) {
          video.current.srcObject = stream;
          await video.current.play();
          void loop();
        }
      } catch {
        setErr('Kamera nicht verfügbar. Code von Hand eingeben.');
      }
    })();
    return () => {
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onCode]);

  return (
    <div className="overlay">
      <div className="card stack" style={{ width: '100%', maxWidth: 420 }}>
        <h2 style={{ margin: 0 }}>Fang-Code scannen</h2>
        {err ? <div className="notice">{err}</div> : <video ref={video} playsInline muted style={{ width: '100%', borderRadius: 12, background: '#000' }} />}
        <canvas ref={canvas} hidden />
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (/^\d{6}$/.test(manual)) onCode(manual); }}>
          <input inputMode="numeric" pattern="\d{6}" maxLength={6} placeholder="6-stelliger Code" aria-label="Fang-Code" value={manual}
            onChange={(e) => setManual(e.target.value.replace(/\D/g, ''))} style={{ flex: 1 }} />
          <button type="submit" className="primary" disabled={manual.length !== 6}>Fangen</button>
        </form>
        <button className="ghost" onClick={onClose}>Abbrechen</button>
      </div>
    </div>
  );
}
