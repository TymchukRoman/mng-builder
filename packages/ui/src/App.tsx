import type { JSX } from 'react';
import { createBrowserRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { Shell } from './shell/Shell';

const router = createBrowserRouter([
  {
    path: '/',
    element: <Shell />,
    children: [
      { index: true, element: <section className="screen" aria-label="Start" /> },
    ],
  },
]);

export function App(): JSX.Element {
  return <RouterProvider router={router} />;
}
