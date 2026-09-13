import { createBrowserRouter, RouterProvider } from 'react-router';

import { PlaceholderPage } from '../components/PlaceholderPage';
import { ChatPage } from '../features/chat/ChatPage';
import { CharactersPage } from '../features/library/CharactersPage';
import { LorebooksPage } from '../features/library/LorebooksPage';
import { PersonasPage } from '../features/library/PersonasPage';
import { PresetsPage } from '../features/library/PresetsPage';
import { ConnectionsPage } from '../features/settings/ConnectionsPage';
import { SettingsPage } from '../features/settings/SettingsPage';
import { AppLayout } from './AppLayout';

const router = createBrowserRouter([
  {
    element: <AppLayout />,
    children: [
      { path: '/', element: <ChatPage /> },
      { path: '/characters', element: <CharactersPage /> },
      { path: '/presets', element: <PresetsPage /> },
      { path: '/lorebooks', element: <LorebooksPage /> },
      { path: '/personas', element: <PersonasPage /> },
      { path: '/studio', element: <PlaceholderPage titleKey="nav.studio" /> },
      { path: '/writing', element: <PlaceholderPage titleKey="nav.writing" /> },
      { path: '/connections', element: <ConnectionsPage /> },
      { path: '/migration', element: <PlaceholderPage titleKey="nav.migration" /> },
      { path: '/settings', element: <SettingsPage /> },
    ],
  },
]);

export function AppRouter() {
  return <RouterProvider router={router} />;
}
