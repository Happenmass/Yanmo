import { useEffect, useRef, useState } from 'react';
import { AppWindow } from 'lucide-react';
import { DailyUsage, LLM_PURPOSES, LLMPurpose, localDayDate, localDayKey, shiftLocalDay } from '../shared';

const number = new Intl.NumberFormat('zh-CN');
const formatTokens = (value: number | null) => value === null ? '—' : number.format(value);
const purposeLabels = Object.entries(LLM_PURPOSES) as [LLMPurpose, string][];

export function DailyDetails({ day, onBack, onDay }: { day: string; onBack: () => void; onDay: (day: string) => void }) {
  const [usage, setUsage] = useState<DailyUsage>();
  const [failed, setFailed] = useState(false);
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => { back.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => {
    let active = true;
    let pending = false;
    async function refresh() {
      if (pending) return;
      pending = true;
      try {
        const result = await window.yanmo.dailyUsage(day);
        if (active) { setUsage(result); setFailed(false); }
      } catch {
        if (active) setFailed(true);
      } finally { pending = false; }
    }
    void refresh();
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 4000);
    return () => { active = false; clearInterval(timer); };
  }, [day]);
  const date = localDayDate(day);
  const today = localDayKey(new Date());
  const dateLabel = (date.getFullYear() === new Date().getFullYear() ? '' : date.getFullYear() + '年') +
    (date.getMonth() + 1) + '月' + date.getDate() + '日';
  const change = usage && usage.previousSent ? (usage.sent / usage.previousSent - 1) * 100 : null;
  return <section className="usage daily-detail" aria-label="当日详情">
    <header className="daily-heading">
      <button ref={back} className="text-button red daily-back" onClick={onBack}>‹ 返回日历</button>
      <h3><time dateTime={day}>{dateLabel}</time><small> · 周{'日一二三四五六'[date.getDay()]}</small></h3>
      <nav aria-label="切换日期">
        <button className="text-button" onClick={() => onDay(shiftLocalDay(day, -1))}>‹ 前一天</button>
        <button className="text-button" disabled={day >= today} onClick={() => onDay(shiftLocalDay(day, 1))}>后一天 ›</button>
      </nav>
    </header>
    {failed ? <p className="empty-line" role="status">暂时无法读取本机统计。</p>
      : !usage ? <p className="empty-line" role="status">正在读取本机统计…</p>
      : usage.coverage === 'unrecorded' ? <p className="empty-line">这一天尚未开始记录使用统计。</p>
      : <>
        <section className="daily-sent">
          <h4>当日发送</h4>
          <div><strong>{number.format(usage.sent)}</strong><span>字</span>
            {typeof change === 'number' && <small>较前一天 <b>{change > 0 ? '+' : ''}{change.toFixed(1)}%</b></small>}
          </div>
          {usage.coverage === 'partial' && <p className="fine-print">本日从启用统计时开始记录。</p>}
        </section>
        <section className="daily-apps" aria-labelledby="daily-apps-title">
          <h4 id="daily-apps-title">各应用发送字数</h4>
          {usage.apps.length ? <table aria-labelledby="daily-apps-title">
            <colgroup><col className="daily-app-column"/><col/><col className="daily-total-column"/></colgroup>
            <thead><tr><th scope="col" colSpan={2}><span className="daily-visually-hidden">应用</span></th>
              <th scope="col" aria-sort="descending">发送总量 ↓</th></tr></thead>
            <tbody>{usage.apps.map(item => <tr key={item.appKey}>
              <th scope="row" title={item.name}><span className="daily-app-name">
                {item.icon ? <img className="daily-app-icon" src={item.icon} alt=""/> : <AppWindow className="daily-app-icon" aria-hidden="true"/>}
                <span>{item.name}</span>
              </span></th>
              <td aria-hidden="true"><span className="daily-bar"><i style={{ width: item.sent / usage.apps[0].sent * 100 + '%' }}/></span></td>
              <td>{number.format(item.sent)}</td>
            </tr>)}</tbody>
          </table> : <p className="empty-line">当天没有应用发送记录。</p>}
        </section>
        <section className="daily-llm">
          <header><h4>LLM 用量</h4><div><strong>{formatTokens(usage.llm.total)}</strong> <span>token</span></div></header>
          <dl>{purposeLabels.map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{formatTokens(usage.llm.byPurpose[key])}</dd></div>)}</dl>
          {usage.llm.unknown > 0 && <p className="fine-print">{number.format(usage.llm.unknown)} 次调用未取得用量，合计仅含已知用量。</p>}
        </section>
      </>}
  </section>;
}
