import type { ReactNode } from "react";
import { BrowserRouter, Routes, Route, Navigate, Outlet } from "react-router-dom";
import Login from "./pages/Login";
import Signup from "./pages/Signup";
import Home from "./pages/Home";
import Create from "./pages/Create";
import Library from "./pages/Library";
import Layout from "./components/Layout";
import ProtectedRoute from "./components/ProtectedRoute";
import { useAuth } from "./store/auth";

/** Keeps signed-in users out of the auth pages. */
function GuestOnly({ children }: { children: ReactNode }) {
  const idToken = useAuth((s) => s.idToken);
  return idToken ? <Navigate to="/" replace /> : <>{children}</>;
}

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
        {/* Authed shell: Layout (sidebar + persistent Player) mounts once and
            stays mounted across these routes, so audio keeps playing on navigation. */}
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
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
