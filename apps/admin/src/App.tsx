import { Navigate, Route, Routes } from "react-router-dom";
import Layout from "./components/Layout.tsx";
import RequireAuth from "./components/RequireAuth.tsx";
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
import PlaygroundPage from "./pages/PlaygroundPage.tsx";
import SettingsPage from "./pages/SettingsPage.tsx";
import OrganizationsPage from "./pages/OrganizationsPage.tsx";
import { useAuth } from "./auth/AuthContext.tsx";

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
        <Route index element={<DashboardPage />} />
        <Route path="providers" element={<ProvidersPage />} />
        <Route path="models" element={<ModelsPage />} />
        <Route path="customers" element={<CustomersPage />} />
        <Route path="plans" element={<PlansPage />} />
        <Route path="playground" element={<PlaygroundPage />} />
        <Route path="analytics" element={<AnalyticsPage />} />
        <Route path="api-keys" element={<ApiKeysPage />} />
        <Route path="organizations" element={<OrganizationsPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<RootRedirect />} />
    </Routes>
  );
}