import { Sidebar } from './components/Sidebar';
import { useRoute } from './router';
import { StoreProvider } from './store';
import { ChatView } from './views/Chat';
import { GitView } from './views/Git';
import { SettingsView } from './views/Settings';
import { WorkflowView } from './views/Workflow';

function Shell() {
  const route = useRoute();
  return (
    <div className={`app route-${route}`}>
      <Sidebar route={route} />
      <div className="stage">
        {route === 'chat' && <ChatView />}
        {route === 'workflow' && <WorkflowView />}
        {route === 'git' && <GitView />}
        {route === 'settings' && <SettingsView />}
      </div>
    </div>
  );
}

export default function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}
