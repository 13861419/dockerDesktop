/**
 * 应用根组件
 *
 * 配置路由，并为全局包裹 Toast 提供者。
 * 采用 React.lazy 路由级代码分割：各业务页面按需懒加载（进入路由时才 fetch 对应 chunk），
 * 缩小首屏初始包体积；包裹层 Layout / RequireAuth 尺寸小且为外壳，保持同步导入以秒开。
 */
import { Suspense, lazy } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import RequireAuth from './components/RequireAuth';
import RequireAdmin from './components/RequireAdmin';
import { ToastProvider } from './components/Toast';
import { PageLoading } from './components/Loading';
import ErrorBoundary from './components/ErrorBoundary';

// ---- 路由级懒加载：各页面独立 chunk，进入路由时才加载 ----
const LoginPage = lazy(() => import('./pages/login'));
const OverviewPage = lazy(() => import('./pages/overview'));
const ContainersPage = lazy(() => import('./pages/containers'));
const ContainerDetailPage = lazy(() => import('./pages/containerDetail'));
const ImageDetailPage = lazy(() => import('./pages/imageDetail'));
const ImagesPage = lazy(() => import('./pages/images'));
const BuildPage = lazy(() => import('./pages/build'));
const VolumesPage = lazy(() => import('./pages/volumes'));
const StoragePage = lazy(() => import('./pages/storage'));
const NetworksPage = lazy(() => import('./pages/networks'));
const ComposePage = lazy(() => import('./pages/compose'));
const AppStorePage = lazy(() => import('./pages/appstore'));
const SettingsPage = lazy(() => import('./pages/settings'));
const HubPage = lazy(() => import('./pages/hub'));
const OperationLogsPage = lazy(() => import('./pages/operationLogs'));
const EventsPage = lazy(() => import('./pages/events'));
const TasksPage = lazy(() => import('./pages/tasks'));
const FilesPage = lazy(() => import('./pages/files'));
const HostFilesPage = lazy(() => import('./pages/hostFiles'));
const HostTerminalPage = lazy(() => import('./pages/hostTerminal'));
const EnginesPage = lazy(() => import('./pages/engines'));
const CloudBackupPage = lazy(() => import('./pages/cloudBackup'));
const SitesPage = lazy(() => import('./pages/sites'));
const DatabasesPage = lazy(() => import('./pages/databases'));
const BackupsPage = lazy(() => import('./pages/backups'));
const FirewallPage = lazy(() => import('./pages/firewall'));
const TemplatesPage = lazy(() => import('./pages/templates'));
const NotificationsPage = lazy(() => import('./pages/notifications'));

/**
 * 路由级 Suspense 包装：懒加载页面加载期间展示页面级加载态
 * @param param0 children 子路由元素
 */
function PageSuspense({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<PageLoading />}>{children}</Suspense>;
}

/**
 * 根组件
 */
