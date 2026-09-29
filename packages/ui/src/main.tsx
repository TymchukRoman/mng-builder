import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './styles/tokens.css';
import './styles/base.css';
import './styles/fonts.css';
import './ui/ui.css';
import './styles/screens.css';
import { ApiError } from './api';
import { initTheme } from './theme';
import { errorText, pushToast } from './ui/toasts';
import { App } from './App';

initTheme();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      refetchOnWindowFocus: false,
      // 4xx answers are final; only retry network trouble and 5xx once.
      retry: (count, err) => count < 1 && !(err instanceof ApiError && err.status >= 400 && err.status < 500),
    },
  },
  mutationCache: new MutationCache({ onError: (err) => pushToast('error', errorText(err)) }),
});

const root = document.getElementById('root');
if (!root) throw new Error('#root missing from index.html');
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
