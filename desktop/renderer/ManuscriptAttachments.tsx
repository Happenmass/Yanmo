import { useEffect, useRef, useState } from 'react';
import { Maximize2, Pause, Play, X } from 'lucide-react';

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

export function ManuscriptAttachments({ id }: { id: string }) {
  const [urls, setURLs] = useState<{ audio?: string; screenshot?: string }>({});
  const [failed, setFailed] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const created: string[] = [];
    let active = true;
    function createURL(data: Uint8Array, type = '') {
      const url = URL.createObjectURL(new Blob([new Uint8Array(data)], { type }));
      created.push(url);
      return url;
    }
    window.yanmo.manuscriptAttachments(id).then(({ audio, screenshot }) => {
      if (!active) return;
      setURLs({
        audio: audio && createURL(audio, 'audio/ogg'),
        screenshot: screenshot && createURL(screenshot),
      });
    }).catch(() => { if (active) setFailed(true); });
    return () => {
      active = false;
      created.forEach(URL.revokeObjectURL);
    };
  }, [id]);

  if (failed) return <p className="delivery-note red" role="status">文稿附件无法读取。</p>;
  if (!urls.audio && !urls.screenshot) return null;
  return (
    <section className="manuscript-attachments" aria-label="文稿附件">
      <h4>文稿附件</h4>
      <div className="manuscript-media">
        {urls.audio && <AudioPreview url={urls.audio}/>}
        {urls.screenshot && <>
          <button type="button" className="screenshot-preview" onClick={() => dialog.current?.showModal()} aria-label="放大录音结束截屏">
            <span className="screenshot-thumbnail">
              <img src={urls.screenshot} alt="录音结束时的屏幕缩略图"/>
              <Maximize2 size={13} aria-hidden="true"/>
            </span>
            <span>录音结束截屏</span>
          </button>
          <dialog ref={dialog} className="screenshot-dialog" aria-label="录音结束截屏"
            onClick={event => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
            <header>
              <h4>录音结束截屏</h4>
              <button type="button" className="icon-button" aria-label="关闭截屏预览" onClick={() => dialog.current?.close()}>
                <X size={18}/>
              </button>
            </header>
            <img src={urls.screenshot} alt="录音结束时的屏幕"/>
          </dialog>
        </>}
      </div>
    </section>
  );
}

function AudioPreview({ url }: { url: string }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [position, setPosition] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const element = audio.current;
    return () => { if (element) element.pause(); };
  }, []);

  async function togglePlayback() {
    const element = audio.current;
    if (!element) return;
    if (!element.paused) element.pause();
    else {
      try { await element.play(); }
      catch (error) { if (!(error instanceof DOMException && error.name === 'AbortError')) setFailed(true); }
    }
  }

  return (
    <div className="recording-preview">
      <audio ref={audio} src={url} preload="metadata"
        onDurationChange={event => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)}
        onTimeUpdate={event => setPosition(event.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)}
        onError={() => setFailed(true)}/>
      <button type="button" className="recording-toggle" disabled={failed} aria-label={playing ? '暂停录音' : '播放录音'}
        onClick={() => void togglePlayback()}>
        {playing ? <Pause size={15}/> : <Play size={15}/>}
      </button>
      <div className="recording-controls">
        <span>录音</span>
        {failed ? <p className="delivery-note red" role="status">录音无法播放。</p> :
          <div className="recording-timeline">
            <input type="range" aria-label="录音播放进度" min="0" max={duration || 1} step="0.01"
              disabled={!duration} value={Math.min(position, duration)} onChange={event => {
                if (!audio.current) return;
                const next = event.currentTarget.valueAsNumber;
                audio.current.currentTime = next;
                setPosition(next);
              }}/>
            <span>{clock(position)} / {clock(duration)}</span>
          </div>}
      </div>
    </div>
  );
}
