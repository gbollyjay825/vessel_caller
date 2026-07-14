import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { AppLoader } from "./app/AppLoader";
import { AppShell } from "./app/AppShell";
import { AuthProvider } from "./auth/AuthContext";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { AuthPage } from "./screens/AuthPage";
import { Landing } from "./screens/Landing";

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/login" element={<AuthPage mode="login" />} />
          <Route path="/register" element={<AuthPage mode="register" />} />
          <Route element={<ProtectedRoute />}>
            <Route path="/app/*" element={<AppLoader><AppShell /></AppLoader>} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
