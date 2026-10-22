import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Cloud, Copy, LockKeyhole, Pencil, Trash2, X } from 'lucide-react';
import { ACTIONS, Action, AppState, busy, Capability, CAPABILITIES, defaultSettings, Language, LANGUAGES, manuscriptDate, MODIFIER_NAMES, Page, Settings, Shortcut, shortcutID, shortcutLabel, shortcutNeedsEventTap, STYLES, Term } from '../shared';
import { renderMarkdown } from './markdown';

const api = (action: string, args?: unknown) => window.yanmo.invoke(action, args) as Promise<{ ok: boolean; error?: string }>;
const logoURL = new URL('../../docs/design/logo-v2.png', import.meta.url).href;
const count = (text: string) => [...new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(text)].length;
const keycap = (key: Shortcut) => <kbd key={shortcutID(key)}>{shortcutLabel(key)}</kbd>;
const time = (value: number) => String(Math.floor(value / 60)).padStart(2, '0') + ':' + String(Math.floor(value % 60)).padStart(2, '0');
const numerals = '〇一二三四五六七八九';
const chineseDay = (day: number) => day <= 10 ? '初' + (day === 10 ? '十' : numerals[day]) : day < 20 ? '十' + numerals[day - 10] : day === 20 ? '二十' : day < 30 ? '廿' + numerals[day - 20] : day === 30 ? '三十' : '卅一';
const dateLabel = (value: number) => {
  const date = manuscriptDate(value), today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.round((today.getTime() - new Date(date).setHours(0, 0, 0, 0)) / 864e5);
  const clock = String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
  const month = date.getMonth() + 1;
  return (days === 0 ? '今天 ' : days === 1 ? '昨天 ' : (month <= 10 ? (month === 10 ? '十' : numerals[month]) : '十' + numerals[month - 10]) + '月' + chineseDay(date.getDate()) + ' · ') + clock;
};
const pageNames: Record<Page, [string, string]> = { desk: ['书案', '使用概览'], manuscripts: ['文稿', '每一次表达，都有迹可循'], dictionary: ['词库', '让熟悉的名字，准确落笔'], settings: ['设置', '本地模型与输入偏好'] };
function Dot({ ready, children }: { ready: boolean; children: ReactNode }) { return <span className="model-dot"><i className={ready ? 'ready' : ''} />{children}</span>; }
function BrandMark({ small = false }: { small?: boolean }) { return <img className={'brand-mark' + (small ? ' small' : '')} src={logoURL} alt="" aria-hidden="true" draggable={false}/>; }
function Mountains() {
  const ridges = [[.58,.42,.05,1.3],[.72,.34,.075,4.1],[.86,.24,.1,7.7]];
  return <svg className="mountains" viewBox="0 0 1000 260" preserveAspectRatio="none" aria-hidden="true"><defs><filter id="ink-mountain-blur"><feGaussianBlur stdDeviation="2.5"/></filter>{ridges.map(([base,height,opacity],index) => <linearGradient key={index} id={'mountain-'+index} x1="0" x2="0" y1={String(260*(base-height))} y2={String(260*Math.min(1,base+.12))} gradientUnits="userSpaceOnUse"><stop offset="0" stopColor="#292b26" stopOpacity={opacity}/><stop offset="1" stopColor="#292b26" stopOpacity="0"/></linearGradient>)}</defs>{ridges.map(([base,height,_opacity,seed], index) => {
    let path = 'M0,260';
    for(let x=0;x<=1000;x+=4) { const u=x/1000; const swell=(1-Math.abs(Math.sin(u*4.3+seed)))*.55+(1-Math.abs(Math.sin(u*9.7+seed*2.3)))*.28+Math.sin(u*29+seed)*.05-.35; const rise=Math.max(0,Math.min(1,(u-.15)/.55)); const peak=rise*rise*(3-2*rise); const top=260*(base-height*(.55+swell)); path+=' L'+x+','+(260+(top-260)*peak); }
    return <path key={index} d={path+' L1000,260Z'} fill={'url(#mountain-'+index+')'} filter="url(#ink-mountain-blur)"/>;
  })}</svg>;
}
function PaperFibers() {
  const ref=useRef<HTMLCanvasElement>(null);
  useEffect(() => { const canvas=ref.current!; const draw=()=>{const parent=canvas.parentElement!; const width=parent.clientWidth,height=parent.clientHeight,dpr=devicePixelRatio; canvas.width=width*dpr;canvas.height=height*dpr;const context=canvas.getContext('2d')!;context.scale(dpr,dpr);context.fillStyle='rgba(41,43,38,.035)';for(let i=0;i<900;i++)context.fillRect(((i*73+19)%997)/997*width,((i*131+47)%991)/991*height,.8,.8);};const observer=new ResizeObserver(draw);observer.observe(canvas.parentElement!);draw();return()=>observer.disconnect();},[]);
  return <canvas className="paper-fibers" ref={ref} aria-hidden="true"/>;
}

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const view = new URLSearchParams(location.search).get('view');
  useEffect(() => {
    let alive = true;
    const off = window.yanmo.subscribe(value => { if (alive) setState(value); });
    void window.yanmo.state().then(value => { if (alive && value) setState(value); });
    const visibility = () => { document.body.dataset.hidden = String(document.hidden); };
    document.addEventListener('visibilitychange', visibility); visibility();
    // A press leaves a drop of ink that spreads into the paper where the pointer touched.
    const blot = (event: PointerEvent) => {
      const target = (event.target as HTMLElement).closest('button:not(:disabled), summary');
      if (!target || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      const drop = document.createElement('i'); drop.className = 'ink-blot';
      drop.style.cssText = `left:${event.clientX}px;top:${event.clientY}px;color:${getComputedStyle(target).color};rotate:${Math.random() * 360}deg`;
      drop.addEventListener('animationend', () => drop.remove()); document.body.append(drop);
    };
    if (view !== 'overlay') document.addEventListener('pointerdown', blot);
    return () => { alive = false; off(); document.removeEventListener('visibilitychange', visibility); document.removeEventListener('pointerdown', blot); };
  }, []);
  if (view === 'overlay') { document.body.classList.add('overlay-body'); return state ? <Overlay state={state} /> : null; }
  if (!state) return <div className="starting"><BrandMark /><p>言墨正在准备<InkDrop/></p></div>;
  if (view === 'translation') return <Translation state={state} />;
  const guiding = !state.settings.onboarded;
  return <div className={'app-shell' + (guiding ? ' guiding' : '')}>
    <aside className="sidebar" inert={guiding}><PaperFibers/><div className="brand"><BrandMark /><div><h1>言墨</h1><span>YANMO</span><p className="brand-caption">语音输入</p></div></div>
      <nav aria-label="主导航"><i className="nav-ink" style={{ transform: `translateY(${Object.keys(pageNames).indexOf(state.page) * 57}px)` }}/>{(Object.keys(pageNames) as Page[]).map(page => <button key={page} aria-current={state.page === page ? 'page' : undefined} className={state.page === page ? 'selected' : ''} onClick={() => void api('page', page)}><span>{pageNames[page][0]}</span></button>)}</nav>
      <div className="sidebar-bottom"><Dot ready={state.models.metal}>本地运行</Dot><p>开源 · 私密 · 离线</p></div>
    </aside>
    {guiding ? <main>{modelsReady(state) ? <Onboarding state={state}/> : <ModelSetup state={state}/>}<Mountains /><PaperFibers /></main> : <main><header className="topbar"><span className="page-name">{pageNames[state.page][0]}</span><span className="slash">·</span><span>{pageNames[state.page][1]}</span>{state.settings.online.asr.enabled || state.settings.online.text.enabled ? <div className="privacy online"><Cloud size={12} />已开启在线处理</div> : <div className="privacy"><LockKeyhole size={12} />所有处理留在本机</div>}</header>
      <div className="page-content" key={state.page}>{state.page === 'desk' ? <Desk state={state} /> : state.page === 'manuscripts' ? <Manuscripts state={state} /> : state.page === 'dictionary' ? <Dictionary state={state} /> : <Preferences state={state} />}</div>
      {state.notice && <div className="notice" role="status"><span>{state.notice}</span><button className="icon-button" aria-label="关闭提示" onClick={() => void api('clearNotice')}><X size={13}/></button></div>}
      <footer className="footer"><Dot ready={state.settings.online.asr.enabled || (state.models.asr && state.models.sensevoice && state.models.metal)}>语音识别 · {state.settings.online.asr.enabled ? '在线' : state.models.asr && state.models.sensevoice && state.models.metal ? '本地就绪' : '待配置'}</Dot><span className="footer-divider"/><Dot ready={state.settings.online.text.enabled || (state.models.llm && state.models.metal)}>文字整理 · {state.settings.online.text.enabled ? '在线' : state.models.llm && state.models.metal ? '本地就绪' : '待配置'}</Dot><button className="footer-key" onClick={() => void api('page', 'settings')}>{state.settings.shortcuts.dictation[0] && keycap(state.settings.shortcuts.dictation[0])}<span>语音输入</span></button></footer>
      <Mountains /><PaperFibers />
    </main>}
  </div>;
}

