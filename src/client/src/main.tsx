import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  EditorState,
  ImageAsset,
  SilenceSegment,
  SubtitleCue,
  TimelineEvent,
  TranscriptSegment,
  VideoJob,
  VideoProject
} from '../../shared/types';
import './styles.css';

type ApiVideo = VideoProject & {
  originalUrl: string | null;
  proxyUrl: string | null;
  renderUrl: string | null;
};

type ApiAsset = ImageAsset & { fileUrl: string | null };
type ApiRender = { id: string; downloadUrl: string | null; createdAt: string; status: string };

type ApiState = Omit<EditorState, 'video' | 'assets' | 'renders'> & {
  video: ApiVideo;
  assets: ApiAsset[];
  renders: ApiRender[];
};

const api = {
  async getVideos(): Promise<ApiVideo[]> {
    const response = await fetch('/api/videos');
    return (await response.json()).videos;
  },
  async getState(videoId: string): Promise<ApiState> {
    const response = await fetch(`/api/videos/${videoId}`);
    return response.json();
  },
  async uploadVideo(file: File) {
    const body = new FormData();
    body.append('video', file);
    body.append('title', file.name.replace(/\.[^.]+$/, ''));
    const response = await fetch('/api/videos/upload', { method: 'POST', body });
    if (!response.ok) throw new Error((await response.json()).error ?? 'Upload failed');
    return response.json();
  },
  async enqueue(videoId: string, type: 'detect-silence' | 'transcribe' | 'render') {
    const response = await fetch(`/api/videos/${videoId}/jobs/${type}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!response.ok) throw new Error((await response.json()).error ?? 'Job failed');
    return response.json();
  },
  async patch<T>(url: string, items: T[]) {
    const response = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items })
    });
    if (!response.ok) throw new Error((await response.json()).error ?? 'Save failed');
    return response.json();
  },
  async uploadAsset(videoId: string, file: File, label: string, triggerWords: string) {
    const body = new FormData();
    body.append('asset', file);
    body.append('label', label);
    body.append('triggerWords', triggerWords);
    const response = await fetch(`/api/videos/${videoId}/assets/png`, { method: 'POST', body });
    if (!response.ok) throw new Error((await response.json()).error ?? 'Asset upload failed');
    return response.json();
  },
  async patchAsset(asset: ApiAsset) {
    const response = await fetch(`/api/assets/${asset.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label: asset.label,
        triggerWords: asset.triggerWords,
        position: asset.position,
        timingMode: asset.timingMode
      })
    });
    if (!response.ok) throw new Error((await response.json()).error ?? 'Asset save failed');
    return response.json();
  }
};

