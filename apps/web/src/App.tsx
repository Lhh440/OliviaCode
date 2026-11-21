import { Sidebar } from './components/Sidebar';
import { useRoute } from './router';
import { StoreProvider } from './store';
import { ChatView } from './views/Chat';
import { ExtensionsView } from './views/Extensions';
import { GitView } from './views/Git';
import { SchedulesView } from './views/Schedules';
import { SettingsView } from './views/Settings';
import { WorkflowView } from './views/Workflow';
import { ThemeProvider } from './components/theme/ThemeProvider';
import { BackgroundLayer } from './components/theme/BackgroundLayer';
import { RippleLayer } from './components/theme/RippleLayer';
import { Frame } from './components/theme/Frame';

function Shell() {
  const route = useRoute();
  return (
    <div className="relative w-full h-full overflow-hidden">
      <BackgroundLayer />

      <div className="relative z-10 flex h-full">
        <Sidebar route={route} />
        <main className="relative flex-1 flex flex-col min-w-0 overflow-hidden isolate">
          {/* 阅读衬底：鱼在水里，正文在纸上；这一层把鱼压成水印，面板再盖在它上面 */}
          <div className="pane-veil" aria-hidden="true" />
          {route === 'chat' && <ChatView />}
          {route === 'workflow' && <WorkflowView />}
          {route === 'schedules' && <SchedulesView />}
          {route === 'extensions' && <ExtensionsView />}
          {route === 'git' && <GitView />}
          {route === 'settings' && <SettingsView />}
        </main>
      </div>

      <RippleLayer />
      <Frame />
    </div>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <StoreProvider>
        <Shell />
      </StoreProvider>
    </ThemeProvider>
  );
}
