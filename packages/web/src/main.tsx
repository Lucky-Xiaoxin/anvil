import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { TipProvider } from './tip.tsx';
import './styles.css';

const host = document.getElementById('root');
if (!host) throw new Error('缺少 #root');
createRoot(host).render(
  <TipProvider>
    <App />
  </TipProvider>,
);
