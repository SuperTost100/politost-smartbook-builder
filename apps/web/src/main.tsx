import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import 'katex/dist/katex.min.css';
import './design-system/tokens.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/ui.css';
import './reader/reader.css';
import { App } from './App';
import { ToastProvider } from './components/Toast';
import { ApiRequestError } from './lib/api';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      refetchOnWindowFocus: true,
      retry: (count, err) => !(err instanceof ApiRequestError && err.status >= 400 && err.status < 500) && count < 2,
    },
  },
});

// A data router, because only it can hold back a move inside the app (useBlocker) while the figure dialog has unsaved edits. App declares its own routes below the one catch-all.
const router = createBrowserRouter([{ path: '*', element: <ToastProvider><App /></ToastProvider> }]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
