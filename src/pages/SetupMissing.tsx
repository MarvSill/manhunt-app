export default function SetupMissingPage() {
  return (
    <div className="app center-screen">
      <div className="brand">Hunt Mode</div>
      <h1>Fast bereit</h1>
      <div className="notice warning">
        Die Verbindung zur Datenbank fehlt. Trage <code>VITE_SUPABASE_URL</code> und <code>VITE_SUPABASE_ANON_KEY</code>{' '}
        ein (lokal in <code>.env</code>, beim Hosting als Umgebungsvariablen). Anleitung: README.
      </div>
    </div>
  );
}
