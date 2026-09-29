import type { JSX } from 'react';
import { createBrowserRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { MangaListPage } from './mangas/MangaListPage';
import { RenderPage } from './render/RenderPage';
import { Shell } from './shell/Shell';

const router = createBrowserRouter([
  // The print route sits outside the shell: no chrome, exact print pixels.
  { path: '/render/page/:pageId', element: <RenderPage /> },
  {
    path: '/',
    element: <Shell />,
    children: [
      { index: true, element: <MangaListPage /> },
    ],
  },
]);

export function App(): JSX.Element {
  return <RouterProvider router={router} />;
}
