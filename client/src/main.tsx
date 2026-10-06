import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { QueryClientProvider } from '@tanstack/react-query';
import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import './styles/global.css';
import { App } from './app/App';
import { queryClient } from './lib/query/query-client';
import { highstackTheme } from './app/theme';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root element');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <MantineProvider theme={highstackTheme} forceColorScheme="dark">
        <Notifications position="top-right" className="hs-notifications" />
        <App />
      </MantineProvider>
    </QueryClientProvider>
  </StrictMode>,
);