function App() {
  const [videos, setVideos] = useState<ApiVideo[]>([]);
  const [state, setState] = useState<ApiState | null>(null);
  const [activeTab, setActiveTab] = useState<'transcript' | 'subtitles' | 'assets' | 'zooms'>('transcript');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [currentMs, setCurrentMs] = useState(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const selectedVideoId = state?.video.id ?? videos[0]?.id;

  async function refresh(videoId = selectedVideoId) {
    const list = await api.getVideos();
    setVideos(list);
    if (videoId) {
      const next = await api.getState(videoId);
      setState(next);
    } else if (list[0]) {
      setState(await api.getState(list[0].id));
    }
  }

  useEffect(() => {
    refresh().catch((err) => setError(String(err.message ?? err)));
  }, []);

  useEffect(() => {
    if (!selectedVideoId) return;
    const timer = window.setInterval(() => {
      refresh(selectedVideoId).catch(() => undefined);
    }, 2400);
    return () => window.clearInterval(timer);
  }, [selectedVideoId]);

  const latestJob = state?.jobs[0];
  const mediaUrl = state?.video.renderUrl || state?.video.proxyUrl || state?.video.originalUrl || '';
  const activeSubtitle = useMemo(() => {
    if (!state) return null;
    return state.subtitles.find((cue) => currentMs >= cue.startMs && currentMs <= cue.endMs) ?? null;
  }, [state, currentMs]);
  const activeAssets = useMemo(() => {
    if (!state) return [];
    const segment = state.transcript.find((item) => currentMs >= item.startMs && currentMs <= item.endMs);
    if (!segment) return [];
    const lower = segment.text.toLowerCase();
    return state.assets.filter((asset) => asset.triggerWords.some((word) => lower.includes(word.toLowerCase())));
  }, [state, currentMs]);

  async function runAction(label: string, action: () => Promise<void>) {
    setBusy(label);
    setError('');
    try {
      await action();
      await refresh(state?.video.id);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy('');
    }
  }

  function seek(ms: number) {
    setCurrentMs(ms);
    if (videoRef.current) videoRef.current.currentTime = ms / 1000;
  }

  async function saveTranscript(items: TranscriptSegment[]) {
    if (!state) return;
    await runAction('Guardando texto', async () => {
      await api.patch(`/api/videos/${state.video.id}/transcript`, items);
    });
  }

  async function saveSubtitles(items: SubtitleCue[]) {
    if (!state) return;
    await runAction('Guardando subtítulos', async () => {
      await api.patch(`/api/videos/${state.video.id}/subtitles`, items);
    });
  }

  async function saveSilences(items: SilenceSegment[]) {
    if (!state) return;
    await runAction('Guardando silencios', async () => {
      await api.patch(`/api/videos/${state.video.id}/silences`, items);
    });
  }

  async function saveTimeline(items: TimelineEvent[]) {
    if (!state) return;
    await runAction('Guardando timeline', async () => {
      await api.patch(`/api/videos/${state.video.id}/timeline`, items);
    });
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">M</div>
          <div>
            <strong>Editor de Video Pro</strong>
            <span>MVP Metamize</span>
          </div>
        </div>
        <label className="primary-upload">
          <input
            type="file"
            accept="video/*"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              runAction('Subiendo video', async () => {
                const result = await api.uploadVideo(file);
                setState(await api.getState(result.video.id));
              });
            }}
          />
          <span>+ Subir video</span>
        </label>
        <div className="project-list">
          <div className="section-label">Proyectos</div>
          {videos.map((video) => (
            <button
              key={video.id}
              className={`project-row ${state?.video.id === video.id ? 'is-active' : ''}`}
              onClick={() => refresh(video.id)}
            >
              <span className="project-thumb">{video.title.slice(0, 1).toUpperCase()}</span>
              <span>
                <strong>{video.title}</strong>
                <small>{video.status} · {formatDuration(video.durationMs)}</small>
              </span>
            </button>
          ))}
        </div>
        <div className="storage-note">
          <span>Railway-ready</span>
          <strong>MySQL + Volume + Worker</strong>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <h1>{state?.video.title ?? 'Nuevo proyecto'}</h1>
            <p>{latestJob ? `${latestJob.type} · ${latestJob.status} · ${latestJob.progress}%` : 'Subí un video para empezar'}</p>
          </div>
          <div className="actions">
            <button disabled={!state || !!busy} onClick={() => state && runAction('Detectando silencios', async () => { await api.enqueue(state.video.id, 'detect-silence'); })}>
              Cortar silencios
            </button>
            <button disabled={!state || !!busy} onClick={() => state && runAction('Transcribiendo', async () => { await api.enqueue(state.video.id, 'transcribe'); })}>
              Transcribir
            </button>
            <button disabled={!state || !!busy} onClick={() => state && runAction('Renderizando', async () => { await api.enqueue(state.video.id, 'render'); })} className="render-button">
              Renderizar
            </button>
          </div>
        </header>

        {error && <div className="error-banner">{error}</div>}
        {busy && <div className="progress-banner">{busy}</div>}

        {!state ? (
          <EmptyState />
        ) : (
          <div className="editor-grid">
            <section className="preview-panel">
              <div className="preview-toolbar">
                <span>Vista previa</span>
                <div>
                  <button onClick={() => seek(Math.max(0, currentMs - 2000))}>-2s</button>
                  <button onClick={() => videoRef.current?.paused ? videoRef.current?.play() : videoRef.current?.pause()}>Play/Pause</button>
                  <button onClick={() => seek(currentMs + 2000)}>+2s</button>
                </div>
              </div>
              <div className="video-stage">
                {mediaUrl ? (
                  <video
                    ref={videoRef}
                    src={mediaUrl}
                    controls
                    onTimeUpdate={(event) => setCurrentMs(event.currentTarget.currentTime * 1000)}
                  />
                ) : (
                  <div className="video-placeholder">Procesando proxy...</div>
                )}
                {activeSubtitle && <div className="subtitle-preview">{activeSubtitle.text}</div>}
                {activeAssets.map((asset) => (
                  <img
                    key={asset.id}
                    className="asset-preview"
                    src={asset.fileUrl ?? ''}
                    style={{
                      left: `${asset.position.x * 100}%`,
                      top: `${asset.position.y * 100}%`,
                      transform: `translate(-50%, -50%) scale(${asset.position.scale})`
                    }}
                  />
                ))}
              </div>
              <Timeline
                state={state}
                currentMs={currentMs}
                onSeek={seek}
                onSaveSilences={saveSilences}
                onSaveTimeline={saveTimeline}
              />
            </section>

            <aside className="inspector">
              <nav className="tabs">
                {(['transcript', 'subtitles', 'assets', 'zooms'] as const).map((tab) => (
                  <button key={tab} className={activeTab === tab ? 'is-active' : ''} onClick={() => setActiveTab(tab)}>
                    {tabLabel(tab)}
                  </button>
                ))}
              </nav>
              {activeTab === 'transcript' && <TranscriptEditor state={state} onSave={saveTranscript} onSeek={seek} />}
              {activeTab === 'subtitles' && <SubtitleEditor state={state} onSave={saveSubtitles} onSeek={seek} />}
              {activeTab === 'assets' && <AssetEditor state={state} onUploadAsset={api.uploadAsset} onSaveAsset={api.patchAsset} onRefresh={() => refresh(state.video.id)} />}
              {activeTab === 'zooms' && <ZoomEditor state={state} currentMs={currentMs} onSave={saveTimeline} />}
            </aside>
          </div>
        )}
      </section>
    </main>
  );
}

