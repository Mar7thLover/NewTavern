import { createBrowserRouter, RouterProvider } from 'react-router';

import { PlaceholderPage } from '../components/PlaceholderPage';
import { SettingsPage } from '../features/settings/SettingsPage';
import { AppLayout } from './AppLayout';

const router = createBrowserRouter([
  {
    element: <AppLayout />,
    children: [
      { path: '/', element: <PlaceholderPage titleKey="nav.chat" /> },
      { path: '/characters', element: <PlaceholderPage titleKey="nav.characters" /> },
      { path: '/presets', element: <PlaceholderPage titleKey="nav.presets" /> },
      { path: '/lorebooks', element: <PlaceholderPage titleKey="nav.lorebooks" /> },
      { path: '/personas', element: <PlaceholderPage titleKey="nav.personas" /> },
      { path: '/studio', element: <PlaceholderPage titleKey="nav.studio" /> },
      { path: '/writing', element: <PlaceholderPage titleKey="nav.writing" /> },
      { path: '/connections', element: <PlaceholderPage titleKey="nav.connections" /> },
      { path: '/migration', element: <PlaceholderPage titleKey="nav.migration" /> },
      { path: '/settings', element: <SettingsPage /> },
    ],
  },
]);

export function AppRouter() {
  return <RouterProvider router={router} />;
}