const guideSteps: { action?: Action; name: string; title: string; caption: string; lines: (keys: string, target: string) => string[] }[] = [
  { action: 'dictation', name: '语音输入', title: '开口，即成文字。', caption: '在任何输入框里说话，言墨把它写下来。', lines: keys => ['把光标放进任意输入框', '按一下 ' + keys + ' 开始说话', '说完再按一次，文字写入光标处；Esc 取消'] },
  { action: 'selectionTranslation', name: '划词翻译', title: '选中，即见译文。', caption: '读到另一种语言，选中它就好。', lines: (keys, target) => ['在任意应用里选中一段文字', '按下 ' + keys, '译为' + target + '，结果出现在独立弹窗，原文不被改动'] },
  { action: 'voiceTranslation', name: '口述翻译', title: '说中文，写外文。', caption: '照常开口，写进输入框的是译文。', lines: (keys, target) => ['把光标放进输入框，按下 ' + keys + ' 说话', '浮层出现「译」字，表示这一次会翻译', '说完再按一次，' + target + '译文写入光标处'] },
  { name: '翻译弹窗', title: '译文，另起一页。', caption: '划词翻译的结果在独立弹窗里，不改动原文。', lines: () => ['在弹窗顶部切换目标语言，或重新翻译', '「排版 / 源码」切换 Markdown 显示', '复制译文后关闭，译文不会保存'] },
];
// First run downloads the local models before teaching shortcuts that would otherwise fail.
const modelsReady = (state: AppState) => state.modelsChecked && (state.settings.online.asr.enabled || (state.models.asr && state.models.sensevoice)) && (state.settings.online.text.enabled || state.models.llm);
function ModelSetup({ state }: { state: AppState }) {
  const { settings, models, checking, modelsChecked } = state;
  return <section className="guide"><header className="guide-top"><span>初次见面</span><button className="text-button" onClick={() => void api('settings', { onboarded: true }).then(result => { if (result.ok) void api('page', 'settings'); })}>跳过引导</button></header>
    <div className="guide-body"><div className="guide-text"><h2 className="brush-reveal">先备好笔墨。</h2><p className="guide-caption">言墨在本机识别与整理，第一次使用需要下载模型。</p>
      <ol><li>共约 5 GB，保存在用户全局缓存；已有完整缓存会直接复用</li><li>只有这一步需要联网，之后录音、识别和整理都在本机完成</li><li>准备完成后，进入快捷键引导</li></ol>
      <label className="inline-setting"><span>下载来源</span><select aria-label="模型下载来源" disabled={checking} value={settings.modelSource} onChange={event => void api('settings', { modelSource: event.target.value })}><option value="modelscope">ModelScope（默认）</option><option value="huggingface">Hugging Face</option></select></label>
      <button className="button primary" disabled={checking || !modelsChecked} onClick={() => void api('prepareModels')}>{!modelsChecked ? '正在检查本地缓存…' : checking ? '正在准备模型…' : '下载模型'}</button>
      {state.notice && <p className="fine-print" role="status">{state.notice}</p>}
    </div><figure className="guide-figure"><div className="model-check"><Dot ready={models.asr}>语音识别 · Qwen3-ASR</Dot><Dot ready={models.sensevoice}>中英复核 · SenseVoice</Dot><Dot ready={models.llm}>文字整理 · Qwen3-4B</Dot></div><figcaption>{modelsChecked ? '三项就绪后自动进入引导' : '正在检查全局缓存'}</figcaption></figure></div>
  </section>;
}
function Onboarding({ state }: { state: AppState }) {
  const [step, setStep] = useState(0), [notes, setNotes] = useState(''), [sample, setSample] = useState(guideSample);
  const { action, name, title, caption, lines } = guideSteps[step], settings = state.settings;
  const keys = action ? settings.shortcuts[action] : [];
  const target = LANGUAGES[action === 'voiceTranslation' ? settings.voiceTarget : settings.selectionTarget];
  const finish = (page: Page = 'desk') => void api('settings', { onboarded: true }).then(result => { if (result.ok) void api('page', page); });
  const last = step === guideSteps.length - 1;
  // Without Accessibility the event tap never sees FN, so macOS opens its own 🌐 emoji picker instead.
  const needsGrant = keys.some(shortcutNeedsEventTap) && !state.native.eventTap;
  return <section className="guide"><header className="guide-top"><span>初次见面</span><button className="text-button" onClick={() => finish()}>跳过引导</button></header>
    <nav className="guide-rail" aria-label="引导步骤">{guideSteps.map((item, index) => <button key={item.name} aria-current={index === step ? 'step' : undefined} onClick={() => setStep(index)}>{'一二三四'[index]}　{item.name}</button>)}</nav>
    <div className="guide-body" key={step}><div className="guide-text"><h2 className="brush-reveal">{action === 'voiceTranslation' && settings.voiceTarget === 'zh-Hans' ? '说外文，写中文。' : title}</h2><p className="guide-caption">{caption}</p>
      <ol>{lines(keys.length ? keys.map(shortcutLabel).join(' 或 ') : '快捷键', target).map(line => <li key={line}>{line}</li>)}</ol>
      {action ? keys.length ? <div className="key-list">{keys.map((key, index) => <span className="guide-key" key={shortcutID(key)}>{index > 0 && <em>或</em>}{keycap(key)}</span>)}</div> : <button className="text-button red" onClick={() => finish('settings')}>尚未设置快捷键，去设置 →</button>
        : <Dot ready>{settings.online.text.enabled ? '翻译使用你填写的在线服务' : '全程在本机翻译'}</Dot>}
      {needsGrant && <div className="permission-line guide-permission"><Dot ready={false}>辅助功能 · 待授权</Dot><button className="text-button red" onClick={event => { const { x, y, width, height } = event.currentTarget.getBoundingClientRect(); void api('permissions', { x, y, width, height }); }}>授予权限</button><button className="text-button" onClick={() => void api('check')}>重新检查</button><p className="fine-print">言墨需要辅助功能权限才能接收 {keys.map(shortcutLabel).join('、')}；未授权时按 FN 会打开系统表情面板。</p></div>}
    </div><figure className="guide-figure">{step === 3 ? <GuidePopup/> : <div className="guide-window"><i className="guide-lights" aria-hidden="true"/>
      <PracticeField key={step} select={step === 1} value={step === 1 ? sample : notes} onChange={step === 1 ? setSample : setNotes} placeholder={step === 1 ? '' : keys.length ? '光标已在这里。按 ' + shortcutLabel(keys[0]) + ' 说一句话试试，也可以直接打字。' : '可以直接在这里打字。'}/>
      {step !== 1 && !busy(state.stage) && <div className="voice-overlay guide-capsule" aria-hidden="true"><span className="overlay-cancel"><X size={13}/></span><BrushMeter level={.45}/>{step === 2 && <span className="translation-mark">译</span>}<time>00:04</time><span className="overlay-finish"><BrushCheck/></span></div>}
    </div>}<figcaption>{['试写区：说完的文字会写在这里', '已选好一句，按快捷键看译文', '「译」字提示这一次写入的是译文', '弹窗可移动，关闭即清除'][step]}</figcaption></figure></div>
    <footer className="guide-footer"><span>{step + 1} / {guideSteps.length}</span><button className="text-button" disabled={!step} onClick={() => setStep(step - 1)}>上一步</button><button className="button primary" onClick={() => last ? finish() : setStep(step + 1)}>{last ? '开始落笔' : '下一步'}</button></footer>
  </section>;
}
const guideSample = 'The reading group moves to Thursday. Please bring the draft notes and any open questions.';
/** A real field, so dictation and translation can be tried in place; step two starts with a phrase selected. */
function PracticeField({ value, onChange, placeholder, select }: { value: string; onChange: (value: string) => void; placeholder: string; select: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { const field = ref.current!; field.focus(); const start = field.value.indexOf('Please'); if (select && start >= 0) field.setSelectionRange(start, start + 'Please bring the draft notes'.length); else field.setSelectionRange(field.value.length, field.value.length); }, [select]);
  return <textarea ref={ref} className="guide-practice" aria-label="试写区" spellCheck={false} value={value} placeholder={placeholder} onChange={event => onChange(event.target.value)}/>;
}
/** Miniature of the selection translation popup; sample text is fictional. */
function GuidePopup() {
  return <div className="guide-window guide-popup" aria-hidden="true"><i className="guide-lights"/><header><BrandMark small/><div><strong>划词翻译</strong><p>读懂另一种表达</p></div></header><div className="guide-row"><span>译为 英语 ▾</span><span className="segmented"><b>排版</b><span>源码</span></span></div><div className="guide-row">▸ 原文 · 32 字</div><p className="guide-result">A quiet sentence crosses the page.<br/>Its meaning remains, in another tongue.</p><footer><span className="guide-seal">复制译文</span><span>关闭</span></footer></div>;
}