function Timeline({
  state,
  currentMs,
  onSeek,
  onSaveSilences,
  onSaveTimeline
}: {
  state: ApiState;
  currentMs: number;
  onSeek: (ms: number) => void;
  onSaveSilences: (items: SilenceSegment[]) => Promise<void>;
  onSaveTimeline: (items: TimelineEvent[]) => Promise<void>;
}) {
  const duration = Math.max(state.video.durationMs, 1);
  const zooms = state.timeline.filter((event) => event.type === 'zoom');

  function addZoom() {
    const startMs = Math.max(0, currentMs);
    const event: TimelineEvent = {
      id: clientId(),
      videoId: state.video.id,
      type: 'zoom',
      startMs,
      endMs: Math.min(startMs + 1600, duration),
      enabled: true,
      payload: { scale: 1.18 }
    };
    onSaveTimeline([...state.timeline, event]);
  }

  return (
    <div className="timeline-panel">
      <div className="timeline-head">
        <span>{formatDuration(currentMs)} / {formatDuration(duration)}</span>
        <button onClick={addZoom}>+ Zoom en cursor</button>
      </div>
      <div className="timeline-ruler" onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        onSeek(((event.clientX - rect.left) / rect.width) * duration);
      }}>
        <div className="playhead" style={{ left: `${(currentMs / duration) * 100}%` }} />
        <Lane label="Silencios">
          {state.silences.map((segment) => (
            <button
              key={segment.id}
              className={`segment silence ${segment.action}`}
              style={segmentStyle(segment.startMs, segment.endMs, duration)}
              onClick={(event) => {
                event.stopPropagation();
                onSaveSilences(state.silences.map((item) => item.id === segment.id ? { ...item, action: item.action === 'cut' ? 'keep' : 'cut' } : item));
              }}
              title={`${formatDuration(segment.durationMs)} · ${segment.action}`}
            />
          ))}
        </Lane>
        <Lane label="Subtítulos">
          {state.subtitles.map((cue) => (
            <button key={cue.id} className="segment subtitle" style={segmentStyle(cue.startMs, cue.endMs, duration)} onClick={(event) => {
              event.stopPropagation();
              onSeek(cue.startMs);
            }}>
              {cue.text.slice(0, 22)}
            </button>
          ))}
        </Lane>
        <Lane label="PNGs">
          {state.assets.map((asset, index) => (
            <span key={asset.id} className="png-dot" style={{ left: `${8 + index * 9}%` }}>{asset.triggerWords[0] ?? asset.label}</span>
          ))}
        </Lane>
        <Lane label="Zooms">
          {zooms.map((event) => (
            <span key={event.id} className="segment zoom" style={segmentStyle(event.startMs, event.endMs, duration)} />
          ))}
        </Lane>
      </div>
    </div>
  );
}

