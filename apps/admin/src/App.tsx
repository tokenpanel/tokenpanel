import { Navigate, Route, Routes } from "react-router-dom";
import Layout from "./components/Layout.tsx";
import RequireAuth from "./components/RequireAuth.tsx";
import RequirePermission from "./components/RequirePermission.tsx";
import { SidebarProvider } from "./components/ui/sidebar.tsx";
import LoginPage from "./pages/LoginPage.tsx";
import SignupPage from "./pages/SignupPage.tsx";
import ProvidersPage from "./pages/ProvidersPage.tsx";
import ModelsPage from "./pages/ModelsPage.tsx";
import CustomersPage from "./pages/CustomersPage.tsx";
import PlansPage from "./pages/PlansPage.tsx";
import DashboardPage from "./pages/DashboardPage.tsx";
import AnalyticsPage from "./pages/AnalyticsPage.tsx";
import ApiKeysPage from "./pages/ApiKeysPage.tsx";
import ManagementKeysPage from "./pages/ManagementKeysPage.tsx";
import PlaygroundPage from "./pages/PlaygroundPage.tsx";
import SettingsPage from "./pages/SettingsPage.tsx";
import OrganizationsPage from "./pages/OrganizationsPage.tsx";
import { useAuth } from "./auth/AuthContext.tsx";
import type { PanelPermission } from "./auth/AuthContext.tsx";

function FullScreenLoader(): React.ReactElement {
  return (
    <div className="flex min-h-screen items-center justify-center text-muted-foreground">
      Loading…
    </div>
  );
}

function RootRedirect(): React.ReactElement {
  const { user, loading, needsSetup } = useAuth();

  // loading true OR status fetch failed (needsSetup === null): wait, don't
  // route yet — otherwise a transient network/CORS error would bounce us to
  // /login and hide the first-run signup flow.
  if (loading || needsSetup === null) {
    return <FullScreenLoader />;
  }
  if (needsSetup && !user) return <Navigate to="/signup" replace />;
  if (!user) return <Navigate to="/login" replace />;
  return <Navigate to="/" replace />;
}

function Guarded({
  permission,
  page,
}: {
  permission: PanelPermission | null;
  page: React.ReactElement;
}): React.ReactElement {
  return <RequirePermission permission={permission}>{page}</RequirePermission>;
}

export default function App(): React.ReactElement {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/signup" element={<SignupPage />} />
      <Route path="/root" element={<RootRedirect />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <SidebarProvider>
              <Layout />
            </SidebarProvider>
          </RequireAuth>
        }
      >
        <Route index element={<Guarded permission="dashboard:read" page={<DashboardPage />} />} />
        <Route
          path="providers"
          element={<Guarded permission="providers:read" page={<ProvidersPage />} />}
        />
        <Route path="models" element={<Guarded permission="models:read" page={<ModelsPage />} />} />
        <Route
          path="customers"
          element={<Guarded permission="customers:read" page={<CustomersPage />} />}
        />
        <Route path="plans" element={<Guarded permission="plans:read" page={<PlansPage />} />} />
        <Route
          path="playground"
          element={<Guarded permission="playground:write" page={<PlaygroundPage />} />}
        />
        <Route
          path="analytics"
          element={<Guarded permission="usage:read" page={<AnalyticsPage />} />}
        />
        <Route
          path="api-keys"
          element={<Guarded permission="customer_keys:read" page={<ApiKeysPage />} />}
        />
        <Route
          path="management-keys"
          element={<Guarded permission="management_keys:read" page={<ManagementKeysPage />} />}
        />
        {/* Orgs + settings: any authenticated member (no panel atom). */}
        <Route path="organizations" element={<Guarded permission={null} page={<OrganizationsPage />} />} />
        <Route path="settings" element={<Guarded permission={null} page={<SettingsPage />} />} />
      </Route>
      <Route path="*" element={<RootRedirect />} />
    </Routes>
  );
}
