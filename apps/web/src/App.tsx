import { Sidebar } from './components/Sidebar';
import { useRoute } from './router';
import { StoreProvider } from './store';
import { ChatView } from './views/Chat';
import { GitView } from './views/Git';
import { SettingsView } from './views/Settings';
import { WorkflowView } from './views/Workflow';
import { ThemeProvider } from './components/theme/ThemeProvider';
import { BackgroundLayer } from './components/theme/BackgroundLayer';
import { Frame } from './components/theme/Frame';

function Shell() {
  const route = useRoute();
  return (
    <div className="relative w-full h-full overflow-hidden">
      <BackgroundLayer />

      <div className="relative z-10 flex h-full">
        <Sidebar route={route} />
        <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
          {route === 'chat' && <ChatView />}
          {route === 'workflow' && <WorkflowView />}
          {route === 'git' && <GitView />}
          {route === 'settings' && <SettingsView />}
        </main>
      </div>

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
