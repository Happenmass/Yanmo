import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './style.css';

const overlay = new URLSearchParams(location.search).get('view') === 'overlay';
document.documentElement.classList.toggle('overlay-document', overlay);
document.body.classList.toggle('overlay-body', overlay);
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
