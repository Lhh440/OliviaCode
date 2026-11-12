import { useEffect, useRef } from 'react';
import { Icon } from '../icons';

interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  disabled?: boolean;
  placeholder?: string;
  hint?: string;
}

export function Composer({ value, onChange, onSend, disabled, placeholder, hint }: ComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(220, Math.max(52, el.scrollHeight))}px`;
  }, [value]);

  return (
    <div className="composer">
      <textarea
        ref={ref}
        rows={1}
        value={value}
        spellCheck={false}
        placeholder={placeholder ?? '描述你要做的事，@ 引用文件，/ 触发技能'}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            onSend();
          }
        }}
      />
      <div className="composer-bar">
        <div className="composer-tools">
          <button type="button" className="icon-btn" title="引用文件（M1 开放）">
            <Icon name="at" size={16} />
          </button>
          <button type="button" className="icon-btn" title="技能（M1 开放）">
            <Icon name="slash" size={16} />
          </button>
          <button type="button" className="icon-btn" title="附件（M1 开放）">
            <Icon name="paperclip" size={16} />
          </button>
        </div>
        <div className="composer-right">
          <span className="composer-hint">{hint ?? 'Enter 发送 · Shift+Enter 换行'}</span>
          <button
            type="button"
            className="send-btn"
            onClick={onSend}
            disabled={disabled || !value.trim()}
            title="发送"
          >
            <Icon name="send" size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
