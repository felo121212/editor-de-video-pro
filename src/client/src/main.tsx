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

type InspectorTab = 'transcript' | 'subtitles' | 'silences' | 'assets' | 'zooms';
type AspectRatio = '9:16' | '1:1' | '16:9';

const api = {
  async getVideos(): Promise<ApiVideo[]> {
    const response = await fetch('/api/videos');
    if (!response.ok) throw new Error('No se pudieron cargar los proyectos');
    return (await response.json()).videos;
  },
  async getState(videoId: string): Promise<ApiState> {
    const response = await fetch(`/api/videos/${videoId}`);
    if (!response.ok) throw new Error((await response.json()).error ?? 'No se pudo cargar el proyecto');
    return response.json();
  },
  uploadVideo(file: File, onProgress: (progress: number) => void) {
    return new Promise<{ video: ApiVideo; job: VideoJob }>((resolve, reject) => {
      const body = new FormData();
      body.append('video', file);
      body.append('title', file.name.replace(/\.[^.]+$/, ''));
      const request = new XMLHttpRequest();
      request.open('POST', '/api/videos/upload');
      request.upload.onprogress = (event) => {
        if (!event.lengthComputable) return;
        onProgress(Math.round((event.loaded / event.total) * 100));
      };
      request.onload = () => {
        try {
          const data = JSON.parse(request.responseText || '{}');
          if (request.status >= 200 && request.status < 300) {
            onProgress(100);
            resolve(data);
          } else {
            reject(new Error(data.error ?? 'Upload failed'));
          }
        } catch (error) {
          reject(error);
        }
      };
      request.onerror = () => reject(new Error('Upload failed'));
      request.send(body);
    });
  },
  async enqueue(videoId: string, type: 'detect-silence' | 'transcribe' | 'render', payload: Record<string, unknown> = {}) {
    const response = await fetch(`/api/videos/${videoId}/jobs/${type}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
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
  const [activeTab, setActiveTab] = useState<InspectorTab>('transcript');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [currentMs, setCurrentMs] = useState(0);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [aspect, setAspect] = useState<AspectRatio>('9:16');
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
    }, 2200);
    return () => window.clearInterval(timer);
  }, [selectedVideoId]);

  const latestJob = state?.jobs[0];
  const latestRender = state?.renders[0];
  const mediaUrl = state?.video.renderUrl || state?.video.proxyUrl || state?.video.originalUrl || '';
  const enabledCuts = state?.silences.filter((segment) => segment.action === 'cut').length ?? 0;
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
    const next = Math.max(0, Math.min(ms, state?.video.durationMs ?? ms));
    setCurrentMs(next);
    if (videoRef.current) videoRef.current.currentTime = next / 1000;
  }

  async function handleUpload(file: File) {
    await runAction('Subiendo video', async () => {
      setUploadProgress(0);
      const result = await api.uploadVideo(file, setUploadProgress);
      const next = await api.getState(result.video.id);
      setState(next);
      setUploadProgress(null);
    });
  }

  async function saveTranscript(items: TranscriptSegment[]) {
    if (!state) return;
    await runAction('Guardando transcript', async () => {
      await api.patch(`/api/videos/${state.video.id}/transcript`, items);
    });
  }

  async function saveSubtitles(items: SubtitleCue[]) {
    if (!state) return;
    await runAction('Guardando subtitulos', async () => {
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
    <main className="studio-shell">
      <TopBar
        state={state}
        latestJob={latestJob}
        aspect={aspect}
        setAspect={setAspect}
        busy={busy}
        onDetectSilence={() => state && runAction('Detectando silencios', async () => {
          await api.enqueue(state.video.id, 'detect-silence', { noiseDb: -35, minDurationSec: 0.35 });
        })}
        onTranscribe={() => state && runAction('Transcribiendo', async () => {
          await api.enqueue(state.video.id, 'transcribe');
        })}
        onRender={() => state && runAction('Renderizando', async () => {
          await api.enqueue(state.video.id, 'render');
        })}
      />

      <div className="studio-body">
        <LeftRail />
        <ProjectPanel
          videos={videos}
          activeId={state?.video.id}
          uploadProgress={uploadProgress}
          onUpload={handleUpload}
          onSelect={(videoId) => refresh(videoId)}
        />

        <section className="editor-main">
          {(error || busy || latestJob) && (
            <StatusStrip error={error} busy={busy} job={latestJob} uploadProgress={uploadProgress} />
          )}
          {!state ? (
            <EmptyState onUpload={handleUpload} />
          ) : (
            <>
              <PreviewPanel
                state={state}
                mediaUrl={mediaUrl}
                videoRef={videoRef}
                currentMs={currentMs}
                aspect={aspect}
                activeSubtitle={activeSubtitle}
                activeAssets={activeAssets}
                onSeek={seek}
                onTimeUpdate={setCurrentMs}
              />
              <Timeline
                state={state}
                currentMs={currentMs}
                onSeek={seek}
                onSaveSilences={saveSilences}
                onSaveTimeline={saveTimeline}
              />
            </>
          )}
        </section>

        <Inspector
          state={state}
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          latestRender={latestRender}
          enabledCuts={enabledCuts}
          currentMs={currentMs}
          busy={busy}
          onSeek={seek}
          onSaveTranscript={saveTranscript}
          onSaveSubtitles={saveSubtitles}
          onSaveSilences={saveSilences}
          onSaveTimeline={saveTimeline}
          onUploadAsset={api.uploadAsset}
          onSaveAsset={api.patchAsset}
          onRefresh={() => state ? refresh(state.video.id) : Promise.resolve()}
          onDetectSilence={(noiseDb, minDurationSec) => state && runAction('Detectando silencios', async () => {
            await api.enqueue(state.video.id, 'detect-silence', { noiseDb, minDurationSec });
          })}
        />
      </div>
    </main>
  );
}

function TopBar({
  state,
  latestJob,
  aspect,
  setAspect,
  busy,
  onDetectSilence,
  onTranscribe,
  onRender
}: {
  state: ApiState | null;
  latestJob?: VideoJob;
  aspect: AspectRatio;
  setAspect: (aspect: AspectRatio) => void;
  busy: string;
  onDetectSilence: () => void;
  onTranscribe: () => void;
  onRender: () => void;
}) {
  return (
    <header className="top-command">
      <div className="product-lockup">
        <div className="brand-mark">M</div>
        <div>
          <strong>Editor de Video Pro</strong>
          <span>by Metamize</span>
        </div>
      </div>
      <div className="project-title">
        <strong>{state?.video.title ?? 'Nuevo proyecto'}</strong>
        <span>{latestJob ? `${jobLabel(latestJob.type)} - ${latestJob.status} - ${latestJob.progress}%` : 'Guardado local'}</span>
      </div>
      <div className="top-actions">
        <div className="aspect-switch" aria-label="Aspect ratio">
          {(['9:16', '1:1', '16:9'] as AspectRatio[]).map((item) => (
            <button key={item} className={aspect === item ? 'is-active' : ''} onClick={() => setAspect(item)}>
              {item}
            </button>
          ))}
        </div>
        <button disabled={!state || !!busy} onClick={onDetectSilence}>Cortar silencios</button>
        <button disabled={!state || !!busy} onClick={onTranscribe}>Transcribir</button>
        <button disabled={!state || !!busy} className="export-button" onClick={onRender}>Exportar</button>
      </div>
    </header>
  );
}

function LeftRail() {
  const items = [
    ['P', 'Proyectos'],
    ['M', 'Medios'],
    ['T', 'Texto'],
    ['S', 'Subtitulos'],
    ['E', 'Elementos'],
    ['A', 'Audio']
  ];
  return (
    <nav className="left-rail">
      {items.map(([icon, label], index) => (
        <button key={label} className={index === 0 ? 'is-active' : ''} title={label}>
          <span>{icon}</span>
          <small>{label}</small>
        </button>
      ))}
    </nav>
  );
}

function ProjectPanel({
  videos,
  activeId,
  uploadProgress,
  onUpload,
  onSelect
}: {
  videos: ApiVideo[];
  activeId?: string;
  uploadProgress: number | null;
  onUpload: (file: File) => Promise<void>;
  onSelect: (videoId: string) => void;
}) {
  const [isDragging, setDragging] = useState(false);
  return (
    <aside
      className={`project-panel ${isDragging ? 'is-dragging' : ''}`}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        const file = event.dataTransfer.files[0];
        if (file) onUpload(file);
      }}
    >
      <div className="panel-title">
        <strong>Proyectos</strong>
        <label className="upload-button">
          <input type="file" accept="video/*" onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) onUpload(file);
          }} />
          Subir video
        </label>
      </div>
      <div className="search-box">Buscar proyectos...</div>
      {uploadProgress !== null && (
        <div className="upload-meter">
          <span>Subiendo video</span>
          <strong>{uploadProgress}%</strong>
          <div><i style={{ width: `${uploadProgress}%` }} /></div>
        </div>
      )}
      <div className="recent-label">Recientes</div>
      <div className="project-list">
        {videos.map((video) => (
          <button key={video.id} className={`project-card ${activeId === video.id ? 'is-active' : ''}`} onClick={() => onSelect(video.id)}>
            <span className="thumb">{video.title.slice(0, 1).toUpperCase()}</span>
            <span>
              <strong>{video.title}</strong>
              <small>{formatDate(video.updatedAt)} - {formatDuration(video.durationMs)}</small>
            </span>
            <em>{video.status}</em>
          </button>
        ))}
      </div>
    </aside>
  );
}

function StatusStrip({ error, busy, job, uploadProgress }: { error: string; busy: string; job?: VideoJob; uploadProgress: number | null }) {
  const text = error || busy || (job ? `${jobLabel(job.type)} - ${job.status}` : 'Listo');
  const progress = uploadProgress ?? job?.progress ?? (busy ? 12 : 100);
  return (
    <div className={`status-strip ${error ? 'has-error' : ''}`}>
      <span>{text}</span>
      <strong>{Math.round(progress)}%</strong>
      <div><i style={{ width: `${Math.max(2, Math.min(100, progress))}%` }} /></div>
    </div>
  );
}

function PreviewPanel({
  state,
  mediaUrl,
  videoRef,
  currentMs,
  aspect,
  activeSubtitle,
  activeAssets,
  onSeek,
  onTimeUpdate
}: {
  state: ApiState;
  mediaUrl: string;
  videoRef: React.MutableRefObject<HTMLVideoElement | null>;
  currentMs: number;
  aspect: AspectRatio;
  activeSubtitle: SubtitleCue | null;
  activeAssets: ApiAsset[];
  onSeek: (ms: number) => void;
  onTimeUpdate: (ms: number) => void;
}) {
  return (
    <section className="preview-panel">
      <nav className="workspace-tabs">
        {['Vista previa', 'Transcript', 'Subtitulos', 'Silencios', 'Zooms', 'PNGs'].map((item, index) => (
          <button key={item} className={index === 0 ? 'is-active' : ''}>{item}</button>
        ))}
      </nav>
      <div className="preview-stage">
        <span className="resolution-chip">{aspect === '9:16' ? '1080x1920' : aspect === '1:1' ? '1080x1080' : '1920x1080'}</span>
        <div className={`video-frame aspect-${aspect.replace(':', '-')}`}>
          {mediaUrl ? (
            <video
              ref={videoRef}
              src={mediaUrl}
              onTimeUpdate={(event) => onTimeUpdate(event.currentTarget.currentTime * 1000)}
            />
          ) : (
            <div className="video-placeholder">Procesando preview...</div>
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
      </div>
      <div className="transport">
        <span>{formatDuration(currentMs)} / {formatDuration(state.video.durationMs)}</span>
        <div>
          <button onClick={() => onSeek(Math.max(0, currentMs - 2000))}>-2s</button>
          <button className="play-button" onClick={() => videoRef.current?.paused ? videoRef.current?.play() : videoRef.current?.pause()}>Play</button>
          <button onClick={() => onSeek(currentMs + 2000)}>+2s</button>
        </div>
        <span>{state.video.fps || 30} FPS</span>
      </div>
    </section>
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
    <section className="timeline-panel">
      <div className="timeline-tools">
        <button>Deshacer</button>
        <button>Cortar</button>
        <button>Dividir</button>
        <button onClick={addZoom}>Zoom en cursor</button>
        <span>Zoom timeline</span>
      </div>
      <div className="time-ruler" onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        onSeek(((event.clientX - rect.left) / rect.width) * duration);
      }}>
        <div className="playhead" style={{ left: `${(currentMs / duration) * 100}%` }}>
          <b>{formatDuration(currentMs)}</b>
        </div>
        <Lane label="Video">
          <div className="video-strip" />
        </Lane>
        <Lane label="Audio">
          <div className="waveform" />
        </Lane>
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
              title={`${formatDuration(segment.durationMs)} - ${segment.action}`}
            />
          ))}
        </Lane>
        <Lane label="Subtitulos">
          {state.subtitles.map((cue) => (
            <button key={cue.id} className="segment subtitle" style={segmentStyle(cue.startMs, cue.endMs, duration)} onClick={(event) => {
              event.stopPropagation();
              onSeek(cue.startMs);
            }}>
              {cue.text.slice(0, 24)}
            </button>
          ))}
        </Lane>
        <Lane label="PNGs">
          {state.assets.map((asset, index) => (
            <span key={asset.id} className="asset-event" style={{ left: `${Math.min(92, 8 + index * 11)}%` }}>
              {asset.triggerWords[0] ?? asset.label}
            </span>
          ))}
        </Lane>
        <Lane label="Zooms">
          {zooms.map((event) => (
            <span key={event.id} className={`segment zoom ${event.enabled ? '' : 'is-off'}`} style={segmentStyle(event.startMs, event.endMs, duration)} />
          ))}
        </Lane>
      </div>
    </section>
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

function Inspector({
  state,
  activeTab,
  setActiveTab,
  latestRender,
  enabledCuts,
  currentMs,
  busy,
  onSeek,
  onSaveTranscript,
  onSaveSubtitles,
  onSaveSilences,
  onSaveTimeline,
  onUploadAsset,
  onSaveAsset,
  onRefresh,
  onDetectSilence
}: {
  state: ApiState | null;
  activeTab: InspectorTab;
  setActiveTab: (tab: InspectorTab) => void;
  latestRender?: ApiRender;
  enabledCuts: number;
  currentMs: number;
  busy: string;
  onSeek: (ms: number) => void;
  onSaveTranscript: (items: TranscriptSegment[]) => Promise<void>;
  onSaveSubtitles: (items: SubtitleCue[]) => Promise<void>;
  onSaveSilences: (items: SilenceSegment[]) => Promise<void>;
  onSaveTimeline: (items: TimelineEvent[]) => Promise<void>;
  onUploadAsset: (videoId: string, file: File, label: string, triggerWords: string) => Promise<unknown>;
  onSaveAsset: (asset: ApiAsset) => Promise<unknown>;
  onRefresh: () => Promise<void>;
  onDetectSilence: (noiseDb: number, minDurationSec: number) => void;
}) {
  return (
    <aside className="inspector">
      <div className="render-card">
        <span className={latestRender ? 'ok-dot' : 'idle-dot'}>{latestRender ? 'Render listo' : 'Sin render final'}</span>
        <strong>{latestRender ? 'Video final generado correctamente' : state ? `${enabledCuts} cortes activos` : 'Subi un video para empezar'}</strong>
        {latestRender?.downloadUrl && <a href={latestRender.downloadUrl} download>Descargar MP4</a>}
      </div>
      <nav className="inspector-tabs">
        {(['transcript', 'subtitles', 'silences', 'assets', 'zooms'] as InspectorTab[]).map((tab) => (
          <button key={tab} className={activeTab === tab ? 'is-active' : ''} onClick={() => setActiveTab(tab)}>
            {tabLabel(tab)}
          </button>
        ))}
      </nav>
      {!state ? (
        <div className="empty-inspector">Selecciona o subi un proyecto.</div>
      ) : (
        <>
          {activeTab === 'transcript' && <TranscriptEditor state={state} onSave={onSaveTranscript} onSeek={onSeek} />}
          {activeTab === 'subtitles' && <SubtitleEditor state={state} onSave={onSaveSubtitles} onSeek={onSeek} />}
          {activeTab === 'silences' && <SilenceEditor state={state} busy={busy} onSave={onSaveSilences} onDetect={onDetectSilence} />}
          {activeTab === 'assets' && <AssetEditor state={state} onUploadAsset={onUploadAsset} onSaveAsset={onSaveAsset} onRefresh={onRefresh} />}
          {activeTab === 'zooms' && <ZoomEditor state={state} currentMs={currentMs} onSave={onSaveTimeline} />}
        </>
      )}
    </aside>
  );
}

function TranscriptEditor({ state, onSave, onSeek }: { state: ApiState; onSave: (items: TranscriptSegment[]) => Promise<void>; onSeek: (ms: number) => void }) {
  const [items, setItems] = useState(state.transcript);
  useEffect(() => setItems(state.transcript), [state.transcript]);
  return (
    <div className="editor-list">
      <PanelHead title="Transcript editable" action="Guardar" onAction={() => onSave(items)} />
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
      <PanelHead title="Subtitulos" action="Guardar" onAction={() => onSave(items)} />
      <div className="control-grid">
        <button onClick={() => setItems(items.map((item) => ({ ...item, style: { ...item.style, position: 'top' } })))}>Top</button>
        <button onClick={() => setItems(items.map((item) => ({ ...item, style: { ...item.style, position: 'bottom' } })))}>Bottom</button>
        <button onClick={() => setItems(items.map((item) => ({ ...item, style: { ...item.style, uppercase: !item.style.uppercase } })))}>Uppercase</button>
      </div>
      <InspectorField label="Color">
        <input type="color" value={items[0]?.style.primaryColor ?? '#ffffff'} onChange={(event) => setItems(items.map((item) => ({ ...item, style: { ...item.style, primaryColor: event.target.value } })))} />
      </InspectorField>
      <InspectorField label="Fondo">
        <input type="color" value={items[0]?.style.backColor ?? '#7c3aed'} onChange={(event) => setItems(items.map((item) => ({ ...item, style: { ...item.style, backColor: event.target.value } })))} />
      </InspectorField>
      {items.map((item, index) => (
        <div key={item.id} className="text-row compact">
          <button onClick={() => onSeek(item.startMs)}>{formatDuration(item.startMs)}</button>
          <input value={item.text} onChange={(event) => setItems(items.map((row, rowIndex) => rowIndex === index ? { ...row, text: event.target.value } : row))} />
        </div>
      ))}
    </div>
  );
}

function SilenceEditor({
  state,
  busy,
  onSave,
  onDetect
}: {
  state: ApiState;
  busy: string;
  onSave: (items: SilenceSegment[]) => Promise<void>;
  onDetect: (noiseDb: number, minDurationSec: number) => void;
}) {
  const [noiseDb, setNoiseDb] = useState(-35);
  const [minDurationSec, setMinDurationSec] = useState(0.35);
  const totalCutMs = state.silences.filter((item) => item.action === 'cut').reduce((sum, item) => sum + item.durationMs, 0);
  return (
    <div className="editor-list">
      <PanelHead title="Silencios" action="Re-detectar" onAction={() => onDetect(noiseDb, minDurationSec)} />
      <InspectorField label="Umbral dB">
        <input type="range" min="-60" max="-15" value={noiseDb} onChange={(event) => setNoiseDb(Number(event.target.value))} />
        <strong>{noiseDb} dB</strong>
      </InspectorField>
      <InspectorField label="Duracion minima">
        <input type="range" min="0.12" max="1.5" step="0.01" value={minDurationSec} onChange={(event) => setMinDurationSec(Number(event.target.value))} />
        <strong>{minDurationSec.toFixed(2)} s</strong>
      </InspectorField>
      <div className="metric-card">
        <span>Cortes activos</span>
        <strong>{state.silences.filter((item) => item.action === 'cut').length}</strong>
        <small>{formatDuration(totalCutMs)} removidos en render</small>
      </div>
      <button disabled={!!busy || !state.silences.length} onClick={() => onSave(state.silences.map((item) => ({ ...item, action: 'keep' })))}>Restaurar todos</button>
      {state.silences.map((segment) => (
        <button key={segment.id} className={`silence-row ${segment.action}`} onClick={() => onSave(state.silences.map((item) => item.id === segment.id ? { ...item, action: item.action === 'cut' ? 'keep' : 'cut' } : item))}>
          <span>{formatDuration(segment.startMs)} - {formatDuration(segment.endMs)}</span>
          <strong>{segment.action}</strong>
        </button>
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
  const [label, setLabel] = useState('ROAS');
  const [triggers, setTriggers] = useState('roas, gasto, compras');
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
        Subir PNG / WEBP
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
      <PanelHead title="Zooms" action="+ Agregar" onAction={() => {
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

function InspectorField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="inspector-field">
      <span>{label}</span>
      <div>{children}</div>
    </label>
  );
}

function EmptyState({ onUpload }: { onUpload: (file: File) => Promise<void> }) {
  return (
    <div className="empty-state">
      <div className="empty-icon">MP4</div>
      <h2>Subi un video y armamos el primer corte</h2>
      <p>El editor genera proxy, detecta silencios, crea transcript editable, prepara subtitulos y exporta un MP4 final.</p>
      <label className="upload-button large">
        <input type="file" accept="video/*" onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onUpload(file);
        }} />
        Subir video
      </label>
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

function formatDate(value: string) {
  try {
    return new Intl.DateTimeFormat('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
  } catch {
    return 'sin fecha';
  }
}

function jobLabel(type: string) {
  return {
    ingest: 'Preparando video',
    detect_silence: 'Silencios',
    transcribe: 'Transcripcion',
    render: 'Render'
  }[type] ?? type;
}

function tabLabel(tab: InspectorTab) {
  return {
    transcript: 'Transcript',
    subtitles: 'Subtitulos',
    silences: 'Silencios',
    assets: 'PNGs',
    zooms: 'Zooms'
  }[tab];
}

function clientId() {
  return `ui_${Math.random().toString(36).slice(2, 12)}`;
}

createRoot(document.getElementById('root')!).render(<App />);