function Desk({ state }: { state: AppState }) {
  const items = state.library.manuscripts;
  const characters = items.reduce((sum, item) => sum + count(item.text), 0);
  const seconds = items.reduce((sum, item) => sum + item.seconds, 0);
  const timed = items.filter(item => item.seconds > 0);
  const timedCharacters = timed.reduce((sum, item) => sum + count(item.text), 0);
  const days = new Map<string, number>();
  for (const item of items) { const key = manuscriptDate(item.date).toDateString(); days.set(key, (days.get(key) || 0) + count(item.text)); }
  const stats = [['累计落笔', characters.toLocaleString(), '字'], ['音频时长', String(Math.floor(seconds < 60 ? seconds : seconds / 60)), seconds < 60 ? '秒' : '分钟'], ['平均口述速度', seconds ? String(Math.round(timedCharacters / seconds * 60)) : '—', '字 / 分钟'], ['活跃天数', String(days.size), '天']];
  return <div className="desk page-scroll"><section className="desk-heading"><h2 className="brush-reveal">言语之间，自有笔墨。</h2><p>让表达回到自然，让文字留有余地。</p></section>
    <div className="desk-columns"><section className="usage"><h3>表达概览</h3><div className="stats">{stats.map(([name, value, unit], index) => <div className="stat ink-in" key={name} style={{ animationDelay: (index * .08) + 's' }}><div><strong className="ink-in" key={value}>{value}</strong><span>{unit}</span></div><p>{name}</p></div>)}</div><hr/><Calendar days={days}/><p className="fine-print">按本机保留的文稿统计，包含导入音频。</p></section>
      <section className="anywhere"><h3>随处落笔</h3><p>在任意输入框按下快捷键，<br/>说完后再按一次。</p><div className="key-list">{state.settings.shortcuts.dictation.map(keycap)}</div>{(['voiceTranslation', 'selectionTranslation'] as Action[]).map(action => <div className="action-keys" key={action}><span>{ACTIONS[action]}</span><div className="key-list">{state.settings.shortcuts[action].map(keycap)}</div></div>)}<p>Esc 取消本次输入</p><button className="text-button" onClick={() => void api('page', 'settings')}>自定义快捷键 →</button><hr/><button className="button" disabled={busy(state.stage) || state.checking} onClick={() => void api('import')}>导入一段录音</button><p className="fine-print">已有录音，也可在本机整理。</p></section>
    </div><hr/><section className="recent"><header><h3>最近文稿</h3><button className="text-button" onClick={() => void api('page', 'manuscripts')}>查看全部 →</button></header>{items.length ? items.slice(0, 3).map(item => <button className="recent-row" key={item.id} disabled={busy(state.stage)} onClick={() => void api('select', item.id)}><span>{item.text}</span><time>{dateLabel(item.date)}</time></button>) : <p className="empty-line">第一段文字，从开口开始。</p>}</section>
  </div>;
}
function Calendar({ days }: { days: Map<string, number> }) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const start = new Date(today); start.setDate(start.getDate() - ((start.getDay() + 6) % 7) - 19 * 7);
  return <div className="activity-calendar"><header><h4>落笔日历</h4><span>近 20 周</span></header><div className="calendar-grid"><div className="week-labels">{['一', '', '三', '', '五', '', '日'].map((name, index) => <span key={index}>{name}</span>)}</div>{Array.from({ length: 20 }, (_, week) => <div className="calendar-week" key={week}>{Array.from({ length: 7 }, (_, day) => { const date = new Date(start); date.setDate(start.getDate() + week * 7 + day); const amount = days.get(date.toDateString()) || 0; const alpha = date > today ? .025 : amount === 0 ? .06 : amount < 100 ? .2 : amount < 500 ? .4 : .65; return <span key={day} className="calendar-day ink-in" title={date.toLocaleDateString() + ' · ' + amount + ' 字'} style={{ backgroundColor: 'rgba(41,43,38,' + alpha + ')', animationDelay: (.1 + week * .03 + day * .012) + 's' }}/>; })}</div>)}</div><div className="calendar-legend"><span>淡</span>{[.06, .2, .4, .65].map(alpha => <i key={alpha} style={{ opacity: alpha }}/>) }<span>浓</span></div></div>;
}

