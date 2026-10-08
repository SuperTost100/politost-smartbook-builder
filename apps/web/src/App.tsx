import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Shell } from './features/shell/Shell';
import { ProjectsPage } from './features/projects/ProjectsPage';

const BookSetup = lazy(() => import('./features/setup/BookSetup'));
const SourcesPage = lazy(() => import('./features/sources/SourcesPage'));
const OutlinePage = lazy(() => import('./features/outline/OutlinePage'));
const ManuscriptPage = lazy(() => import('./features/manuscript/ManuscriptPage'));
const PreviewPage = lazy(() => import('./features/manuscript/PreviewPage'));
const PracticePage = lazy(() => import('./features/practice/PracticePage'));
const ExtrasPage = lazy(() => import('./features/extras/ExtrasPage'));
const ReviewPage = lazy(() => import('./features/review/ReviewPage'));
const ExportPage = lazy(() => import('./features/export/ExportPage'));
const RunPage = lazy(() => import('./features/run/RunPage'));
const ConnectionsPage = lazy(() => import('./features/connections/ConnectionsPage'));

function Loading() {
  return <div className="ui-page" aria-busy="true"><div className="ui-skeleton" style={{ height: 28, width: 240 }} /><div className="ui-skeleton" style={{ height: 160 }} /></div>;
}

export function App() {
  return (
    <Suspense fallback={<Loading />}>
      <Routes>
        <Route element={<Shell />}>
          <Route index element={<ProjectsPage />} />
          <Route path="new" element={<BookSetup />} />
          <Route path="connections" element={<ConnectionsPage />} />
          <Route path="books/:id">
            <Route index element={<Navigate to="sources" replace />} />
            <Route path="settings" element={<BookSetup />} />
            <Route path="sources/:rid?" element={<SourcesPage />} />
            <Route path="outline" element={<OutlinePage />} />
            <Route path="manuscript/:nodeId?" element={<ManuscriptPage />} />
            <Route path="preview/:chapterId" element={<PreviewPage />} />
            <Route path="practice" element={<PracticePage />} />
            <Route path="extras" element={<ExtrasPage />} />
            <Route path="review" element={<ReviewPage />} />
            <Route path="export" element={<ExportPage />} />
            <Route path="run" element={<RunPage />} />
          </Route>
          <Route path="*" element={<div className="ui-page"><h1 className="ui-screen-title">Page not found</h1><p className="ui-lede">This address does not match a screen. Go back to your books.</p><a className="ui-btn ui-btn--accent" style={{ alignSelf: 'flex-start' }} href="/">Open books</a></div>} />
        </Route>
      </Routes>
    </Suspense>
  );
}
