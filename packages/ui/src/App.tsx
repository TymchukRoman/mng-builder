import type { JSX } from 'react';
import { createBrowserRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { ChapterPage } from './chapter/ChapterPage';
import { CoverPage } from './chapter/CoverPage';
import { GalleryPage } from './gallery/GalleryPage';
import { MangaPage } from './manga/MangaPage';
import { MangaListPage } from './mangas/MangaListPage';
import { RenderPage } from './render/RenderPage';
import { SettingsPage } from './settings/SettingsPage';
import { Shell } from './shell/Shell';

/** The final route table (Contract E). */
const router = createBrowserRouter([
  // The print route sits outside the shell: no chrome, exact print pixels.
  { path: '/render/page/:pageId', element: <RenderPage /> },
  {
    path: '/',
    element: <Shell />,
    children: [
      { index: true, element: <MangaListPage /> },
      { path: 'm/:mangaId', element: <MangaPage /> },
      { path: 'm/:mangaId/cover', element: <CoverPage /> },
      { path: 'm/:mangaId/c/:chapterId', element: <ChapterPage /> },
      { path: 'm/:mangaId/c/:chapterId/cover', element: <CoverPage /> },
      { path: 'gallery', element: <GalleryPage /> },
      { path: 'settings', element: <SettingsPage /> },
    ],
  },
]);

export function App(): JSX.Element {
  return <RouterProvider router={router} />;
}