function Lane({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="lane">
      <span>{label}</span>
      <div>{children}</div>
    </div>
  );
}

function TranscriptEditor({ state, onSave, onSeek }: { state: ApiState; onSave: (items: TranscriptSegment[]) => Promise<void>; onSeek: (ms: number) => void }) {
  const [items, setItems] = useState(state.transcript);
  useEffect(() => setItems(state.transcript), [state.transcript]);
  return (
    <div className="editor-list">
      <PanelHead title="Transcripción editable" action="Guardar" onAction={() => onSave(items)} />
      {items.map((item, index) => (
        <div key={item.id} className="text-row">
          <button onClick={() => onSeek(item.startMs)}>{formatDuration(item.startMs)}</button>
          <textarea value={item.text} onChange={(event) => setItems(items.map((row, rowIndex) => rowIndex === index ? { ...row, text: event.target.value, source: 'manual' } : row))} />
        </div>
      ))}
    </div>
  );
}

function SubtitleEditor({ state, onSave, onSeek }: { state: ApiState; onSave: (items: SubtitleCue[]) => Promise<void>; onSeek: (ms: number) => void }) {
  const [items, setItems] = useState(state.subtitles);
  useEffect(() => setItems(state.subtitles), [state.subtitles]);
  return (
    <div className="editor-list">
      <PanelHead title="Subtítulos quemados" action="Guardar" onAction={() => onSave(items)} />
      <div className="style-strip">
        <button onClick={() => setItems(items.map((item) => ({ ...item, style: { ...item.style, position: 'bottom' } })))}>Abajo</button>
        <button onClick={() => setItems(items.map((item) => ({ ...item, style: { ...item.style, uppercase: !item.style.uppercase } })))}>Mayúsculas</button>
        <input type="color" value={items[0]?.style.backColor ?? '#7c3aed'} onChange={(event) => setItems(items.map((item) => ({ ...item, style: { ...item.style, backColor: event.target.value } })))} />
      </div>
      {items.map((item, index) => (
        <div key={item.id} className="text-row compact">
          <button onClick={() => onSeek(item.startMs)}>{formatDuration(item.startMs)}</button>
          <input value={item.text} onChange={(event) => setItems(items.map((row, rowIndex) => rowIndex === index ? { ...row, text: event.target.value } : row))} />
        </div>
      ))}
    </div>
  );
}

