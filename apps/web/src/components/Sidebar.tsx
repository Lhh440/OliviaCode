import { Icon, Mark } from '../icons';
import { navigate, type Route } from '../router';
import { createTask, useStore } from '../store';
import { relativeTime } from '@olivia/core';

const STATUS_TITLE: Record<string, string> = {
  idle: '未开始',
  running: '运行中',
  waiting: '等待确认',
  done: '已完成',
  failed: '失败',
  stopped: '已停止',
};

export function Sidebar({ route }: { route: Route }) {
  const { state, dispatch } = useStore();
  const { tasks, activeId, settings } = state;
  const activeTask = tasks.find((task) => task.id === activeId);
  const workspace = activeTask?.workspace;
  const workspaceName = workspace ? workspace.split(/[\\/]/).filter(Boolean).pop() : '本地工作区';

  const onNewTask = () => {
    const task = createTask(settings);
    dispatch({ type: 'addTask', task });
    navigate('chat');
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus();
    });
  };

  return (
    <aside className={`sidebar ${route === 'workflow' ? 'compact' : ''}`}>
      <div className="brand">
        <Mark size={22} />
        <span className="brand-name">OliviaCode</span>
        <span className="brand-ver">0.5</span>
      </div>

      <button className="new-task" onClick={onNewTask} title="新建任务">
        <Icon name="plus" size={15} />
        <span>新建任务</span>
        <span className="kbd">⌘N</span>
      </button>

      <nav className="nav">
        <button
          className={route === 'chat' ? 'active' : ''}
          onClick={() => navigate('chat')}
          title="任务"
        >
          <Icon name="message" size={15} />
          <span>任务</span>
          <span className="nav-count">{tasks.length}</span>
        </button>
        <button
          className={route === 'workflow' ? 'active' : ''}
          onClick={() => navigate('workflow')}
          title="工作流"
        >
          <Icon name="workflow" size={15} />
          <span>工作流</span>
          <span className="nav-count">1</span>
        </button>
        <button
          className={route === 'git' ? 'active' : ''}
          onClick={() => navigate('git')}
          title="Git"
        >
          <Icon name="git" size={15} />
          <span>Git</span>
        </button>
        <button
          className={route === 'settings' ? 'active' : ''}
          onClick={() => navigate('settings')}
          title="设置"
        >
          <Icon name="settings" size={15} />
          <span>设置</span>
        </button>
      </nav>

      <div className="sidebar-section">
        <div className="section-title">最近任务</div>
        <div className="task-list">
          {tasks.map((task) => (
            <button
              key={task.id}
              className={`task-item ${task.id === activeId ? 'active' : ''}`}
              onClick={() => {
                dispatch({ type: 'selectTask', id: task.id });
                navigate('chat');
              }}
              title={`${STATUS_TITLE[task.status] ?? task.status} · ${task.title}`}
            >
              <span className={`dot ${task.status}`} />
              <span className="task-title">{task.title}</span>
              <span className="task-time">{relativeTime(task.at)}</span>
            </button>
          ))}
          {tasks.length === 0 && <div className="empty-hint">还没有任务</div>}
        </div>
      </div>

      <div className="sidebar-foot">
        <div className="workspace-chip" title={workspace ?? '当前任务还没有绑定工作区'}>
          <Icon name="folder" size={14} />
          <span>{workspaceName}</span>
          <span className="workspace-state">{workspace ? '' : '未绑定'}</span>
        </div>
        <div className="foot-meta">
          {settings.apiKey ? (
            <span className="demo-pill online">
              <span className="live-dot" />
              已连接
            </span>
          ) : (
            <span className="demo-pill">
              <Icon name="sparkle" size={12} />
              演示模式
            </span>
          )}
          <span className="foot-version">v0.5.0 · M2+M3</span>
        </div>
      </div>
    </aside>
  );
}