export default function App() {
  return (
    <ErrorBoundary>
      <ToastProvider>
        <BrowserRouter>
        <Routes>
          {/* 登录页：独立页面，无需 Layout 与鉴权 */}
          <Route
            path="/login"
            element={
              <PageSuspense>
                <LoginPage />
              </PageSuspense>
            }
          />
          {/* 受保护路由：RequireAuth 校验登录态后再渲染 Layout 及其子路由 */}
          <Route element={<RequireAuth />}>
            <Route element={<Layout />}>
              <Route
                path="/"
                element={
                  <PageSuspense>
                    <OverviewPage />
                  </PageSuspense>
                }
              />
              <Route
                path="/containers"
                element={
                  <PageSuspense>
                    <ContainersPage />
                  </PageSuspense>
                }
              />
              <Route
                path="/containerDetail/:id"
                element={
                  <PageSuspense>
                    <ContainerDetailPage />
                  </PageSuspense>
                }
              />
              <Route
                path="/images"
                element={
                  <PageSuspense>
                    <ImagesPage />
                  </PageSuspense>
                }
              />
              <Route
                path="/build"
                element={
                  <PageSuspense>
                    <RequireAdmin>
                      <BuildPage />
                    </RequireAdmin>
                  </PageSuspense>
                }
              />
              <Route
                path="/image/:name"
                element={
                  <PageSuspense>
                    <ImageDetailPage />
                  </PageSuspense>
                }
              />
              <Route
                path="/volumes"
                element={
                  <PageSuspense>
                    <VolumesPage />
                  </PageSuspense>
                }
              />
              <Route
                path="/storage"
                element={
                  <PageSuspense>
                    <StoragePage />
                  </PageSuspense>
                }
              />
              <Route
                path="/networks"
                element={
                  <PageSuspense>
                    <NetworksPage />
                  </PageSuspense>
                }
              />
              <Route
                path="/compose"
                element={
                  <PageSuspense>
                    <ComposePage />
                  </PageSuspense>
                }
              />
              <Route
                path="/appstore"
                element={
                  <PageSuspense>
                    <AppStorePage />
                  </PageSuspense>
                }
              />
              <Route
                path="/settings"
                element={
                  <PageSuspense>
                    <SettingsPage />
                  </PageSuspense>
                }
              />
              <Route
                path="/hub"
                element={
                  <PageSuspense>
                    <HubPage />
                  </PageSuspense>
                }
              />
              <Route
                path="/operation-logs"
                element={
                  <PageSuspense>
                    <OperationLogsPage />
                  </PageSuspense>
                }
              />
              <Route
                path="/events"
                element={
                  <PageSuspense>
                    <EventsPage />
                  </PageSuspense>
                }
              />
              <Route
                path="/sites"
                element={
                  <PageSuspense>
                    <RequireAdmin>
                      <SitesPage />
                    </RequireAdmin>
                  </PageSuspense>
                }
              />
              <Route
                path="/tasks"
                element={
                  <PageSuspense>
                    <TasksPage />
                  </PageSuspense>
                }
              />
              <Route
                path="/files"
                element={
                  <PageSuspense>
                    <FilesPage />
                  </PageSuspense>
                }
              />
              <Route
                path="/hostfiles"
                element={
                  <PageSuspense>
                    <HostFilesPage />
                  </PageSuspense>
                }
              />
              <Route
                path="/hostterminal"
                element={
                  <PageSuspense>
                    <HostTerminalPage />
                  </PageSuspense>
                }
              />
              <Route
                path="/engines"
                element={
                  <PageSuspense>
                    <RequireAdmin>
                      <EnginesPage />
                    </RequireAdmin>
                  </PageSuspense>
                }
              />
              <Route
                path="/cloudbackup"
                element={
                  <PageSuspense>
                    <RequireAdmin>
                      <CloudBackupPage />
                    </RequireAdmin>
                  </PageSuspense>
                }
              />
              <Route
                path="/backups"
                element={
                  <PageSuspense>
                    <BackupsPage />
                  </PageSuspense>
                }
              />
              <Route
                path="/databases"
                element={
                  <PageSuspense>
                    <DatabasesPage />
                  </PageSuspense>
                }
              />
              <Route
                path="/firewall"
                element={
                  <PageSuspense>
                    <RequireAdmin>
                      <FirewallPage />
                    </RequireAdmin>
                  </PageSuspense>
                }
              />
              <Route
                path="/templates"
                element={
                  <PageSuspense>
                    <RequireAdmin>
                      <TemplatesPage />
                    </RequireAdmin>
                  </PageSuspense>
                }
              />
              <Route
                path="/notifications"
                element={
                  <PageSuspense>
                    <RequireAdmin>
                      <NotificationsPage />
                    </RequireAdmin>
                  </PageSuspense>
                }
              />
            </Route>
          </Route>
        </Routes>
      </BrowserRouter>
      </ToastProvider>
    </ErrorBoundary>
  );
}
