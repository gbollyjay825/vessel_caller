import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Route, Switch } from "wouter";
import type { ReactNode } from "react";

import { AppLoader } from "./app/AppLoader";
import { AppShell } from "./app/AppShell";
import { AuthProvider, type Permission } from "./auth/AuthContext";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { Navigate } from "./lib/navigation";
import { MobileApp } from "./mobile/MobileApp";
import { AccountSecurity } from "./screens/AccountSecurity";
import { Analytics } from "./screens/Analytics";
import { AuthPage } from "./screens/AuthPage";
import { Dashboard } from "./screens/Dashboard";
import { EmailVerification } from "./screens/EmailVerification";
import { Inspections, NewInspection } from "./screens/Inspections";
import { InvitationAccept } from "./screens/InvitationAccept";
import { Invoices } from "./screens/Invoices";
import { Landing } from "./screens/LandingFull";
import { ForgotPassword, ResetPassword } from "./screens/PasswordRecovery";
import { Settings } from "./screens/Settings";
import { UserManagement } from "./screens/UserManagement";
import { VesselCallDetail, VesselCalls } from "./screens/VesselCalls";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: (failureCount, error) => (
        !(error && typeof error === "object" && "status" in error && Number(error.status) < 500)
        && failureCount < 2
      ),
      refetchOnWindowFocus: true,
    },
  },
});

function SecureScreen({ permission, children }: { permission?: Permission; children: ReactNode }) {
  return <ProtectedRoute permission={permission}>{children}</ProtectedRoute>;
}

function WorkspaceRoutes() {
  return (
    <Switch>
      <Route path="/app"><Dashboard /></Route>
      <Route path="/app/vessel-calls/:id"><VesselCallDetail /></Route>
      <Route path="/app/vessel-calls"><VesselCalls /></Route>
      <Route path="/app/inspections/new">
        <SecureScreen permission="inspections.manage"><NewInspection /></SecureScreen>
      </Route>
      <Route path="/app/inspections"><Inspections /></Route>
      <Route path="/app/invoices"><Invoices /></Route>
      <Route path="/app/account"><AccountSecurity /></Route>
      <Route path="/app/analytics">
        <SecureScreen permission="analytics.view"><Analytics /></SecureScreen>
      </Route>
      <Route path="/app/users">
        <SecureScreen permission="users.view"><UserManagement /></SecureScreen>
      </Route>
      <Route path="/app/settings">
        <SecureScreen permission="settings.view"><Settings /></SecureScreen>
      </Route>
      <Route><Navigate to="/app" replace /></Route>
    </Switch>
  );
}

function Workspace() {
  return (
    <ProtectedRoute>
      <AppLoader>
        <AppShell><WorkspaceRoutes /></AppShell>
      </AppLoader>
    </ProtectedRoute>
  );
}

function Capture() {
  return (
    <ProtectedRoute permission="inspections.manage">
      <AppLoader><MobileApp /></AppLoader>
    </ProtectedRoute>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <Switch>
          <Route path="/"><Landing /></Route>
          <Route path="/login"><AuthPage mode="login" /></Route>
          <Route path="/register"><AuthPage mode="register" /></Route>
          <Route path="/verify-email"><EmailVerification /></Route>
          <Route path="/forgot-password"><ForgotPassword /></Route>
          <Route path="/reset-password"><ResetPassword /></Route>
          <Route path="/accept-invitation"><InvitationAccept /></Route>
          <Route path="/capture"><Capture /></Route>
          <Route path="/app"><Workspace /></Route>
          <Route path="/app/*"><Workspace /></Route>
          <Route><Navigate to="/" replace /></Route>
        </Switch>
      </AuthProvider>
    </QueryClientProvider>
  );
}
