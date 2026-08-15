import { lazy, Suspense, type ReactNode } from "react";
import { BrowserRouter, Routes, Route, Navigate, Outlet } from "react-router-dom";
import Login from "./pages/Login";
import Signup from "./pages/Signup";
import Onboarding from "./pages/Onboarding";
import Home from "./pages/Home";
import Create from "./pages/Create";
import Library from "./pages/Library";
import Settings from "./pages/Settings";
import TrackDetail from "./pages/TrackDetail";
import Layout from "./components/Layout";
import ProtectedRoute from "./components/ProtectedRoute";
import RequireOnboarding from "./components/RequireOnboarding";
import GlassFilters from "./components/GlassFilters";
import StudioField from "./components/StudioField";
import { useAuth } from "./store/auth";

// Neither route is on the path to making a track, and both carry a catalogue of
// sample content the average session never opens. Split out, like AvatarPanel.
const Discover = lazy(() => import("./pages/Discover"));
const AiTools = lazy(() => import("./pages/AiTools"));

/**
 * Keeps signed-in users out of the auth pages. Reads `status`, not the token:
 * during bootstrap there is no token yet, and rendering the login form in that
 * window makes an already-signed-in user watch it flash away.
 */
function GuestOnly({ children }: { children: ReactNode }) {
  const status = useAuth((s) => s.status);
  if (status === "loading") return null;
  return status === "authed" ? <Navigate to="/" replace /> : <>{children}</>;
}

/**
 * BrowserRouter with no basename: CloudFront rewrites extensionless paths to
 * /index.html and the app is always served from /, so deep links survive a hard
 * refresh without any path-prefix assumptions.
 */
export default function App() {
  return (
    <BrowserRouter>
      {/*
        Both sit outside <Routes> so the room and its lens filters survive
        navigation — the field would restart its pulse on every route change if
        it were mounted per page, and the filter defs are document-global.
      */}
      <StudioField />
      <GlassFilters />
      <Routes>
        <Route
          path="/login"
          element={
            <GuestOnly>
              <Login />
            </GuestOnly>
          }
        />
        <Route
          path="/signup"
          element={
            <GuestOnly>
              <Signup />
            </GuestOnly>
          }
        />
        {/* First-run preferences. Authed, but deliberately OUTSIDE the shell
            and outside RequireOnboarding — a guard cannot bounce a user to a
            route it also guards. It renders the auth-shell frame instead, the
            same one Login and Signup use. */}
        <Route
          path="/onboarding"
          element={
            <ProtectedRoute>
              <Onboarding />
            </ProtectedRoute>
          }
        />
        {/* Authed shell: Layout mounts once and stays mounted across these
            routes, so audio keeps playing on navigation. */}
        <Route
          element={
            <ProtectedRoute>
              <RequireOnboarding>
                <Layout>
                  <Outlet />
                </Layout>
              </RequireOnboarding>
            </ProtectedRoute>
          }
        >
          <Route path="/" element={<Home />} />
          <Route path="/create" element={<Create />} />
          <Route path="/library" element={<Library />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/track/:id" element={<TrackDetail />} />
          {/* No fallback markup: these chunks resolve in a frame or two on a
              warm connection, and a skeleton that flashes is worse than none. */}
          <Route
            path="/discover"
            element={
              <Suspense fallback={null}>
                <Discover />
              </Suspense>
            }
          />
          <Route
            path="/tools"
            element={
              <Suspense fallback={null}>
                <AiTools />
              </Suspense>
            }
          />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
