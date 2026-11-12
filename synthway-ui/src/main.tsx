import React from 'react';
import ReactDOM from 'react-dom/client';
// The theme's stylesheets (src/themes): its variables, the page's rules, then
// every component's (imported by them), and last the theme's overrides
import '@theme/fonts.css';
import '@theme/theme.css';
import '@theme/base.css';
import { App } from './App';
import '@theme/overrides.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
