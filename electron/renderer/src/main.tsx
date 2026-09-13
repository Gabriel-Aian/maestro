import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { LoginWidget } from './LoginWidget.js';
import './styles.css';

// O widget de login é a mesma build do app, só que aberto numa janela
// separada (transparente, sem moldura) apontando para uma rota diferente —
// evita precisar de um segundo entry point no electron-vite.
const isLoginWidget = window.location.hash.startsWith('#/login-widget');
if (isLoginWidget) document.body.classList.add('widget-mode');

const container = document.getElementById('root');
if (!container) throw new Error('Elemento #root não encontrado.');

createRoot(container).render(<StrictMode>{isLoginWidget ? <LoginWidget /> : <App />}</StrictMode>);
