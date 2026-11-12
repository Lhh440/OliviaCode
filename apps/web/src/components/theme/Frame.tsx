/** 古典版画外框：叠在界面之上，给整个窗口一道鎏金细边。 */
export function Frame() {
  return (
    <div className="fixed inset-0 z-[60] pointer-events-none" aria-hidden="true">
      <div className="absolute inset-[9px] border border-light-gold/30 dark:border-dark-gold/22 rounded-[3px]" />
      <div className="absolute inset-[14px] border border-light-gold/12 dark:border-dark-gold/10 rounded-[2px]" />
      {CORNERS.map((corner) => (
        <span
          key={corner}
          className={`absolute w-3.5 h-3.5 border-light-gold/55 dark:border-dark-gold/45 ${corner}`}
        />
      ))}
    </div>
  );
}

const CORNERS = [
  'left-[9px] top-[9px] border-l-2 border-t-2',
  'right-[9px] top-[9px] border-r-2 border-t-2',
  'left-[9px] bottom-[9px] border-l-2 border-b-2',
  'right-[9px] bottom-[9px] border-r-2 border-b-2',
];