function Manuscripts({ state }: { state: AppState }) {
  const [search, setSearch] = useState('');
  const disabled = busy(state.stage);
  const items = state.library.manuscripts.filter(item => item.text.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const note = state.library.manuscripts.find(item => item.id === state.selectedID)?.deliveryNote;
  return <section className="manuscripts"><div className="section-heading"><h2>每一笔，都在这里。</h2><button className="button primary" disabled={disabled} onClick={() => void api('import')}>导入音频</button></div><div className="manuscript-columns"><aside className="manuscript-list"><input aria-label="搜索文稿" placeholder="搜索文稿" value={search} onChange={event => setSearch(event.target.value)}/><div className="list-scroll">{items.map(item => <div className={'manuscript-item ' + (item.id === state.selectedID ? 'selected' : '')} key={item.id}><button className="manuscript-select" disabled={disabled} onClick={() => void api('select', item.id)}><span>{item.text}</span><footer><time>{dateLabel(item.date)}</time><span>{count(item.text)} 字</span></footer></button><button className="item-delete icon-button" aria-label="删除文稿" disabled={disabled} onClick={() => void api('deleteManuscript', item.id)}><Trash2 size={12}/></button></div>)}{!items.length && <p className="list-empty">{search ? '没有找到匹配的文稿' : '暂无保存的文稿'}</p>}</div></aside><div className="manuscript-editor"><header><h3>{state.selectedID ? '文稿正文' : '当前文稿'}</h3><span>{count(state.draft)} 字</span></header>{note && <p className={'delivery-note ' + (note.startsWith('未') ? 'red' : '')}>{note}</p>}{state.draft ? <><textarea className="ink-in" key={state.selectedID} aria-label="文稿正文" value={state.draft} disabled={disabled} onChange={event => void api('draft', { id: state.selectedID, text: event.target.value })}/><details className="original"><summary>识别原文{state.asrResults.length > 1 ? ' · 两路对照' : ''}</summary>{state.asrResults.length > 1 ? state.asrResults.map((result, index) => <article key={index}><h4>{result.engine_name} · {result.language === 'Chinese' ? '中文' : result.language === 'English' ? '英语' : result.language}</h4><p>{result.transcript}</p></article>) : <p>{state.original}</p>}</details><div className="editor-actions"><button className="button primary" onClick={() => void api('copyDraft')}>复制正文</button><button className="button" disabled={disabled} onClick={() => void api('polish')}>{state.stage === 'polishing' ? '正在整理…' : '本地整理'}</button><button className="text-button export" disabled={disabled} aria-label="导出为文本" onClick={() => void api('export')}>导出</button></div></> : <div className="empty-state"><p>把刚才的想法，写下来。</p></div>}</div></div></section>;
}

function Dictionary({ state }: { state: AppState }) {
  const [term, setTerm] = useState(''), [hint, setHint] = useState(''), [aliases, setAliases] = useState(''), [search, setSearch] = useState(''), [editing, setEditing] = useState<string>();
  const reset = () => { setTerm(''); setHint(''); setAliases(''); setEditing(undefined); };
  const edit = (item: Term) => { setTerm(item.term); setHint(item.hint); setAliases((item.aliases || []).join('，')); setEditing(item.id); };
  return <section className="dictionary"><h2>名字，值得写对。</h2><p className="intro">把常用的人名、产品名和专业词交给言墨，在本地整理时辅助校对。</p><fieldset disabled={busy(state.stage)}><form onSubmit={event => { event.preventDefault(); void api('termSave', { id: editing, term, hint, aliases: aliases.split(/[,，、]/) }).then(result => { if (result.ok) reset(); }); }}><div className="term-form"><input aria-label="词语" placeholder="词语，例如：言墨" value={term} onChange={event => setTerm(event.target.value)}/><input aria-label="备注" placeholder="备注（可选）" value={hint} onChange={event => setHint(event.target.value)}/><button className="button primary" disabled={!term.trim()}>{editing ? '保存词条' : '加入词库'}</button></div><div className="alias-form"><input aria-label="常见误识别" placeholder="常见误识别（可选，多个用逗号分隔）" value={aliases} onChange={event => setAliases(event.target.value)}/>{editing && <button type="button" className="text-button" onClick={reset}>取消编辑</button>}</div></form><hr/><header className="dictionary-header"><h3>全部词语 · {state.library.lexicon.length}</h3><input aria-label="搜索词语" placeholder="搜索词语" value={search} onChange={event => setSearch(event.target.value)}/></header><div className="term-list">{state.library.lexicon.filter(item => item.term.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map(item => <article className="term-card" key={item.id}><div><h3>{item.term}</h3>{item.hint && <p>{item.hint}</p>}{!!item.aliases?.length && <p className="red">纠正：{item.aliases.join('、')}</p>}</div><button className="icon-button" aria-label={'编辑' + item.term} onClick={() => edit(item)}><Pencil size={13}/></button><button className="icon-button" aria-label={'移除' + item.term} onClick={() => void api('termRemove', item.id)}><X size={13}/></button></article>)}</div>{!state.library.lexicon.length && <div className="empty-state"><p>从一个熟悉的名字开始。</p></div>}</fieldset><p className="dictionary-note">词语与备注辅助消歧；你明确填写的常见误识别会按原文匹配纠正。识别原文始终保留。</p></section>;
}

const ASR_PRESETS = [
  { id: 'mlx-community/Qwen3-ASR-1.7B-8bit', label: '标准 · Qwen3-ASR 1.7B（默认）', note: '下载约 2.5 GB，运行时约占 3.5 GB 内存，识别最准。' },
  { id: 'mlx-community/Qwen3-ASR-0.6B-8bit', label: '低内存 · Qwen3-ASR 0.6B', note: '下载约 1 GB，运行时约占 1.8 GB 内存；嘈杂环境和英文、日文等外语的准确率明显较低。' },
];
function AsrPreset({ state }: { state: AppState }) {
  const preset = ASR_PRESETS.find(item => item.id === state.settings.asrModel);
  return <><label className="inline-setting"><span>语音识别规格</span><select aria-label="语音识别规格" disabled={state.checking} value={preset?.id ?? ''} onChange={event => void api('settings', { asrModel: event.target.value }).then(result => { if (result.ok) void api('check'); })}>
    {ASR_PRESETS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}{!preset && <option value="">自定义</option>}</select></label>
    <p className="fine-print">{preset ? preset.note : '使用下方填写的模型 ID。'}切换后若显示待准备，请点击「准备模型」。</p></>;
}
function Field({ title, value, name }: { title: string; value: string; name: 'asrModel' | 'llmModel' | 'senseVoiceModel' }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return <label className="model-field"><span>{title}</span><input value={text} onChange={event => setText(event.target.value)} onBlur={() => { if (text !== value) void api('settings', { [name]: text.trim() }); }} /></label>;
}
function OnlineSetting({ capability, state }: { capability: Capability; state: AppState }) {
  const saved = state.settings.online[capability];
  const [baseURL, setBaseURL] = useState(saved.baseURL), [model, setModel] = useState(saved.model), [key, setKey] = useState('');
  useEffect(() => { setBaseURL(saved.baseURL); setModel(saved.model); }, [saved.baseURL, saved.model]);
  const save = (enabled: boolean) => void api('online', { capability, enabled, baseURL, model, key }).then(result => { if (result.ok) setKey(''); });
  const complete = !!baseURL.trim() && !!model.trim();
  return <div className="online-setting"><header><strong>{CAPABILITIES[capability]}</strong><Dot ready={saved.enabled}>{saved.enabled ? '在线' : '本机'}</Dot></header>
    <label className="model-field"><span>服务地址（Base URL）</span><input value={baseURL} placeholder="https://api.example.com/v1" spellCheck={false} onChange={event => setBaseURL(event.target.value)}/></label>
    <label className="model-field"><span>模型 ID</span><input value={model} placeholder={capability === 'asr' ? '例如 whisper-1' : '例如 qwen-plus'} spellCheck={false} onChange={event => setModel(event.target.value)}/></label>
    <label className="model-field"><span>API Key</span><input type="password" value={key} autoComplete="off" placeholder={state.onlineKeys[capability] ? '已保存在钥匙串；输入新值可替换' : '本机服务可留空'} onChange={event => setKey(event.target.value)}/></label>
    <div className="online-actions">{saved.enabled ? <><button className="button compact" onClick={() => save(true)}>保存</button><button className="button compact" onClick={() => save(false)}>改回本机处理</button></> : <><button className="button compact primary" disabled={!complete} onClick={() => save(true)}>启用在线{CAPABILITIES[capability]}</button><button className="text-button" onClick={() => save(false)}>仅保存</button></>}{state.onlineKeys[capability] && <button className="text-button" onClick={() => void api('onlineKeyClear', capability)}>删除 API Key</button>}</div>
  </div>;
}
function CheckSetting({ title, checked, onChange }: { title: string; checked: boolean; onChange: (value: boolean) => void }) { return <label className="check-setting"><input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)}/><span>{title}</span></label>; }
function PreferenceSection({ title, children }: { title: string; children: ReactNode }) { return <section className="preference-section"><h3>{title}</h3>{children}</section>; }
function LanguageSelect({ value, onChange, disabled = false }: { value: Language; onChange: (language: Language) => void; disabled?: boolean }) { return <label className="language-label"><span>译为</span><select aria-label="目标语言" value={value} disabled={disabled} onChange={event => onChange(event.target.value as Language)}>{Object.entries(LANGUAGES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>; }

function Preferences({ state }: { state: AppState }) {
  const settings = state.settings;
  const patch = (value: Partial<Settings>) => void api('settings', value);
  return <div className="preferences page-scroll"><h2>让言墨，顺手一些。</h2><fieldset disabled={busy(state.stage)}>
    <PreferenceSection title="快捷键与翻译">{(Object.keys(ACTIONS) as Action[]).map(action => <div className="shortcut-editor" key={action}><header><strong>{ACTIONS[action]}</strong>{action !== 'dictation' && <LanguageSelect value={action === 'voiceTranslation' ? settings.voiceTarget : settings.selectionTarget} onChange={language => patch(action === 'voiceTranslation' ? { voiceTarget: language } : { selectionTarget: language })}/>}</header><p>{action === 'dictation' ? '轻按开始，再按结束；Esc 取消。' : action === 'voiceTranslation' ? '说完后翻译成目标语言，并粘贴到原输入框。' : '选中文字后按快捷键，在独立弹窗查看译文。'}</p>{settings.shortcuts[action].map(key => <div className="shortcut-row" key={shortcutID(key)}>{keycap(key)}<span className="spacer"/>{shortcutNeedsEventTap(key) && <Dot ready={state.native.eventTap}>{state.native.eventTap ? '已启用' : '待授权'}</Dot>}<button className="text-button" disabled={!!state.captureAction || (action === 'dictation' && settings.shortcuts[action].length === 1)} onClick={() => void api('shortcutRemove', { action, id: shortcutID(key) })}>移除</button></div>)}{state.captureAction === action ? <ShortcutCapture state={state}/> : <div className="shortcut-actions"><button className="button compact" disabled={!!state.captureAction} onClick={() => void api('capture', action)}>添加快捷键</button><button className="text-button" disabled={!!state.captureAction} onClick={() => patch({ shortcuts: { ...settings.shortcuts, [action]: defaultSettings().shortcuts[action] } })}>恢复默认</button></div>}</div>)}{state.shortcutNotice && <p className="red" role="status">{state.shortcutNotice}</p>}<div className="permission-line"><Dot ready={state.native.accessibility}>辅助功能 · {state.native.accessibility ? '已授权' : '待授权'}</Dot><button className="text-button red" onClick={event => { const { x, y, width, height } = event.currentTarget.getBoundingClientRect(); void api('permissions', { x, y, width, height }); }}>请求权限</button><button className="text-button" onClick={() => void api('check')}>重新检查权限</button></div></PreferenceSection>
    <PreferenceSection title="麦克风"><label className="inline-setting"><span>输入设备</span><select aria-label="输入设备" value={settings.microphone} onChange={event => patch({ microphone: event.target.value })}><option value="">跟随系统</option>{state.native.devices.map(device => <option key={device.id} value={device.id}>{device.name}</option>)}</select></label><p className="fine-print">仅选择言墨使用的输入设备，不更改系统默认麦克风。录音无提示音，不回放麦克风声音。</p></PreferenceSection>
    <PreferenceSection title="本地模型"><label className="inline-setting"><span>模型下载来源</span><select aria-label="模型下载来源" value={settings.modelSource} onChange={event => patch({ modelSource: event.target.value as Settings['modelSource'] })}><option value="modelscope">ModelScope（默认）</option><option value="huggingface">Hugging Face</option></select></label><AsrPreset state={state}/><Field title="语音识别模型" name="asrModel" value={settings.asrModel}/><Field title="中英复核模型" name="senseVoiceModel" value={settings.senseVoiceModel}/><p className="fine-print">自动识别为中文或英文后，使用 SenseVoice Small 再识别一次；同一模型按语言调用，两路原文用于整理对照。</p><Field title="文字整理与翻译模型" name="llmModel" value={settings.llmModel}/><p className="fine-print">模型保存在用户全局缓存，录音和文字在本机处理。空闲 1 小时后释放模型，下次录音时后台准备。</p><button className="button compact prepare-models" disabled={state.checking} onClick={() => void api('prepareModels')}>准备模型</button><div className="model-check"><Dot ready={state.models.asr}>ASR 缓存{state.models.asr ? '完整' : '待准备'}</Dot><Dot ready={state.models.sensevoice}>中英复核缓存{state.models.sensevoice ? '完整' : '待准备'}</Dot><Dot ready={state.models.llm}>LLM 缓存{state.models.llm ? '完整' : '待准备'}</Dot><button className="button compact" disabled={state.checking} onClick={() => void api('check')}>{state.checking ? '正在检查…' : '检查本地环境'}</button></div></PreferenceSection>
    <PreferenceSection title="在线模型（可选）"><p className="fine-print">默认全部在本机处理。启用后，对应环节会把录音或文字发送到你填写的 OpenAI 兼容服务；API Key 加密保存在 macOS 钥匙串，界面不再显示。</p>{(Object.keys(CAPABILITIES) as Capability[]).map(capability => <OnlineSetting key={capability} capability={capability} state={state}/>)}</PreferenceSection>
    <PreferenceSection title="文字与隐私"><CheckSetting title="识别后整理语气与标点（纠错仍启用）" checked={settings.polishEnabled} onChange={value => patch({ polishEnabled: value })}/><label className="inline-setting"><span>整理风格</span><select aria-label="整理风格" value={settings.style} onChange={event => patch({ style: event.target.value })}>{STYLES.map(style => <option key={style}>{style}</option>)}</select></label><CheckSetting title="读取输入框光标前后各最多 300 字，辅助识别与纠错" checked={settings.readContext} onChange={value => patch({ readContext: value })}/><CheckSetting title="在本机保存新文稿" checked={settings.keepHistory} onChange={value => patch({ keepHistory: value })}/><label className="inline-setting"><span>文稿保留时间</span><select aria-label="文稿保留时间" value={settings.retention} onChange={event => patch({ retention: Number(event.target.value) })}>{[[0, '一直保留'], [1, '24 小时'], [7, '7 天'], [30, '30 天'], [365, '1 年']].map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><p className="fine-print">录音处理结束后删除临时音频。关闭保存不删除已有文稿；已有内容可在文稿页逐条删除。词库和设置始终仅保存在本机。</p></PreferenceSection>
    <PreferenceSection title="启动"><CheckSetting title="登录时启动言墨" checked={state.launchAtLogin} onChange={value => void api('login', value)}/><CheckSetting title="主窗口打开时在程序坞中显示言墨" checked={settings.showDock} onChange={value => patch({ showDock: value })}/><p className="fine-print">关闭主窗口后只保留顶部菜单栏，快捷键继续可用；从菜单栏可以重新打开或退出言墨。</p><button className="text-button" onClick={() => patch({ onboarded: false })}>重新查看引导 →</button></PreferenceSection>
  </fieldset><p className="version">言墨 0.4.0 · MIT 开源 · 为中文表达留一方清静之地</p></div>;
}

function ShortcutCapture({ state }: { state: AppState }) {
  const [preview, setPreview] = useState('请按下一组快捷键，松开保存；Esc 取消…');
  useEffect(() => {
    if (state.native.eventTap) return;
    const held = new Set<number>(), candidate = new Set<number>(); let invalid = false;
    const modifiers: Record<string, number> = { ControlLeft: 59, ControlRight: 62, ShiftLeft: 56, ShiftRight: 60, AltLeft: 58, AltRight: 61, MetaLeft: 55, MetaRight: 54 };
    const codes: Record<string, number> = { KeyA: 0, KeyS: 1, KeyD: 2, KeyF: 3, KeyH: 4, KeyG: 5, KeyZ: 6, KeyX: 7, KeyC: 8, KeyV: 9, KeyB: 11, KeyQ: 12, KeyW: 13, KeyE: 14, KeyR: 15, KeyY: 16, KeyT: 17, Digit1: 18, Digit2: 19, Digit3: 20, Digit4: 21, Digit6: 22, Digit5: 23, Equal: 24, Digit9: 25, Digit7: 26, Minus: 27, Digit8: 28, Digit0: 29, BracketRight: 30, KeyO: 31, KeyU: 32, BracketLeft: 33, KeyI: 34, KeyP: 35, KeyL: 37, KeyJ: 38, Quote: 39, KeyK: 40, Semicolon: 41, Backslash: 42, Comma: 43, Slash: 44, KeyN: 45, KeyM: 46, Period: 47, Space: 49, Backquote: 50, F1: 122, F2: 120, F3: 99, F4: 118, F5: 96, F6: 97, F7: 98, F8: 100, F9: 101, F10: 109, F11: 103, F12: 111 };
    const down = (event: KeyboardEvent) => {
      event.preventDefault(); if (event.repeat) return;
      const modifier = modifiers[event.code];
      if (modifier) { if (!held.size) { candidate.clear(); invalid = false; } held.add(modifier); candidate.add(modifier); setPreview([...candidate].map(code => MODIFIER_NAMES[code]).join(' + ') + '，松开保存'); return; }
      invalid = true;
      if (event.code === 'Escape') { void api('captureEnd'); return; }
      const code = codes[event.code];
      if (code !== undefined) void api('captureSave', { keyCode: code, modifiers: (event.ctrlKey ? 4096 : 0) | (event.altKey ? 2048 : 0) | (event.shiftKey ? 512 : 0) | (event.metaKey ? 256 : 0), keyLabel: event.code === 'Space' ? 'Space' : event.key.toUpperCase() });
    };
    const up = (event: KeyboardEvent) => { const code = modifiers[event.code]; if (!code || !held.delete(code)) return; if (!held.size && !invalid) void api('captureSave', { keyCode: 0, modifiers: 0, keyLabel: [...candidate].sort((a, b) => a - b).map(key => MODIFIER_NAMES[key]).join(' + '), modifierKeys: [...candidate].sort((a, b) => a - b) }); };
    const mouse = () => { invalid = true; };
    document.addEventListener('keydown', down, true); document.addEventListener('keyup', up, true); document.addEventListener('mousedown', mouse, true);
    return () => { document.removeEventListener('keydown', down, true); document.removeEventListener('keyup', up, true); document.removeEventListener('mousedown', mouse, true); };
  }, [state.native.eventTap]);
  return <div className="shortcut-capture" role="status"><span>{preview}</span><button className="text-button" onClick={() => void api('captureEnd')}>取消录制</button></div>;
}

function Overlay({ state }: { state: AppState }) {
  // Keep the last visible state while fading out, and replay the upward entrance on every new input.
  const shown = state.overlayVisible && state.stage !== 'idle' && state.action !== 'selectionTranslation';
  const last = useRef<AppState | null>(null), wasShown = useRef(false), entry = useRef(0);
  if (shown && !wasShown.current) entry.current += 1;
  wasShown.current = shown;
  if (shown) last.current = state;
  const view = last.current;
  if (!view) return null;
  const names: Record<string, string> = { preparing: '准备中…', transcribing: '识别中…', reviewing: '中英复核…', polishing: '整理中…', translating: '翻译中…', inserting: '写入中…' };
  const phase = view.stage === 'recording' || view.stage === 'success' || view.stage === 'failure' ? view.stage : 'busy';
  return <div className="overlay-shell"><div key={entry.current} className={'voice-overlay' + (shown ? '' : ' leaving')} title={ACTIONS[view.action] + ' · 完成后写入当前输入位置；Esc 取消'} aria-label="完成后写入当前输入位置"><div className="overlay-phase" key={phase}>
    {phase === 'success' ? <span className="overlay-result"><BrushCheck/>已写入</span>
      : phase === 'failure' ? (view.seconds > 0 && view.draft
        ? <button className="overlay-failure" onClick={() => void api('revealDraft')}>未完成 · 查看文稿</button>
        : <span className="overlay-failure" role="alert" title={view.notice} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'center' }}>{view.notice || '无法开始录音'}</span>)
      : <><button className="overlay-cancel" aria-label="取消语音输入" onClick={() => void api('cancel')}><X size={13}/></button>
        {phase === 'recording' ? <><BrushMeter level={view.level}/>{view.action === 'voiceTranslation' && <span className="translation-mark">译</span>}<time>{time(view.seconds)}</time><button className="overlay-finish" aria-label="结束录音并写入" onClick={() => void api('finish')}><BrushCheck/></button></>
          : <><span className="overlay-stage" key={view.stage}>{names[view.stage]}</span><InkDrop/></>}</>}
  </div></div></div>;
}
/** A check written as one brush stroke, drawn centred on a 26px circle. */
function BrushCheck() { return <svg className="brush-check" viewBox="0 0 26 26" aria-hidden="true"><path pathLength={1} d="M8.2 13.6Q10.1 14.7 11.6 16.8Q13.7 11.8 17.8 9.2"/></svg>; }
/** Dry-brush ink: a wash body under overlapping bristle strands. Loudness is brush pressure; ink scrolls
 *  left as it is laid down, pales as it dries, and breaks into 飞白 where the brush runs thin. */
function BrushMeter({ level }: { level: number }) {
  const canvas = useRef<HTMLCanvasElement>(null), target = useRef(level);
  target.current = level;
  useEffect(() => {
    const element = canvas.current!, context = element.getContext('2d')!;
    const count = 30, bristles = 17, tick = 50, ink = '246,243,236';
    const hairs = Array.from({ length: bristles }, (_, k) => ({ side: k / (bristles - 1) * 2 - 1 + (Math.random() - .5) * .12, width: .25 + Math.random() * .55, alpha: .3 + Math.random() * .5 }));
    // Each sample carries its own grain, so breaks and wobble travel with the ink instead of flickering.
    const grain = () => Array.from({ length: bristles + 1 }, Math.random);
    const values: number[] = Array(count).fill(0), grains = Array.from({ length: count }, grain);
    let smooth = 0, last = performance.now(), shifted = last, frame = 0;
    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      smooth += (target.current - smooth) * (1 - Math.exp(-(now - last) / 60)); last = now;
      if (now - shifted > tick * count) shifted = now;
      while (now - shifted >= tick) { values.shift(); values.push(smooth); grains.shift(); grains.push(grain()); shifted += tick; }
      const ratio = devicePixelRatio, width = element.clientWidth, height = element.clientHeight;
      if (element.width !== Math.round(width * ratio) || element.height !== Math.round(height * ratio)) { element.width = Math.round(width * ratio); element.height = Math.round(height * ratio); }
      context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, width, height);
      const step = width / (count - 3), offset = (now - shifted) / tick * step, mid = height / 2;
      const points = values.map((value, index) => {
        const x = index * step - offset, u = Math.min(1, Math.max(0, x / width)), pressure = Math.min(1, value * 1.15);
        // The left end trails off dry; the right end is the brush head, blunt and wet.
        const tail = Math.min(1, u / .35), head = u > .88 ? Math.sqrt(Math.max(0, 1 - ((u - .88) / .12) ** 2)) : 1;
        const shape = (.25 + .75 * tail * tail * (3 - 2 * tail)) * Math.max(.12, head);
        return { x, u, pressure, half: (.6 + pressure * mid * .8) * shape, wobble: (grains[index][bristles] - .5) * (.3 + pressure * 1.6) };
      });
      // Wash: two slightly offset soft layers, denser where the ink is fresh.
      const wash = context.createLinearGradient(0, 0, width, 0);
      wash.addColorStop(0, `rgba(${ink},.03)`); wash.addColorStop(.75, `rgba(${ink},.16)`); wash.addColorStop(1, `rgba(${ink},.22)`);
      context.fillStyle = wash; context.filter = 'blur(.7px)';
      for (const shift of [-.4, .5]) {
        context.beginPath();
        points.forEach((point, index) => { const y = mid + point.wobble + shift - point.half * .85; if (index) context.quadraticCurveTo(points[index - 1].x, mid + points[index - 1].wobble + shift - points[index - 1].half * .85, (point.x + points[index - 1].x) / 2, y); else context.moveTo(point.x, y); });
        for (let index = count - 1; index >= 0; index--) { const point = points[index]; context.lineTo(point.x, mid + point.wobble + shift + point.half * .85); }
        context.fill();
      }
      // Bristles: each strand follows its own line across the stroke and lifts off the paper where the brush is dry.
      context.filter = 'none'; context.strokeStyle = `rgb(${ink})`; context.lineCap = 'round';
      hairs.forEach((hair, k) => {
        context.lineWidth = hair.width;
        const y = (index: number) => mid + points[index].wobble + hair.side * points[index].half;
        // Neighbouring grain is averaged so the brush lifts for a run of samples, not in single dashes.
        const inked = (index: number) => (grains[index][k] + grains[Math.max(0, index - 1)][k] + grains[Math.min(count - 1, index + 1)][k]) / 3
          > .22 + .45 * (1 - points[index].pressure) * Math.abs(hair.side) ** 1.5 + .28 * (1 - points[index].u);
        for (let index = 0; index < count;) {
          if (!inked(index)) { index++; continue; }
          let end = index; while (end + 1 < count && inked(end + 1)) end++;
          if (end > index) {
            context.globalAlpha = hair.alpha * Math.min(1, points[end].u * 1.3);
            context.beginPath(); context.moveTo(points[index].x, y(index));
            for (let next = index + 1; next <= end; next++) context.quadraticCurveTo(points[next - 1].x, y(next - 1), (points[next - 1].x + points[next].x) / 2, (y(next - 1) + y(next)) / 2);
            context.lineTo(points[end].x, y(end)); context.stroke();
          }
          index = end + 1;
        }
      });
      context.globalAlpha = 1;
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);
  return <canvas className="meter" ref={canvas} role="img" aria-label="麦克风音量"/>;
}
function InkDrop() { return <span className="ink-drop" aria-label="正在处理"><i/><i/><i/></span>; }
function Translation({ state }: { state: AppState }) {
  const value = state.translation;
  const [sourceMode, setSourceMode] = useState(false), [copied, setCopied] = useState(false);
  const markdown = useMemo(() => renderMarkdown(value.result), [value.result]);
  useEffect(() => { setCopied(false); }, [value.result]);
  return <div className="translation-window"><div className="translation-titlebar" aria-hidden="true"/><header className="translation-heading"><BrandMark small/><div><h2>划词翻译</h2><p>读懂另一种表达</p></div><span className="spacer"/><span className="local-label"><LockKeyhole size={12}/>本地翻译</span></header><div className="translation-controls"><LanguageSelect value={value.language} disabled={value.loading} onChange={language => void api('translationRetry', language)}/><button className="text-button" disabled={value.loading || !value.source} onClick={() => void api('translationRetry', value.language)}>重新翻译</button><span className="spacer"/><div className="segmented"><button aria-pressed={!sourceMode} onClick={() => setSourceMode(false)}>排版</button><button aria-pressed={sourceMode} onClick={() => setSourceMode(true)}>源码</button></div></div><details className="translation-source"><summary>原文 <span>{count(value.source)} 字</span></summary><pre>{value.source}</pre></details><div className="translation-result">{value.loading ? <div className="translation-loading"><InkDrop/><span>正在翻译…</span></div> : value.error ? <div className="translation-error ink-in" role="alert">{value.error}</div> : sourceMode ? <pre className="markdown-source ink-in">{value.result}</pre> : <div className="markdown" onClick={event => { const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-copy-code]'); if (button) { const code = markdown.codes[Number(button.dataset.copyCode)]; if (code !== undefined) void api('copyText', code).then(() => { button.textContent = '已复制'; setTimeout(() => { button.textContent = '复制代码'; }, 1500); }); } }} dangerouslySetInnerHTML={{ __html: markdown.html }}/>}</div><footer className="translation-footer"><span>译文仅供本次查看，关闭后清除。</span><button className="button primary" disabled={!value.result || value.loading} onClick={() => void api('copyText', value.result).then(() => setCopied(true))}><Copy size={14}/><span className="ink-in" key={String(copied)}>{copied ? '已复制' : '复制译文'}</span></button><button className="button" onClick={() => void api('translationClose')}>关闭</button></footer></div>;
}
