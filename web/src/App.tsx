import type { ReactNode } from "react";
import { BrowserRouter, Routes, Route, Navigate, Outlet } from "react-router-dom";
import Login from "./pages/Login";
import Signup from "./pages/Signup";
import Home from "./pages/Home";
import Create from "./pages/Create";
import Library from "./pages/Library";
import TrackDetail from "./pages/TrackDetail";
import Layout from "./components/Layout";
import ProtectedRoute from "./components/ProtectedRoute";
import { useAuth } from "./store/auth";

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
        {/* Authed shell: Layout mounts once and stays mounted across these
            routes, so audio keeps playing on navigation. */}
        <Route
          element={
            <ProtectedRoute>
              <Layout>
                <Outlet />
              </Layout>
            </ProtectedRoute>
          }
        >
          <Route path="/" element={<Home />} />
          <Route path="/create" element={<Create />} />
          <Route path="/library" element={<Library />} />
          <Route path="/track/:id" element={<TrackDetail />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
