import { motion, AnimatePresence } from 'framer-motion';
import { relativeTime } from '@olivia/core';
import { Icon, Mark } from '../icons';
import { navigate, type Route } from '../router';
import { createTask, useStore } from '../store';
import { useTheme } from '../hooks/useTheme';
import { ThemePicker } from './theme/ThemePicker';

const STATUS_TITLE: Record<string, string> = {
  idle: '未开始',
  running: '运行中',
  waiting: '等待确认',
  done: '已完成',
  failed: '失败',
  stopped: '已停止',
};

const STATUS_DOT: Record<string, string> = {
  idle: 'bg-light-inkFaint dark:bg-dark-inkFaint',
  running: 'bg-blue-500 animate-pulse',
  waiting: 'bg-amber-500',
  done: 'bg-emerald-500',
  failed: 'bg-red-500',
  stopped: 'bg-light-inkFaint dark:bg-dark-inkFaint',
};

const NAV: { id: Route; icon: string; label: string }[] = [
  { id: 'chat', icon: 'message', label: '任务' },
  { id: 'workflow', icon: 'workflow', label: '工作流' },
  { id: 'git', icon: 'git', label: 'Git' },
  { id: 'settings', icon: 'settings', label: '设置' },
];

export function Sidebar({ route }: { route: Route }) {
  const { state, dispatch } = useStore();
  const { tasks, activeId, settings } = state;
  const { skin, toggleMode } = useTheme();
  const activeTask = tasks.find((task) => task.id === activeId);
  const workspace = activeTask?.workspace;
  const workspaceName = workspace ? workspace.split(/[\\/]/).filter(Boolean).pop() : '本地工作区';

  const onNewTask = () => {
    const task = createTask(settings);
    dispatch({ type: 'addTask', task });
    navigate('chat');
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLTextAreaElement>('.composer textarea, textarea')?.focus();
    });
  };

  return (
    <aside className="w-[248px] shrink-0 h-full flex flex-col border-r border-light-gold/25 dark:border-dark-gold/15 bg-gradient-to-b from-light-bg/85 via-light-bg/72 to-light-bg/90 dark:from-black/55 dark:via-black/42 dark:to-black/60 backdrop-blur-2xl relative z-10 shadow-[inset_-1px_0_0_rgba(255,255,255,0.35)] dark:shadow-[inset_-1px_0_0_rgba(255,255,255,0.04)]">
      <div className="h-[2px] shrink-0 rule-ornate opacity-80" />
      {/* —— 品牌 —— */}
      <div className="px-4 pt-4 pb-3">
        <div className="flex items-center gap-2.5">
          <span
            className="w-9 h-9 shrink-0 rounded-full grid place-items-center border shadow-sm"
            style={{
              borderColor: 'color-mix(in srgb, var(--olivia-accent) 28%, transparent)',
              background:
                'linear-gradient(135deg, rgba(255,255,255,0.9), color-mix(in srgb, var(--olivia-accent) 14%, transparent))',
              color: 'var(--olivia-accent)',
            }}
          >
            <Mark size={20} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-serif text-[15px] font-semibold leading-tight tracking-tight text-light-ink dark:text-dark-ink">
              OliviaCode
            </span>
            <span className="block text-[10px] tracking-[0.14em] uppercase text-light-inkFaint dark:text-dark-inkFaint">
              {skin.name} · 0.5
            </span>
          </span>
          <ThemePicker />
          <motion.button
            onClick={toggleMode}
            whileHover={{ scale: 1.08 }}
            whileTap={{ scale: 0.92 }}
            className="w-7 h-7 shrink-0 grid place-items-center rounded-lg text-light-inkMuted dark:text-dark-inkMuted hover:bg-black/[0.05] dark:hover:bg-white/[0.08] hover:text-light-ink dark:hover:text-dark-ink transition-colors"
            title={skin.mode === 'light' ? '切到本组的暗色主题' : '切到本组的亮色主题'}
          >
            <AnimatePresence mode="wait" initial={false}>
              <motion.span
                key={skin.mode}
                initial={{ opacity: 0, rotate: -90, scale: 0.6 }}
                animate={{ opacity: 1, rotate: 0, scale: 1 }}
                exit={{ opacity: 0, rotate: 90, scale: 0.6 }}
                transition={{ duration: 0.2 }}
                className="grid place-items-center"
              >
                <Icon name={skin.mode === 'light' ? 'moon' : 'sun'} size={14} />
              </motion.span>
            </AnimatePresence>
          </motion.button>
        </div>
      </div>

      {/* —— 新建 —— */}
      <div className="px-3 pb-3">
        <motion.button
          onClick={onNewTask}
          whileHover={{ y: -1 }}
          whileTap={{ scale: 0.985 }}
          className="group relative w-full flex items-center gap-2 h-9 px-3 rounded-xl overflow-hidden text-white text-[12.5px] font-medium shadow-md transition-all"
          style={{
            background: 'var(--olivia-accent)',
            boxShadow: '0 6px 16px -8px color-mix(in srgb, var(--olivia-accent) 70%, transparent)',
          }}
          title="新建任务"
        >
          <span className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity bg-gradient-to-r from-white/0 via-white/25 to-white/0 animate-sheen" />
          <Icon name="plus" size={14} />
          <span>新建任务</span>
          <span className="ml-auto text-[10.5px] opacity-70 font-normal">⌘N</span>
        </motion.button>
      </div>

      {/* —— 导航 —— */}
      <nav className="px-2 pb-2 space-y-0.5">
        {NAV.map((item) => {
          const active = route === item.id;
          return (
            <button
              key={item.id}
              onClick={() => navigate(item.id)}
              className={`relative w-full flex items-center gap-2.5 h-8 px-2.5 rounded-lg text-[12.5px] transition-colors ${
                active
                  ? 'text-light-ink dark:text-dark-ink font-medium bg-white/85 dark:bg-white/[0.09] shadow-sm border border-light-line/70 dark:border-dark-line/70'
                  : 'text-light-inkMuted dark:text-dark-inkMuted border border-transparent hover:text-light-ink dark:hover:text-dark-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.05]'
              }`}
            >
              <Icon name={item.icon} size={14} className="relative shrink-0" />
              <span className="relative flex-1 text-left">{item.label}</span>
              {item.id === 'chat' && tasks.length > 0 && (
                <span className="relative text-[10.5px] tabular-nums text-light-inkFaint dark:text-dark-inkFaint">
                  {tasks.length}
                </span>
              )}
              {item.id === 'workflow' && (
                <span className="relative text-[10.5px] tabular-nums text-light-inkFaint dark:text-dark-inkFaint">1</span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="mx-4 h-px rule-ornate opacity-70" />

      {/* —— 最近任务 —— */}
      <div className="flex-1 min-h-0 flex flex-col px-2 pt-3">
        <div className="px-2 pb-1.5 flex items-baseline justify-between">
          <span className="eyebrow !text-light-inkFaint dark:!text-dark-inkFaint">最近任务</span>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto pr-0.5 space-y-0.5">
          {tasks.map((task) => {
            const active = task.id === activeId;
            return (
              <button
                key={task.id}
                onClick={() => {
                  dispatch({ type: 'selectTask', id: task.id });
                  navigate('chat');
                }}
                title={`${STATUS_TITLE[task.status] ?? task.status} · ${task.title}`}
                className={`relative w-full flex items-start gap-2 px-2.5 py-2 rounded-lg text-left transition-colors ${
                  active
                    ? 'bg-white/70 dark:bg-white/[0.07] shadow-sm'
                    : 'hover:bg-black/[0.035] dark:hover:bg-white/[0.045]'
                }`}
              >
                {active && (
                  <span className="absolute left-0 top-1/2 -translate-y-1/2 w-[2px] h-5 rounded-full bg-light-gold dark:bg-dark-gold" />
                )}
                <span className={`mt-[6px] w-1.5 h-1.5 shrink-0 rounded-full ${STATUS_DOT[task.status] ?? STATUS_DOT.idle}`} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[12.5px] leading-snug truncate text-light-ink dark:text-dark-ink">
                    {task.title}
                  </span>
                  <span className="block mt-0.5 text-[10.5px] text-light-inkFaint dark:text-dark-inkFaint">
                    {relativeTime(task.at)}
                  </span>
                </span>
              </button>
            );
          })}
          {tasks.length === 0 && (
            <p className="px-2.5 py-6 text-center text-[11.5px] text-light-inkFaint dark:text-dark-inkFaint">
              还没有任务
            </p>
          )}
        </div>
      </div>

      {/* —— 页脚 —— */}
      <div className="px-3 pb-3 pt-2 space-y-2">
        <button
          onClick={() => navigate('settings')}
          className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg border border-light-line dark:border-dark-line bg-white/55 dark:bg-white/[0.04] hover:bg-white/80 dark:hover:bg-white/[0.07] transition-colors text-left"
          title={workspace ?? '当前任务还没有绑定工作区'}
        >
          <Icon name="folder" size={12} className="shrink-0 text-light-accent dark:text-dark-gold" />
          <span className="min-w-0 flex-1 text-[11.5px] truncate text-light-ink dark:text-dark-ink">
            {workspaceName}
          </span>
          {!workspace && (
            <span className="shrink-0 text-[10px] text-amber-600 dark:text-amber-400">未绑定</span>
          )}
        </button>

        <div className="flex items-center justify-between px-1 text-[10.5px]">
          {settings.apiKey ? (
            <span className="inline-flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              已连接
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-light-inkFaint dark:text-dark-inkFaint">
              <Icon name="sparkle" size={10} />
              演示模式
            </span>
          )}
          <span className="text-light-inkFaint dark:text-dark-inkFaint">M2+M3+M4</span>
        </div>
      </div>
    </aside>
  );
}
