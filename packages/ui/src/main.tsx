import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/base.css';
import { initTheme } from './theme';
import { App } from './App';

initTheme();
const root = document.getElementById('root');
if (!root) throw new Error('#root missing from index.html');
createRoot(root).render(<StrictMode><App /></StrictMode>);
