import { QueryClientProvider } from "@tanstack/react-query";
import { Route, Switch } from "wouter";
import type { ReactNode } from "react";

import { AppLoader } from "./app/AppLoader";
import { AppShell } from "./app/AppShell";
import { AuthProvider, useAuth, type Permission } from "./auth/AuthContext";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { Navigate } from "./lib/navigation";
import { queryClient } from "./lib/queryClient";
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
import { SystemAudit } from "./system/SystemAudit";
import { SystemAccount } from "./system/SystemAccount";
import { SystemOrganizationDetail } from "./system/SystemOrganizationDetail";
import { SystemOrganizations } from "./system/SystemOrganizations";
import { SystemOverview } from "./system/SystemOverview";
import { PlatformRoute, SystemShell } from "./system/SystemShell";

function SecureScreen({ permission, children }: { permission?: Permission; children: ReactNode }) {
  return <ProtectedRoute permission={permission}>{children}</ProtectedRoute>;
}

function PublicAuthRoute({ children }: { children: ReactNode }) {
  const { status, homePath } = useAuth();
  return status === "authenticated" ? <Navigate to={homePath} replace /> : <>{children}</>;
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
  const { platformAccess, homePath } = useAuth();
  return (
    <ProtectedRoute>
      {platformAccess ? <Navigate to={homePath} replace /> : (
        <AppLoader>
          <AppShell><WorkspaceRoutes /></AppShell>
        </AppLoader>
      )}
    </ProtectedRoute>
  );
}

function SystemRoutes() {
  return (
    <Switch>
      <Route path="/system">
        <PlatformRoute permission="platform.organizations.view"><SystemOverview /></PlatformRoute>
      </Route>
      <Route path="/system/organizations/:id">
        <PlatformRoute permission="platform.organizations.view"><SystemOrganizationDetail /></PlatformRoute>
      </Route>
      <Route path="/system/organizations">
        <PlatformRoute permission="platform.organizations.view"><SystemOrganizations /></PlatformRoute>
      </Route>
      <Route path="/system/audit">
        <PlatformRoute permission="platform.audit.view"><SystemAudit /></PlatformRoute>
      </Route>
      <Route path="/system/account">
        <PlatformRoute allowDuringEnrollment><SystemAccount /></PlatformRoute>
      </Route>
      <Route><Navigate to="/system" replace /></Route>
    </Switch>
  );
}

function SystemWorkspace() {
  return (
    <PlatformRoute allowDuringEnrollment>
      <SystemShell><SystemRoutes /></SystemShell>
    </PlatformRoute>
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
          <Route path="/login"><PublicAuthRoute><AuthPage mode="login" /></PublicAuthRoute></Route>
          <Route path="/register"><PublicAuthRoute><AuthPage mode="register" /></PublicAuthRoute></Route>
          <Route path="/verify-email"><EmailVerification /></Route>
          <Route path="/forgot-password"><ForgotPassword /></Route>
          <Route path="/reset-password"><ResetPassword /></Route>
          <Route path="/accept-invitation"><InvitationAccept /></Route>
          <Route path="/capture"><Capture /></Route>
          <Route path="/system"><SystemWorkspace /></Route>
          <Route path="/system/*"><SystemWorkspace /></Route>
          <Route path="/app"><Workspace /></Route>
          <Route path="/app/*"><Workspace /></Route>
          <Route><Navigate to="/" replace /></Route>
        </Switch>
      </AuthProvider>
    </QueryClientProvider>
  );
}
