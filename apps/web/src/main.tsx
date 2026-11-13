import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/themes/base.css';
import './styles/themes/legacy.css';
import './styles/workflow.css';
import './styles/git.css';
import './styles/schedules.css';

const root = document.getElementById('root');
if (!root) throw new Error('缺少 #root 挂载点');

/** 渲染层崩了也要让人看见原因，而不是一片空白。 */
function showFatal(error: unknown): void {
  if (!root) return;
  const detail = error instanceof Error ? `${error.message}\n\n${error.stack ?? ''}` : String(error);
  root.innerHTML = '';
  const box = document.createElement('div');
  box.setAttribute('style', 'padding:32px;font:13px/1.6 ui-monospace,Consolas,monospace;color:#16181f;white-space:pre-wrap');
  box.textContent = `OliviaCode 渲染层出错，请把下面的信息贴给开发者：\n\n${detail}`;
  root.append(box);
}

window.addEventListener('error', (event) => showFatal(event.error ?? event.message));
window.addEventListener('unhandledrejection', (event) => showFatal(event.reason));

try {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
} catch (error) {
  showFatal(error);
}
