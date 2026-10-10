import { lazy, Suspense } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { supabase } from './lib/supabase';
import GamePage from './pages/Game';
import HomePage from './pages/Home';
import GroupPage from './pages/Group';
import GroupsPage from './pages/Groups';
import JoinPage from './pages/Join';

import LoginPage from './pages/Login';
import NewGamePage from './pages/NewGame';
import NewPasswordPage from './pages/NewPassword';
import OnboardingPage from './pages/Onboarding';
import ProfilePage from './pages/Profile';
import RulesPage from './pages/Rules';
import SetupMissingPage from './pages/SetupMissing';

// Karte und Spielansicht (Leaflet) erst bei Bedarf laden.
const MapEditorPage = lazy(() => import('./pages/MapEditor'));
const PlayPage = lazy(() => import('./play/Play'));

export default function App() {
  const { loading, session, profile, hasEmergencyContact, recovering } = useAuth();
  const location = useLocation();
  const inGame = /\/spiel\/[^/]+\/live/.test(location.pathname);

  if (!supabase) return <SetupMissingPage />;
  if (loading) return <div className="app center-screen muted">Lade …</div>;
  if (recovering) return <NewPasswordPage />;
  if (!session) {
    return (
      <Routes>
        <Route path="/beitreten/:code" element={<LoginPage />} />
        <Route path="*" element={<LoginPage />} />
      </Routes>
    );
  }
  if (!profile || !profile.age_confirmed || !hasEmergencyContact) return <OnboardingPage />;

  return (
    <>
      <Suspense fallback={<div className="app muted">Lade …</div>}>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/neu" element={<NewGamePage />} />
        <Route path="/beitreten" element={<JoinPage />} />
        <Route path="/beitreten/:code" element={<JoinPage />} />
        <Route path="/spiel/:id" element={<GamePage />} />
        <Route path="/spiel/:id/regeln" element={<RulesPage />} />
        <Route path="/spiel/:id/karte" element={<MapEditorPage />} />
        <Route path="/spiel/:id/live" element={<PlayPage />} />
        <Route path="/gruppen" element={<GroupsPage />} />
        <Route path="/gruppen/:id" element={<GroupPage />} />
        <Route path="/gruppe/:code" element={<GroupsPage />} />
        <Route path="/profil" element={<ProfilePage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      </Suspense>
      {!inGame && <nav className="nav">
        <NavLink to="/" end>Start</NavLink>
        <NavLink to="/beitreten">Beitreten</NavLink>
        <NavLink to="/gruppen">Gruppen</NavLink>
        <NavLink to="/profil">Profil</NavLink>
      </nav>}
    </>
  );
}
