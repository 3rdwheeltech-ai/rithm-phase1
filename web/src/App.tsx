import type { ReactNode } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import Login from "./pages/Login";
import Signup from "./pages/Signup";
import Home from "./pages/Home";
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
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <Home />
            </ProtectedRoute>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
