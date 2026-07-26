import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { AppLoader } from "./app/AppLoader";
import { AppShell } from "./app/AppShell";
import { AuthProvider } from "./auth/AuthContext";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { MobileApp } from "./mobile/MobileApp";
import { Analytics } from "./screens/Analytics";
import { AuthPage } from "./screens/AuthPage";
import { Dashboard } from "./screens/Dashboard";
import { Inspections, NewInspection } from "./screens/Inspections";
import { Invoices } from "./screens/Invoices";
import { Landing } from "./screens/LandingFull";
import { Settings } from "./screens/Settings";
import { UserManagement } from "./screens/UserManagement";
import { VesselCallDetail, VesselCalls } from "./screens/VesselCalls";

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/login" element={<AuthPage mode="login" />} />
          <Route path="/register" element={<AuthPage mode="register" />} />
          <Route element={<ProtectedRoute />}>
            <Route path="/capture" element={<AppLoader><MobileApp /></AppLoader>} />
            <Route path="/app" element={<AppLoader><AppShell /></AppLoader>}>
              <Route index element={<Dashboard />} />
              <Route path="vessel-calls" element={<VesselCalls />} />
              <Route path="vessel-calls/:id" element={<VesselCallDetail />} />
              <Route path="inspections" element={<Inspections />} />
              <Route path="inspections/new" element={<NewInspection />} />
              <Route path="invoices" element={<Invoices />} />
              <Route path="analytics" element={<Analytics />} />
              <Route path="users" element={<UserManagement />} />
              <Route path="settings" element={<Settings />} />
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
