import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import PublicLayout from './components/layouts/PublicLayout';
import DashboardLayout from './components/layouts/DashboardLayout';
import ProtectedRoute from './components/ProtectedRoute';
import HomePage from './pages/HomePage';
import LoginPage from './pages/LoginPage';
import SignupPage from './pages/SignupPage';
import PromptPage from './pages/PromptPage';
import OverviewPage from './pages/dashboard/OverviewPage';
import RoutingPoliciesPage from './pages/dashboard/RoutingPoliciesPage';
import SemanticCachePage from './pages/dashboard/SemanticCachePage';
import NotFoundPage from './pages/NotFoundPage';
import { AuthProvider } from './utils/auth';

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          {/* Public pages with nav */}
          <Route element={<PublicLayout />}>
            <Route path="/" element={<HomePage />} />
          </Route>

          {/* Standalone pages (no shared nav) */}
          <Route path="/login" element={<LoginPage />} />
          <Route path="/signup" element={<SignupPage />} />
          <Route path="/prompt" element={<ProtectedRoute><PromptPage /></ProtectedRoute>} />

          {/* Dashboard pages */}
          <Route element={<ProtectedRoute><DashboardLayout /></ProtectedRoute>}>
            <Route path="/dashboard/overview" element={<OverviewPage />} />
            <Route path="/dashboard/routing-policies" element={<RoutingPoliciesPage />} />
            <Route path="/dashboard/semantic-cache" element={<SemanticCachePage />} />
            <Route path="/dashboard/budget" element={<Navigate to="/dashboard/overview" replace />} />
          </Route>

          {/* 404 */}
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