function AssetEditor({
  state,
  onUploadAsset,
  onSaveAsset,
  onRefresh
}: {
  state: ApiState;
  onUploadAsset: (videoId: string, file: File, label: string, triggerWords: string) => Promise<unknown>;
  onSaveAsset: (asset: ApiAsset) => Promise<unknown>;
  onRefresh: () => Promise<void>;
}) {
  const [label, setLabel] = useState('Gasto');
  const [triggers, setTriggers] = useState('gasto, roas, compras');
  const [assets, setAssets] = useState(state.assets);
  useEffect(() => setAssets(state.assets), [state.assets]);
  return (
    <div className="editor-list">
      <PanelHead title="PNGs por palabra" />
      <label className="asset-upload">
        <input type="file" accept="image/png,image/webp,image/jpeg" onChange={async (event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          await onUploadAsset(state.video.id, file, label, triggers);
          await onRefresh();
        }} />
        <span>Subir PNG / WEBP</span>
      </label>
      <div className="two-fields">
        <input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Etiqueta" />
        <input value={triggers} onChange={(event) => setTriggers(event.target.value)} placeholder="palabras, separadas, por coma" />
      </div>
      {assets.map((asset, index) => (
        <div key={asset.id} className="asset-row">
          {asset.fileUrl && <img src={asset.fileUrl} />}
          <input value={asset.label} onChange={(event) => setAssets(assets.map((row, rowIndex) => rowIndex === index ? { ...row, label: event.target.value } : row))} />
          <input value={asset.triggerWords.join(', ')} onChange={(event) => setAssets(assets.map((row, rowIndex) => rowIndex === index ? { ...row, triggerWords: event.target.value.split(',').map((word) => word.trim()).filter(Boolean) } : row))} />
          <button onClick={async () => {
            await onSaveAsset(assets[index]);
            await onRefresh();
          }}>Guardar</button>
        </div>
      ))}
    </div>
  );
}

function ZoomEditor({ state, currentMs, onSave }: { state: ApiState; currentMs: number; onSave: (items: TimelineEvent[]) => Promise<void> }) {
  const zooms = state.timeline.filter((event) => event.type === 'zoom');
  function updateZoom(index: number, patch: Partial<TimelineEvent>) {
    const target = zooms[index];
    onSave(state.timeline.map((event) => event.id === target.id ? { ...event, ...patch } : event));
  }
  return (
    <div className="editor-list">
      <PanelHead title="Zooms punch-in" action="+ Agregar" onAction={() => {
        const startMs = Math.max(0, currentMs);
        onSave([...state.timeline, {
          id: clientId(),
          videoId: state.video.id,
          type: 'zoom',
          startMs,
          endMs: Math.min(startMs + 1600, Math.max(state.video.durationMs, startMs + 1600)),
          enabled: true,
          payload: { scale: 1.18 }
        }]);
      }} />
      {zooms.map((event, index) => (
        <div key={event.id} className="zoom-row">
          <span>{formatDuration(event.startMs)}</span>
          <input type="number" step="0.01" value={Number(event.payload.scale ?? 1.18)} onChange={(input) => updateZoom(index, { payload: { ...event.payload, scale: Number(input.target.value) } })} />
          <button onClick={() => updateZoom(index, { enabled: !event.enabled })}>{event.enabled ? 'Activo' : 'Off'}</button>
        </div>
      ))}
    </div>
  );
}

function PanelHead({ title, action, onAction }: { title: string; action?: string; onAction?: () => void }) {
  return (
    <div className="panel-head">
      <strong>{title}</strong>
      {action && <button onClick={onAction}>{action}</button>}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="empty-state">
      <div className="empty-icon">▶</div>
      <h2>Subí un video y probamos el MVP</h2>
      <p>El worker crea proxy, detecta silencios, transcribe, te deja editar y renderiza el corte final.</p>
    </div>
  );
}

function segmentStyle(startMs: number, endMs: number, duration: number) {
  return {
    left: `${(startMs / duration) * 100}%`,
    width: `${Math.max(((endMs - startMs) / duration) * 100, 0.4)}%`
  };
}

function formatDuration(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function tabLabel(tab: string) {
  return {
    transcript: 'Transcripción',
    subtitles: 'Subtítulos',
    assets: 'PNGs',
    zooms: 'Zooms'
  }[tab];
}

function clientId() {
  return `ui_${Math.random().toString(36).slice(2, 12)}`;
}

createRoot(document.getElementById('root')!).render(<App />);
