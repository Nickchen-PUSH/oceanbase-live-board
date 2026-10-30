import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { hit } from './lib/api.ts';
import { LiveProvider } from './lib/live.tsx';
import { router } from './router.tsx';

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: true } },
});

hit({ k: 'pv', r: document.referrer || '' });

const root = (import.meta.hot?.data.root as ReturnType<typeof createRoot> | undefined) ?? createRoot(document.getElementById('root')!);
if (import.meta.hot) import.meta.hot.data.root = root;

root.render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <LiveProvider>
        <RouterProvider router={router} />
      </LiveProvider>
    </QueryClientProvider>
  </StrictMode>,
);
