import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  defaultSubtitleStyle,
  EditorState,
  ImageAsset,
  SilenceSegment,
  SubtitleCue,
  SubtitleGenerationSettings,
  SubtitleStyle,
  TimelineEvent,
  TranscriptSegment,
  VideoJob,
  VideoProject,
  VideoThumbnail,
  WaveformPoint
} from '../../shared/types';
import './styles.css';

type ApiVideo = VideoProject & {
  originalUrl: string | null;
  proxyUrl: string | null;
  renderUrl: string | null;
};

type ApiAsset = ImageAsset & { fileUrl: string | null };
type ApiThumbnail = VideoThumbnail & { fileUrl: string | null };
type ApiRender = { id: string; downloadUrl: string | null; createdAt: string; status: string };

type ApiState = Omit<EditorState, 'video' | 'assets' | 'thumbnails' | 'renders'> & {
  video: ApiVideo;
  assets: ApiAsset[];
  thumbnails: ApiThumbnail[];
  renders: ApiRender[];
};

type InspectorTab = 'transcript' | 'subtitles' | 'silences' | 'assets' | 'zooms';
type AspectRatio = '9:16' | '4:5' | '1:1' | '16:9';
type SelectionKind = 'silence' | 'subtitle' | 'asset' | 'zoom' | 'image_overlay';
type SelectionTarget = { kind: SelectionKind; id: string } | null;
type DragMode = 'move' | 'start' | 'end';
type PipelineStepKey = 'ingest' | 'generate_waveform' | 'generate_thumbnails' | 'detect_silence' | 'transcribe';
type PreviewAssetLayer = {
  id: string;
  asset: ApiAsset;
  selection: NonNullable<SelectionTarget>;
};
type EditorHistorySnapshot = {
  silences: SilenceSegment[];
  subtitles: SubtitleCue[];
  timeline: TimelineEvent[];
};
type SilenceDetectRequest = {
  noiseDb: number;
  minDurationSec: number;
  paddingBeforeMs: number;
  paddingAfterMs: number;
  preserveBreaths: boolean;
};

const defaultSilenceDetectRequest: SilenceDetectRequest = {
  noiseDb: -35,
  minDurationSec: 0.35,
  paddingBeforeMs: 80,
  paddingAfterMs: 120,
  preserveBreaths: true
};

const timelineLabelWidth = 150;
const timelineRightPad = 12;

const aspectPresets: Record<AspectRatio, { label: string; resolution: string; width: number; height: number }> = {
  '9:16': { label: '9:16', resolution: '1080x1920', width: 1080, height: 1920 },
  '4:5': { label: '4:5', resolution: '1080x1350', width: 1080, height: 1350 },
  '1:1': { label: '1:1', resolution: '1080x1080', width: 1080, height: 1080 },
  '16:9': { label: '16:9', resolution: '1920x1080', width: 1920, height: 1080 }
};

const subtitlePresets: Record<SubtitleStyle['preset'], SubtitleStyle> = {
  bold: {
    ...defaultSubtitleStyle,
    preset: 'bold',
    primaryColor: '#ffffff',
    outlineColor: '#080914',
    backColor: '#7c3aed',
    outlineWidth: 4,
    shadow: 1,
    box: false,
    bold: true
  },
  yellow: {
    ...defaultSubtitleStyle,
    preset: 'yellow',
    primaryColor: '#ffd84d',
    outlineColor: '#120b03',
    backColor: '#7c3aed',
    outlineWidth: 4,
    shadow: 2,
    box: false,
    bold: true,
    uppercase: true
  },
  neon: {
    ...defaultSubtitleStyle,
    preset: 'neon',
    primaryColor: '#ffffff',
    outlineColor: '#16d99b',
    backColor: '#7c3aed',
    outlineWidth: 2,
    shadow: 4,
    box: false,
    bold: true
  },
  pill: {
    ...defaultSubtitleStyle,
    preset: 'pill',
    primaryColor: '#ffffff',
    outlineColor: '#090b11',
    backColor: '#7c3aed',
    outlineWidth: 1,
    shadow: 1,
    box: true,
    bold: true
  },
  minimal: {
    ...defaultSubtitleStyle,
    preset: 'minimal',
    primaryColor: '#ffffff',
    outlineColor: '#000000',
    backColor: '#000000',
    outlineWidth: 1,
    shadow: 0,
    box: false,
    bold: false
  }
};

const selectionTabs: Record<SelectionKind, InspectorTab> = {
  silence: 'silences',
  subtitle: 'subtitles',
  asset: 'assets',
  zoom: 'zooms',
  image_overlay: 'assets'
};

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
  async enqueue(videoId: string, type: 'waveform' | 'thumbnails' | 'detect-silence' | 'transcribe' | 'render', payload: Record<string, unknown> = {}) {
    const response = await fetch(`/api/videos/${videoId}/jobs/${type}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!response.ok) throw new Error((await response.json()).error ?? 'Job failed');
    return response.json();
  },
  async regenerateSubtitles(videoId: string, settings: SubtitleGenerationSettings) {
    const response = await fetch(`/api/videos/${videoId}/subtitles/regenerate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings)
    });
    if (!response.ok) throw new Error((await response.json()).error ?? 'Subtitle regeneration failed');
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
  },
  async deleteAsset(assetId: string) {
    const response = await fetch(`/api/assets/${assetId}`, { method: 'DELETE' });
    if (!response.ok) throw new Error((await response.json()).error ?? 'Asset delete failed');
  }
};

function App() {
  const [videos, setVideos] = useState<ApiVideo[]>([]);
  const [state, setState] = useState<ApiState | null>(null);
  const [activeTab, setActiveTab] = useState<InspectorTab>(() => initialInspectorTab());
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [currentMs, setCurrentMs] = useState(0);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [aspect, setAspect] = useState<AspectRatio>('9:16');
  const [selection, setSelection] = useState<SelectionTarget>(null);
  const [timelineScale, setTimelineScale] = useState(1.4);
  const [undoStack, setUndoStack] = useState<EditorHistorySnapshot[]>([]);
  const [redoStack, setRedoStack] = useState<EditorHistorySnapshot[]>([]);
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

  useEffect(() => {
    setSelection(null);
    setCurrentMs(0);
    setUndoStack([]);
    setRedoStack([]);
  }, [state?.video.id]);

  const latestJob = state?.jobs[0];
  const latestRender = state?.renders[0];
  const mediaUrl = state?.video.renderUrl || state?.video.proxyUrl || state?.video.originalUrl || '';
  const enabledCuts = state?.silences.filter((segment) => segment.action === 'cut').length ?? 0;
  const activeSubtitle = useMemo(() => {
    if (!state) return null;
    return state.subtitles.find((cue) => currentMs >= cue.startMs && currentMs <= cue.endMs) ?? null;
  }, [state, currentMs]);
  const activePreviewAssets = useMemo(() => (
    state ? previewAssetLayers(state, currentMs, selection) : []
  ), [state, currentMs, selection]);
  const activeZoomScale = useMemo(() => (
    state ? previewZoomScale(state.timeline, currentMs, selection) : 1
  ), [state, currentMs, selection]);

  function selectTarget(target: SelectionTarget) {
    setSelection(target);
    if (target) setActiveTab(selectionTabs[target.kind]);
  }

  async function runAction(label: string, action: () => Promise<void>) {
    setBusy(label);
    setError('');
    try {
      await action();
      await refresh(state?.video.id);
      return true;
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
      return false;
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
    const before = snapshotEditorState(state);
    const didSave = await runAction('Guardando subtitulos', async () => {
      await api.patch(`/api/videos/${state.video.id}/subtitles`, items);
    });
    if (didSave) rememberSnapshot(before);
  }

  async function regenerateSubtitles(settings: SubtitleGenerationSettings) {
    if (!state) return;
    await runAction('Regenerando subtitulos', async () => {
      await api.regenerateSubtitles(state.video.id, settings);
    });
  }

  async function saveSilences(items: SilenceSegment[]) {
    if (!state) return;
    const before = snapshotEditorState(state);
    const didSave = await runAction('Guardando silencios', async () => {
      await api.patch(`/api/videos/${state.video.id}/silences`, items);
    });
    if (didSave) rememberSnapshot(before);
  }

  async function saveTimeline(items: TimelineEvent[]) {
    if (!state) return;
    const before = snapshotEditorState(state);
    const didSave = await runAction('Guardando timeline', async () => {
      await api.patch(`/api/videos/${state.video.id}/timeline`, items);
    });
    if (didSave) rememberSnapshot(before);
  }

  async function runPipelineStep(type: 'waveform' | 'thumbnails' | 'detect-silence' | 'transcribe') {
    if (!state) return;
    await runAction(`Regenerando ${type}`, async () => {
      const payload = type === 'detect-silence' ? { ...defaultSilenceDetectRequest, source: 'manual_retry' } : { source: 'manual_retry' };
      await api.enqueue(state.video.id, type, payload);
    });
  }

  function rememberSnapshot(snapshot: EditorHistorySnapshot) {
    setUndoStack((current) => {
      const latest = current.at(-1);
      if (latest && sameSnapshot(latest, snapshot)) return current;
      return [...current.slice(-29), snapshot];
    });
    setRedoStack([]);
  }

  async function restoreSnapshot(label: string, snapshot: EditorHistorySnapshot) {
    if (!state) return false;
    return runAction(label, async () => {
      await Promise.all([
        api.patch(`/api/videos/${state.video.id}/silences`, snapshot.silences),
        api.patch(`/api/videos/${state.video.id}/subtitles`, snapshot.subtitles),
        api.patch(`/api/videos/${state.video.id}/timeline`, snapshot.timeline)
      ]);
    });
  }

  async function undoEdit() {
    if (!state || !undoStack.length) return;
    const snapshot = undoStack[undoStack.length - 1];
    const current = snapshotEditorState(state);
    setUndoStack((stack) => stack.slice(0, -1));
    setRedoStack((stack) => [...stack.slice(-29), current]);
    const didRestore = await restoreSnapshot('Deshaciendo edicion', snapshot);
    if (!didRestore) {
      setUndoStack((stack) => [...stack, snapshot]);
      setRedoStack((stack) => stack.slice(0, -1));
    }
  }

  async function redoEdit() {
    if (!state || !redoStack.length) return;
    const snapshot = redoStack[redoStack.length - 1];
    const current = snapshotEditorState(state);
    setRedoStack((stack) => stack.slice(0, -1));
    setUndoStack((stack) => [...stack.slice(-29), current]);
    const didRestore = await restoreSnapshot('Rehaciendo edicion', snapshot);
    if (!didRestore) {
      setRedoStack((stack) => [...stack, snapshot]);
      setUndoStack((stack) => stack.slice(0, -1));
    }
  }

  function deleteSelection() {
    if (!state || !selection) return;
    if (selection.kind === 'silence') {
      void saveSilences(state.silences.filter((item) => item.id !== selection.id));
      setSelection(null);
      return;
    }
    if (selection.kind === 'subtitle') {
      void saveSubtitles(state.subtitles.filter((item) => item.id !== selection.id));
      setSelection(null);
      return;
    }
    if (selection.kind === 'zoom' || selection.kind === 'image_overlay') {
      void saveTimeline(state.timeline.filter((item) => item.id !== selection.id));
      setSelection(null);
    }
  }

  function splitSelectionAtPlayhead() {
    if (!state || !selection) return;
    if (selection.kind === 'silence') {
      const target = state.silences.find((item) => item.id === selection.id);
      const splitMs = target ? splitPointForRange(target.startMs, target.endMs, currentMs) : null;
      if (!target || splitMs === null) return;
      const secondId = clientId();
      const next: SilenceSegment[] = state.silences.flatMap((item) => {
        if (item.id !== target.id) return [item];
        return [
          { ...item, endMs: splitMs, durationMs: splitMs - item.startMs },
          { ...item, id: secondId, startMs: splitMs, durationMs: item.endMs - splitMs }
        ];
      });
      void saveSilences(next);
      setSelection({ kind: 'silence', id: secondId });
      seek(splitMs);
      return;
    }
    if (selection.kind === 'subtitle') {
      const target = state.subtitles.find((item) => item.id === selection.id);
      const splitMs = target ? splitPointForRange(target.startMs, target.endMs, currentMs) : null;
      if (!target || splitMs === null) return;
      const secondId = clientId();
      const [firstText, secondText] = splitSubtitleText(target.text, (splitMs - target.startMs) / Math.max(1, target.endMs - target.startMs));
      const next: SubtitleCue[] = state.subtitles.flatMap((item) => {
        if (item.id !== target.id) return [item];
        return [
          { ...item, text: firstText || item.text, endMs: splitMs },
          { ...item, id: secondId, text: secondText || item.text, startMs: splitMs }
        ];
      });
      void saveSubtitles(next);
      setSelection({ kind: 'subtitle', id: secondId });
      seek(splitMs);
      return;
    }
    if (selection.kind === 'zoom' || selection.kind === 'image_overlay') {
      const target = state.timeline.find((item) => item.id === selection.id);
      const splitMs = target ? splitPointForRange(target.startMs, target.endMs, currentMs) : null;
      if (!target || splitMs === null) return;
      const secondId = clientId();
      const next: TimelineEvent[] = state.timeline.flatMap((item) => {
        if (item.id !== target.id) return [item];
        return [
          { ...item, endMs: splitMs },
          { ...item, id: secondId, startMs: splitMs }
        ];
      });
      void saveTimeline(next);
      setSelection({ kind: selection.kind, id: secondId });
      seek(splitMs);
    }
  }

  function nudgeTimelineScale(delta: number) {
    setTimelineScale((value) => clamp(value + delta, 1, 5));
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) void redoEdit();
        else void undoEdit();
        return;
      }
      if (event.code === 'Space') {
        event.preventDefault();
        if (videoRef.current?.paused) void videoRef.current.play();
        else videoRef.current?.pause();
        return;
      }
      if (event.key.toLowerCase() === 's' && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        splitSelectionAtPlayhead();
        return;
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        deleteSelection();
        return;
      }
      if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        nudgeTimelineScale(0.25);
        return;
      }
      if (event.key === '-' || event.key === '_') {
        event.preventDefault();
        nudgeTimelineScale(-0.25);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [state, selection, currentMs, undoStack, redoStack]);

  return (
    <main className="studio-shell">
      <TopBar
        state={state}
        latestJob={latestJob}
        aspect={aspect}
        setAspect={setAspect}
        busy={busy}
        onDetectSilence={() => state && runAction('Detectando silencios', async () => {
          await api.enqueue(state.video.id, 'detect-silence', defaultSilenceDetectRequest);
        })}
        onTranscribe={() => state && runAction('Transcribiendo', async () => {
          await api.enqueue(state.video.id, 'transcribe');
        })}
        onRender={() => state && runAction('Renderizando', async () => {
          await api.enqueue(state.video.id, 'render', { aspectRatio: aspect, resolution: aspectPresets[aspect].resolution });
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
          {state && (
            <PipelinePanel
              state={state}
              uploadProgress={uploadProgress}
              onRunStep={runPipelineStep}
            />
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
                activeAssets={activePreviewAssets}
                activeZoomScale={activeZoomScale}
                selection={selection}
                onSelect={selectTarget}
                onSeek={seek}
                onTimeUpdate={setCurrentMs}
                onSaveAsset={async (asset) => {
                  await api.patchAsset(asset);
                  await refresh(state.video.id);
                }}
              />
              <Timeline
                state={state}
                currentMs={currentMs}
                selection={selection}
                timelineScale={timelineScale}
                canUndo={undoStack.length > 0}
                canRedo={redoStack.length > 0}
                onSelect={selectTarget}
                onSeek={seek}
                onTimelineScale={setTimelineScale}
                onUndo={undoEdit}
                onRedo={redoEdit}
                onSplit={splitSelectionAtPlayhead}
                onDelete={deleteSelection}
                onSaveSubtitles={saveSubtitles}
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
          selection={selection}
          onSelect={selectTarget}
          busy={busy}
          onSeek={seek}
          onSaveTranscript={saveTranscript}
          onSaveSubtitles={saveSubtitles}
          onRegenerateSubtitles={regenerateSubtitles}
          onSaveSilences={saveSilences}
          onSaveTimeline={saveTimeline}
          onUploadAsset={api.uploadAsset}
          onSaveAsset={api.patchAsset}
          onDeleteAsset={api.deleteAsset}
          onRefresh={() => state ? refresh(state.video.id) : Promise.resolve()}
          onDetectSilence={(settings) => state && runAction('Detectando silencios', async () => {
            await api.enqueue(state.video.id, 'detect-silence', settings);
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
          {(Object.keys(aspectPresets) as AspectRatio[]).map((item) => (
            <button key={item} className={aspect === item ? 'is-active' : ''} onClick={() => setAspect(item)}>
              {aspectPresets[item].label}
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

function PipelinePanel({
  state,
  uploadProgress,
  onRunStep
}: {
  state: ApiState;
  uploadProgress: number | null;
  onRunStep: (type: 'waveform' | 'thumbnails' | 'detect-silence' | 'transcribe') => void;
}) {
  const jobsByType = new Map<string, VideoJob>();
  for (const job of state.jobs) {
    if (!jobsByType.has(job.type)) jobsByType.set(job.type, job);
  }
  const steps = pipelineSteps(state, jobsByType, uploadProgress);
  return (
    <div className="pipeline-panel">
      {steps.map((step) => (
        <div key={step.key} className={`pipeline-step ${step.status}`}>
          <i />
          <span>{step.label}</span>
          <strong>{step.detail}</strong>
          {step.action && (step.status === 'failed' || step.status === 'idle') && (
            <button onClick={() => onRunStep(step.action!)}>{step.status === 'failed' ? 'Reintentar' : 'Regenerar'}</button>
          )}
        </div>
      ))}
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
  activeZoomScale,
  selection,
  onSelect,
  onSeek,
  onTimeUpdate,
  onSaveAsset
}: {
  state: ApiState;
  mediaUrl: string;
  videoRef: React.MutableRefObject<HTMLVideoElement | null>;
  currentMs: number;
  aspect: AspectRatio;
  activeSubtitle: SubtitleCue | null;
  activeAssets: PreviewAssetLayer[];
  activeZoomScale: number;
  selection: SelectionTarget;
  onSelect: (target: SelectionTarget) => void;
  onSeek: (ms: number) => void;
  onTimeUpdate: (ms: number) => void;
  onSaveAsset: (asset: ApiAsset) => Promise<void>;
}) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [dragDraft, setDragDraft] = useState<Record<string, ApiAsset['position']>>({});
  const preset = aspectPresets[aspect];
  const zoomScale = clamp(activeZoomScale, 1, 2.5);

  function layerPosition(layer: PreviewAssetLayer) {
    return dragDraft[layer.asset.id] ?? layer.asset.position;
  }

  function startAssetDrag(event: React.PointerEvent<HTMLImageElement>, layer: PreviewAssetLayer) {
    event.preventDefault();
    event.stopPropagation();
    onSelect(layer.selection);
    if (event.button !== 0 || !frameRef.current) return;
    const rect = frameRef.current.getBoundingClientRect();
    const original = layerPosition(layer);
    let latest = original;

    const update = (clientX: number, clientY: number) => {
      latest = {
        ...original,
        x: clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1),
        y: clamp((clientY - rect.top) / Math.max(1, rect.height), 0, 1)
      };
      setDragDraft((current) => ({ ...current, [layer.asset.id]: latest }));
    };

    const handleMove = (moveEvent: PointerEvent) => update(moveEvent.clientX, moveEvent.clientY);
    const handleUp = () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      void onSaveAsset({ ...layer.asset, position: latest }).finally(() => {
        setDragDraft((current) => {
          const next = { ...current };
          delete next[layer.asset.id];
          return next;
        });
      });
    };

    update(event.clientX, event.clientY);
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp, { once: true });
  }

  return (
    <section className="preview-panel">
      <nav className="workspace-tabs">
        {['Vista previa', 'Transcript', 'Subtitulos', 'Silencios', 'Zooms', 'PNGs'].map((item, index) => (
          <button key={item} className={index === 0 ? 'is-active' : ''}>{item}</button>
        ))}
      </nav>
      <div className="preview-stage">
        <span className="resolution-chip">{preset.resolution}</span>
        <div
          ref={frameRef}
          className={`video-frame aspect-${aspect.replace(':', '-')}`}
          style={{ '--zoom-scale': zoomScale } as React.CSSProperties}
        >
          {mediaUrl ? (
            <div className="video-layer">
              <video
                ref={videoRef}
                src={mediaUrl}
                onTimeUpdate={(event) => onTimeUpdate(event.currentTarget.currentTime * 1000)}
              />
            </div>
          ) : (
            <div className="video-placeholder">Procesando preview...</div>
          )}
          <div className="safe-guides" aria-hidden="true">
            <i className="safe-action" />
            <i className="safe-title" />
            <b />
          </div>
          {zoomScale > 1.01 && <span className="zoom-preview-chip">{zoomScale.toFixed(2)}x</span>}
          {activeSubtitle && (
            <div
              className={`subtitle-preview position-${activeSubtitle.style.position} ${activeSubtitle.style.box ? 'has-box' : ''}`}
              style={subtitlePreviewStyle(activeSubtitle.style)}
            >
              {activeSubtitle.style.uppercase ? activeSubtitle.text.toUpperCase() : activeSubtitle.text}
            </div>
          )}
          {activeAssets.map((layer) => {
            const position = layerPosition(layer);
            const isSelected = selection?.kind === layer.selection.kind && selection.id === layer.selection.id;
            return (
              <img
                key={layer.id}
                className={`asset-preview ${isSelected ? 'is-selected' : ''}`}
                src={layer.asset.fileUrl ?? ''}
                onPointerDown={(event) => startAssetDrag(event, layer)}
                style={{
                  left: `${position.x * 100}%`,
                  top: `${position.y * 100}%`,
                  transform: `translate(-50%, -50%) scale(${position.scale})`
                }}
              />
            );
          })}
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
  selection,
  timelineScale,
  canUndo,
  canRedo,
  onSelect,
  onSeek,
  onTimelineScale,
  onUndo,
  onRedo,
  onSplit,
  onDelete,
  onSaveSubtitles,
  onSaveSilences,
  onSaveTimeline
}: {
  state: ApiState;
  currentMs: number;
  selection: SelectionTarget;
  timelineScale: number;
  canUndo: boolean;
  canRedo: boolean;
  onSelect: (target: SelectionTarget) => void;
  onSeek: (ms: number) => void;
  onTimelineScale: (scale: number) => void;
  onUndo: () => void;
  onRedo: () => void;
  onSplit: () => void;
  onDelete: () => void;
  onSaveSubtitles: (items: SubtitleCue[]) => Promise<void>;
  onSaveSilences: (items: SilenceSegment[]) => Promise<void>;
  onSaveTimeline: (items: TimelineEvent[]) => Promise<void>;
}) {
  const duration = Math.max(state.video.durationMs, 1);
  const rulerRef = useRef<HTMLDivElement | null>(null);
  const [draftEdits, setDraftEdits] = useState<Record<string, { startMs: number; endMs: number }>>({});
  const zooms = state.timeline.filter((event) => event.type === 'zoom');
  const imageEvents = state.timeline.filter((event) => event.type === 'image_overlay');
  const clampedScale = clamp(timelineScale, 1, 5);

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

  function timelineMs(event: React.MouseEvent<HTMLDivElement>) {
    const target = event.currentTarget;
    const rect = target.getBoundingClientRect();
    const trackWidth = timelineTrackWidth(target);
    const x = event.clientX - rect.left + target.scrollLeft - timelineLabelWidth;
    return clamp((x / trackWidth) * duration, 0, duration);
  }

  function editKey(kind: SelectionKind | 'timeline', id: string) {
    return `${kind}:${id}`;
  }

  function rangeFor(kind: SelectionKind | 'timeline', id: string, startMs: number, endMs: number) {
    return draftEdits[editKey(kind, id)] ?? { startMs, endMs };
  }

  function commitRange(target: { kind: SelectionKind | 'timeline'; id: string }, next: { startMs: number; endMs: number }) {
    if (target.kind === 'silence') {
      void onSaveSilences(state.silences.map((item) => item.id === target.id ? {
        ...item,
        startMs: next.startMs,
        endMs: next.endMs,
        durationMs: next.endMs - next.startMs
      } : item));
      return;
    }
    if (target.kind === 'subtitle') {
      void onSaveSubtitles(state.subtitles.map((item) => item.id === target.id ? { ...item, startMs: next.startMs, endMs: next.endMs } : item));
      return;
    }
    void onSaveTimeline(state.timeline.map((event) => event.id === target.id ? { ...event, startMs: next.startMs, endMs: next.endMs } : event));
  }

  function startDrag(
    event: React.PointerEvent<HTMLElement>,
    target: { kind: SelectionKind | 'timeline'; id: string; startMs: number; endMs: number; selection: SelectionTarget },
    mode: DragMode
  ) {
    event.preventDefault();
    event.stopPropagation();
    onSelect(target.selection);
    onSeek(target.startMs);
    if (event.button !== 0 || !rulerRef.current) return;
    const ruler = rulerRef.current;
    const startClientX = event.clientX;
    const original = { startMs: target.startMs, endMs: target.endMs };
    const key = editKey(target.kind, target.id);
    let latest = original;
    let moved = false;

    const update = (clientX: number) => {
      const deltaMs = ((clientX - startClientX) / timelineTrackWidth(ruler)) * duration;
      moved = moved || Math.abs(deltaMs) > 18;
      latest = clampRange(applyDrag(original, deltaMs, mode), duration);
      setDraftEdits((current) => ({ ...current, [key]: latest }));
    };

    const handleMove = (moveEvent: PointerEvent) => update(moveEvent.clientX);
    const handleUp = () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      setDraftEdits((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      if (moved) commitRange(target, latest);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp, { once: true });
  }

  function segmentButton(
    target: { kind: SelectionKind | 'timeline'; id: string; startMs: number; endMs: number; selection: SelectionTarget },
    className: string,
    label?: string
  ) {
    const range = rangeFor(target.kind, target.id, target.startMs, target.endMs);
    const isSelected = selection?.id === target.selection?.id && selection?.kind === target.selection?.kind;
    return (
      <button
        key={`${target.kind}-${target.id}`}
        type="button"
        className={`segment ${className} ${isSelected ? 'is-selected' : ''}`}
        style={segmentStyle(range.startMs, range.endMs, duration)}
        onPointerDown={(event) => startDrag(event, { ...target, startMs: range.startMs, endMs: range.endMs }, 'move')}
        title={`${formatDuration(range.startMs)} - ${formatDuration(range.endMs)}`}
      >
        <i onPointerDown={(event) => startDrag(event, { ...target, startMs: range.startMs, endMs: range.endMs }, 'start')} />
        {label}
        <i onPointerDown={(event) => startDrag(event, { ...target, startMs: range.startMs, endMs: range.endMs }, 'end')} />
      </button>
    );
  }

  return (
    <section className="timeline-panel">
      <div className="timeline-tools">
        <button disabled={!canUndo} onClick={onUndo}>Deshacer</button>
        <button disabled={!canRedo} onClick={onRedo}>Rehacer</button>
        <button disabled={!selection} onClick={onDelete}>Borrar</button>
        <button disabled={!selection} onClick={onSplit}>Dividir</button>
        <button onClick={addZoom}>Zoom en cursor</button>
        <label className="timeline-zoom-control">
          <span>Zoom timeline</span>
          <button type="button" onClick={() => onTimelineScale(clamp(clampedScale - 0.25, 1, 5))}>-</button>
          <input
            type="range"
            min="1"
            max="5"
            step="0.25"
            value={clampedScale}
            onChange={(event) => onTimelineScale(Number(event.target.value))}
          />
          <button type="button" onClick={() => onTimelineScale(clamp(clampedScale + 0.25, 1, 5))}>+</button>
          <strong>{clampedScale.toFixed(1)}x</strong>
        </label>
      </div>
      <div ref={rulerRef} className="time-ruler" onClick={(event) => onSeek(timelineMs(event))}>
        <div
          className="timeline-canvas"
          style={{
            width: `${Math.round(clampedScale * 100)}%`,
            '--playhead': String(clamp(currentMs / duration, 0, 1))
          } as React.CSSProperties}
        >
          <TimeTicks durationMs={duration} />
          <div className="playhead">
            <b>{formatDuration(currentMs)}</b>
          </div>
          <Lane label="Video">
            {state.thumbnails.length ? (
              <div className="thumbnail-strip">
                {state.thumbnails.map((thumbnail) => (
                  <img key={thumbnail.id} src={thumbnail.fileUrl ?? ''} alt="" />
                ))}
              </div>
            ) : (
              <div className="video-strip" />
            )}
          </Lane>
          <Lane label="Audio">
            {state.waveform.length ? <Waveform points={state.waveform} /> : <div className="waveform" />}
          </Lane>
          <Lane label="Silencios">
            {state.silences.map((segment) => segmentButton({
              kind: 'silence',
              id: segment.id,
              startMs: segment.startMs,
              endMs: segment.endMs,
              selection: { kind: 'silence', id: segment.id }
            }, `silence ${segment.action}`, segment.action))}
          </Lane>
          <Lane label="Subtitulos">
            {state.subtitles.map((cue) => segmentButton({
              kind: 'subtitle',
              id: cue.id,
              startMs: cue.startMs,
              endMs: cue.endMs,
              selection: { kind: 'subtitle', id: cue.id }
            }, 'subtitle', cue.text.slice(0, 24)))}
          </Lane>
          <Lane label="PNGs">
            {imageEvents.map((event) => {
              const asset = state.assets.find((item) => item.id === event.payload.assetId);
              return segmentButton({
                kind: 'timeline',
                id: event.id,
                startMs: event.startMs,
                endMs: event.endMs,
                selection: { kind: 'image_overlay', id: event.id }
              }, `asset-event-segment ${event.enabled ? '' : 'is-off'}`, asset?.label ?? 'Overlay');
            })}
            {state.assets.map((asset, index) => (
              <button key={asset.id} className={`asset-event ${selection?.kind === 'asset' && selection.id === asset.id ? 'is-selected' : ''}`} style={{ left: `${Math.min(92, 8 + index * 11)}%` }} onClick={(event) => {
                event.stopPropagation();
                onSelect({ kind: 'asset', id: asset.id });
              }}>
                {asset.triggerWords[0] ?? asset.label}
              </button>
            ))}
          </Lane>
          <Lane label="Zooms">
            {zooms.map((event) => segmentButton({
              kind: 'timeline',
              id: event.id,
              startMs: event.startMs,
              endMs: event.endMs,
              selection: { kind: 'zoom', id: event.id }
            }, `zoom ${event.enabled ? '' : 'is-off'}`, `${Number(event.payload.scale ?? 1.18).toFixed(2)}x`))}
          </Lane>
        </div>
      </div>
    </section>
  );
}

function TimeTicks({ durationMs }: { durationMs: number }) {
  const interval = timelineTickInterval(durationMs);
  const ticks: number[] = [];
  for (let ms = 0; ms < durationMs; ms += interval) ticks.push(ms);
  if (!ticks.length || ticks[ticks.length - 1] !== durationMs) ticks.push(durationMs);
  return (
    <div className="timeline-ticks">
      <span />
      <div>
        {ticks.map((tick) => (
          <i key={tick} style={{ left: `${(tick / Math.max(1, durationMs)) * 100}%` }}>
            {formatDuration(tick)}
          </i>
        ))}
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

function Waveform({ points }: { points: WaveformPoint[] }) {
  const peak = Math.max(0.08, ...points.map((point) => point.amplitude));
  return (
    <div className="waveform-real">
      {points.map((point) => (
        <i
          key={point.id}
          style={{
            height: `${Math.max(8, (point.amplitude / peak) * 100)}%`
          }}
        />
      ))}
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
  selection,
  onSelect,
  busy,
  onSeek,
  onSaveTranscript,
  onSaveSubtitles,
  onRegenerateSubtitles,
  onSaveSilences,
  onSaveTimeline,
  onUploadAsset,
  onSaveAsset,
  onDeleteAsset,
  onRefresh,
  onDetectSilence
}: {
  state: ApiState | null;
  activeTab: InspectorTab;
  setActiveTab: (tab: InspectorTab) => void;
  latestRender?: ApiRender;
  enabledCuts: number;
  currentMs: number;
  selection: SelectionTarget;
  onSelect: (target: SelectionTarget) => void;
  busy: string;
  onSeek: (ms: number) => void;
  onSaveTranscript: (items: TranscriptSegment[]) => Promise<void>;
  onSaveSubtitles: (items: SubtitleCue[]) => Promise<void>;
  onRegenerateSubtitles: (settings: SubtitleGenerationSettings) => Promise<void>;
  onSaveSilences: (items: SilenceSegment[]) => Promise<void>;
  onSaveTimeline: (items: TimelineEvent[]) => Promise<void>;
  onUploadAsset: (videoId: string, file: File, label: string, triggerWords: string) => Promise<unknown>;
  onSaveAsset: (asset: ApiAsset) => Promise<unknown>;
  onDeleteAsset: (assetId: string) => Promise<void>;
  onRefresh: () => Promise<void>;
  onDetectSilence: (settings: SilenceDetectRequest) => void;
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
          {selection && (
            <SelectionInspector
              state={state}
              selection={selection}
              currentMs={currentMs}
              onSelect={onSelect}
              onSeek={onSeek}
              onSaveSubtitles={onSaveSubtitles}
              onSaveSilences={onSaveSilences}
              onSaveTimeline={onSaveTimeline}
              onSaveAsset={onSaveAsset}
              onDeleteAsset={onDeleteAsset}
              onRefresh={onRefresh}
            />
          )}
          {activeTab === 'transcript' && <TranscriptEditor state={state} onSave={onSaveTranscript} onSeek={onSeek} />}
          {activeTab === 'subtitles' && <SubtitleEditor state={state} onSave={onSaveSubtitles} onRegenerate={onRegenerateSubtitles} onSeek={onSeek} />}
          {activeTab === 'silences' && <SilenceEditor state={state} busy={busy} onSave={onSaveSilences} onDetect={onDetectSilence} />}
          {activeTab === 'assets' && <AssetEditor state={state} onUploadAsset={onUploadAsset} onSaveAsset={onSaveAsset} onRefresh={onRefresh} />}
          {activeTab === 'zooms' && <ZoomEditor state={state} currentMs={currentMs} onSave={onSaveTimeline} />}
        </>
      )}
    </aside>
  );
}

function SelectionInspector({
  state,
  selection,
  currentMs,
  onSelect,
  onSeek,
  onSaveSubtitles,
  onSaveSilences,
  onSaveTimeline,
  onSaveAsset,
  onDeleteAsset,
  onRefresh
}: {
  state: ApiState;
  selection: NonNullable<SelectionTarget>;
  currentMs: number;
  onSelect: (target: SelectionTarget) => void;
  onSeek: (ms: number) => void;
  onSaveSubtitles: (items: SubtitleCue[]) => Promise<void>;
  onSaveSilences: (items: SilenceSegment[]) => Promise<void>;
  onSaveTimeline: (items: TimelineEvent[]) => Promise<void>;
  onSaveAsset: (asset: ApiAsset) => Promise<unknown>;
  onDeleteAsset: (assetId: string) => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const duration = Math.max(state.video.durationMs, 1);

  if (selection.kind === 'silence') {
    const item = state.silences.find((segment) => segment.id === selection.id);
    if (!item) return null;
    const save = (patch: Partial<SilenceSegment>) => onSaveSilences(state.silences.map((segment) => segment.id === item.id ? {
      ...segment,
      ...patch,
      durationMs: Math.max(0, Number(patch.endMs ?? segment.endMs) - Number(patch.startMs ?? segment.startMs))
    } : segment));
    return (
      <div className="selection-card">
        <PanelHead title="Corte seleccionado" action="Cerrar" onAction={() => onSelect(null)} />
        <TimeRangeFields startMs={item.startMs} endMs={item.endMs} durationMs={duration} onChange={(range) => save(range)} />
        <div className="selection-actions">
          <button onClick={() => onSeek(item.startMs)}>Ir al corte</button>
          <button onClick={() => save({ action: item.action === 'cut' ? 'keep' : 'cut' })}>{item.action === 'cut' ? 'Mantener' : 'Cortar'}</button>
          <button onClick={() => {
            onSaveSilences(state.silences.filter((segment) => segment.id !== item.id));
            onSelect(null);
          }}>Borrar</button>
        </div>
      </div>
    );
  }

  if (selection.kind === 'subtitle') {
    const cue = state.subtitles.find((item) => item.id === selection.id);
    if (!cue) return null;
    const save = (patch: Partial<SubtitleCue>) => onSaveSubtitles(state.subtitles.map((item) => item.id === cue.id ? { ...item, ...patch } : item));
    return (
      <div className="selection-card">
        <PanelHead title="Subtitulo seleccionado" action="Cerrar" onAction={() => onSelect(null)} />
        <textarea defaultValue={cue.text} onBlur={(event) => save({ text: event.target.value })} />
        <TimeRangeFields startMs={cue.startMs} endMs={cue.endMs} durationMs={duration} onChange={(range) => save(range)} />
        <InspectorField label="Tamano">
          <input type="range" min="20" max="86" defaultValue={cue.style.fontSize} onChange={(event) => save({ style: { ...cue.style, fontSize: Number(event.target.value) } })} />
          <strong>{cue.style.fontSize}px</strong>
        </InspectorField>
        <div className="selection-actions">
          <button onClick={() => onSeek(cue.startMs)}>Ir</button>
          <button onClick={() => onSaveSubtitles([...state.subtitles, { ...cue, id: clientId(), startMs: Math.min(duration - 300, cue.endMs + 120), endMs: Math.min(duration, cue.endMs + Math.max(500, cue.endMs - cue.startMs) + 120) }])}>Duplicar</button>
          <button onClick={() => {
            onSaveSubtitles(state.subtitles.filter((item) => item.id !== cue.id));
            onSelect(null);
          }}>Borrar</button>
        </div>
      </div>
    );
  }

  if (selection.kind === 'asset') {
    const asset = state.assets.find((item) => item.id === selection.id);
    if (!asset) return null;
    const saveAsset = async (patch: Partial<ApiAsset>) => {
      await onSaveAsset({ ...asset, ...patch });
      await onRefresh();
    };
    return (
      <div className="selection-card">
        <PanelHead title="PNG seleccionado" action="Cerrar" onAction={() => onSelect(null)} />
        {asset.fileUrl && <img className="selection-thumb" src={asset.fileUrl} />}
        <input defaultValue={asset.label} onBlur={(event) => saveAsset({ label: event.target.value })} />
        <input defaultValue={asset.triggerWords.join(', ')} onBlur={(event) => saveAsset({ triggerWords: parseWords(event.target.value) })} />
        <PositionFields asset={asset} onChange={(position) => saveAsset({ position })} />
        <div className="selection-actions">
          <button onClick={() => {
            const startMs = Math.max(0, currentMs);
            const event: TimelineEvent = {
              id: clientId(),
              videoId: state.video.id,
              type: 'image_overlay',
              startMs,
              endMs: Math.min(duration, startMs + 1600),
              enabled: true,
              payload: { assetId: asset.id }
            };
            onSaveTimeline([...state.timeline, event]);
            onSelect({ kind: 'image_overlay', id: event.id });
          }}>Crear overlay</button>
          <button onClick={async () => {
            await onDeleteAsset(asset.id);
            onSelect(null);
            await onRefresh();
          }}>Borrar asset</button>
        </div>
      </div>
    );
  }

  const event = state.timeline.find((item) => item.id === selection.id);
  if (!event) return null;
  const saveEvent = (patch: Partial<TimelineEvent>) => onSaveTimeline(state.timeline.map((item) => item.id === event.id ? { ...item, ...patch } : item));
  const title = event.type === 'zoom' ? 'Zoom seleccionado' : 'Overlay seleccionado';
  const selectedAsset = event.type === 'image_overlay' ? state.assets.find((asset) => asset.id === event.payload.assetId) : null;

  return (
    <div className="selection-card">
      <PanelHead title={title} action="Cerrar" onAction={() => onSelect(null)} />
      <TimeRangeFields startMs={event.startMs} endMs={event.endMs} durationMs={duration} onChange={(range) => saveEvent(range)} />
      {event.type === 'zoom' ? (
        <InspectorField label="Escala">
          <input type="range" min="1" max="2.5" step="0.01" defaultValue={Number(event.payload.scale ?? 1.18)} onChange={(input) => saveEvent({ payload: { ...event.payload, scale: Number(input.target.value) } })} />
          <strong>{Number(event.payload.scale ?? 1.18).toFixed(2)}x</strong>
        </InspectorField>
      ) : (
        <InspectorField label="Asset">
          <select value={String(event.payload.assetId ?? '')} onChange={(input) => saveEvent({ payload: { ...event.payload, assetId: input.target.value } })}>
            {state.assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.label}</option>)}
          </select>
          <strong>{selectedAsset?.label ?? 'sin asset'}</strong>
        </InspectorField>
      )}
      <div className="selection-actions">
        <button onClick={() => onSeek(event.startMs)}>Ir</button>
        <button onClick={() => saveEvent({ enabled: !event.enabled })}>{event.enabled ? 'Desactivar' : 'Activar'}</button>
        <button onClick={() => onSaveTimeline([...state.timeline, { ...event, id: clientId(), startMs: Math.min(duration - 300, event.endMs + 120), endMs: Math.min(duration, event.endMs + Math.max(500, event.endMs - event.startMs) + 120) }])}>Duplicar</button>
        <button onClick={() => {
          onSaveTimeline(state.timeline.filter((item) => item.id !== event.id));
          onSelect(null);
        }}>Borrar</button>
      </div>
    </div>
  );
}

function TimeRangeFields({
  startMs,
  endMs,
  durationMs,
  onChange
}: {
  startMs: number;
  endMs: number;
  durationMs: number;
  onChange: (range: { startMs: number; endMs: number }) => void;
}) {
  return (
    <div className="time-fields">
      <label>
        <span>Inicio</span>
        <input key={`start-${startMs}`} type="number" step="0.01" defaultValue={(startMs / 1000).toFixed(2)} onBlur={(event) => onChange(clampRange({ startMs: Number(event.target.value) * 1000, endMs }, durationMs))} />
      </label>
      <label>
        <span>Fin</span>
        <input key={`end-${endMs}`} type="number" step="0.01" defaultValue={(endMs / 1000).toFixed(2)} onBlur={(event) => onChange(clampRange({ startMs, endMs: Number(event.target.value) * 1000 }, durationMs))} />
      </label>
    </div>
  );
}

function PositionFields({ asset, onChange }: { asset: ApiAsset; onChange: (position: ApiAsset['position']) => void }) {
  const position = asset.position;
  const save = (patch: Partial<ApiAsset['position']>) => onChange({ ...position, ...patch });
  return (
    <div className="position-fields">
      <InspectorField label="X">
        <input type="range" min="0" max="1" step="0.01" defaultValue={position.x} onChange={(event) => save({ x: Number(event.target.value) })} />
        <strong>{Math.round(position.x * 100)}%</strong>
      </InspectorField>
      <InspectorField label="Y">
        <input type="range" min="0" max="1" step="0.01" defaultValue={position.y} onChange={(event) => save({ y: Number(event.target.value) })} />
        <strong>{Math.round(position.y * 100)}%</strong>
      </InspectorField>
      <InspectorField label="Escala">
        <input type="range" min="0.25" max="4" step="0.05" defaultValue={position.scale} onChange={(event) => save({ scale: Number(event.target.value) })} />
        <strong>{position.scale.toFixed(2)}x</strong>
      </InspectorField>
    </div>
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

function SubtitleEditor({
  state,
  onSave,
  onRegenerate,
  onSeek
}: {
  state: ApiState;
  onSave: (items: SubtitleCue[]) => Promise<void>;
  onRegenerate: (settings: SubtitleGenerationSettings) => Promise<void>;
  onSeek: (ms: number) => void;
}) {
  const [items, setItems] = useState(state.subtitles);
  const [wordsPerCue, setWordsPerCue] = useState(5);
  const [maxCharsPerCue, setMaxCharsPerCue] = useState(34);
  useEffect(() => setItems(state.subtitles), [state.subtitles]);
  const activeStyle = completeSubtitleStyle(items[0]?.style);
  const previewText = items[0]?.text ?? 'Subtitulo premium';
  const applyStyle = (patch: Partial<SubtitleStyle>) => {
    setItems((current) => current.map((item) => ({
      ...item,
      style: completeSubtitleStyle({ ...item.style, ...patch })
    })));
  };
  const applyPreset = (preset: SubtitleStyle['preset']) => {
    const next = subtitlePresets[preset];
    setItems((current) => current.map((item) => ({ ...item, style: next })));
  };
  const regenerate = () => onRegenerate({
    wordsPerCue,
    maxCharsPerCue,
    minCueMs: 700,
    maxCueMs: 2400,
    style: activeStyle
  });
  return (
    <div className="editor-list">
      <PanelHead title="Subtitulos" action="Guardar" onAction={() => onSave(items)} />
      <div className="subtitle-style-preview" style={subtitlePreviewStyle(activeStyle)}>
        {activeStyle.uppercase ? previewText.toUpperCase() : previewText}
      </div>
      <InspectorField label="Preset">
        <select value={activeStyle.preset} onChange={(event) => applyPreset(event.target.value as SubtitleStyle['preset'])}>
          <option value="bold">Bold blanco</option>
          <option value="yellow">Amarillo punch</option>
          <option value="neon">Neon Metamize</option>
          <option value="pill">Pill morada</option>
          <option value="minimal">Minimal</option>
        </select>
      </InspectorField>
      <div className="control-grid">
        <button className={activeStyle.position === 'top' ? 'is-active' : ''} onClick={() => applyStyle({ position: 'top' })}>Top</button>
        <button className={activeStyle.position === 'middle' ? 'is-active' : ''} onClick={() => applyStyle({ position: 'middle' })}>Middle</button>
        <button className={activeStyle.position === 'bottom' ? 'is-active' : ''} onClick={() => applyStyle({ position: 'bottom' })}>Bottom</button>
      </div>
      <InspectorField label="Tamano">
        <input type="range" min="24" max="88" value={activeStyle.fontSize} onChange={(event) => applyStyle({ fontSize: Number(event.target.value) })} />
        <strong>{activeStyle.fontSize}px</strong>
      </InspectorField>
      <InspectorField label="Texto">
        <input type="color" value={activeStyle.primaryColor} onChange={(event) => applyStyle({ primaryColor: event.target.value })} />
        <strong>{activeStyle.primaryColor}</strong>
      </InspectorField>
      <InspectorField label="Stroke">
        <input type="color" value={activeStyle.outlineColor} onChange={(event) => applyStyle({ outlineColor: event.target.value })} />
        <strong>{activeStyle.outlineWidth}px</strong>
      </InspectorField>
      <InspectorField label="Grosor">
        <input type="range" min="0" max="8" step="0.5" value={activeStyle.outlineWidth} onChange={(event) => applyStyle({ outlineWidth: Number(event.target.value) })} />
        <strong>{activeStyle.outlineWidth.toFixed(1)}</strong>
      </InspectorField>
      <InspectorField label="Fondo">
        <input type="color" value={activeStyle.backColor} onChange={(event) => applyStyle({ backColor: event.target.value })} />
        <strong>{activeStyle.box ? 'box' : 'off'}</strong>
      </InspectorField>
      <div className="control-grid">
        <button className={activeStyle.uppercase ? 'is-active' : ''} onClick={() => applyStyle({ uppercase: !activeStyle.uppercase })}>Uppercase</button>
        <button className={activeStyle.box ? 'is-active' : ''} onClick={() => applyStyle({ box: !activeStyle.box })}>Caja</button>
        <button className={activeStyle.bold ? 'is-active' : ''} onClick={() => applyStyle({ bold: !activeStyle.bold })}>Bold</button>
      </div>
      <InspectorField label="Palabras">
        <input type="range" min="2" max="9" value={wordsPerCue} onChange={(event) => setWordsPerCue(Number(event.target.value))} />
        <strong>{wordsPerCue}/cue</strong>
      </InspectorField>
      <InspectorField label="Caracteres">
        <input type="range" min="10" max="80" value={maxCharsPerCue} onChange={(event) => setMaxCharsPerCue(Number(event.target.value))} />
        <strong>{maxCharsPerCue}</strong>
      </InspectorField>
      <button disabled={!state.transcript.length} onClick={regenerate}>Regenerar desde transcript</button>
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
  onDetect: (settings: SilenceDetectRequest) => void;
}) {
  const latestSettings = useMemo(() => readLatestSilenceSettings(state.jobs), [state.jobs]);
  const [noiseDb, setNoiseDb] = useState(latestSettings.noiseDb);
  const [minDurationSec, setMinDurationSec] = useState(latestSettings.minDurationSec);
  const [paddingBeforeMs, setPaddingBeforeMs] = useState(latestSettings.paddingBeforeMs);
  const [paddingAfterMs, setPaddingAfterMs] = useState(latestSettings.paddingAfterMs);
  const [preserveBreaths, setPreserveBreaths] = useState(latestSettings.preserveBreaths);
  useEffect(() => {
    setNoiseDb(latestSettings.noiseDb);
    setMinDurationSec(latestSettings.minDurationSec);
    setPaddingBeforeMs(latestSettings.paddingBeforeMs);
    setPaddingAfterMs(latestSettings.paddingAfterMs);
    setPreserveBreaths(latestSettings.preserveBreaths);
  }, [latestSettings.noiseDb, latestSettings.minDurationSec, latestSettings.paddingBeforeMs, latestSettings.paddingAfterMs, latestSettings.preserveBreaths]);

  const settings = { noiseDb, minDurationSec, paddingBeforeMs, paddingAfterMs, preserveBreaths };
  const activeCuts = state.silences.filter((item) => item.action === 'cut');
  const totalCutMs = state.silences.filter((item) => item.action === 'cut').reduce((sum, item) => sum + item.durationMs, 0);
  const outputMs = Math.max(0, state.video.durationMs - totalCutMs);
  return (
    <div className="editor-list">
      <PanelHead title="Silencios" action="Detectar" onAction={() => onDetect(settings)} />
      <InspectorField label="Umbral dB">
        <input type="range" min="-60" max="-15" value={noiseDb} onChange={(event) => setNoiseDb(Number(event.target.value))} />
        <strong>{noiseDb} dB</strong>
      </InspectorField>
      <InspectorField label="Duracion minima">
        <input type="range" min="0.12" max="1.5" step="0.01" value={minDurationSec} onChange={(event) => setMinDurationSec(Number(event.target.value))} />
        <strong>{minDurationSec.toFixed(2)} s</strong>
      </InspectorField>
      <InspectorField label="Aire antes">
        <input type="range" min="0" max="600" step="10" value={paddingBeforeMs} onChange={(event) => setPaddingBeforeMs(Number(event.target.value))} />
        <strong>{paddingBeforeMs} ms</strong>
      </InspectorField>
      <InspectorField label="Aire despues">
        <input type="range" min="0" max="600" step="10" value={paddingAfterMs} onChange={(event) => setPaddingAfterMs(Number(event.target.value))} />
        <strong>{paddingAfterMs} ms</strong>
      </InspectorField>
      <label className="toggle-row">
        <input type="checkbox" checked={preserveBreaths} onChange={(event) => setPreserveBreaths(event.target.checked)} />
        <span>
          <strong>Respiraciones naturales</strong>
          <small>Deja un margen extra para que el corte no suene robotico.</small>
        </span>
      </label>
      <div className="metric-card">
        <span>Cortes activos</span>
        <strong>{activeCuts.length}</strong>
        <small>{formatDuration(totalCutMs)} removidos - final estimado {formatDuration(outputMs)}</small>
      </div>
      <div className="silence-actions">
        <button disabled={!!busy || !state.silences.length} onClick={() => onSave(state.silences.map((item) => ({ ...item, action: 'cut' })))}>Aplicar todos</button>
        <button disabled={!!busy || !state.silences.length} onClick={() => onSave(state.silences.map((item) => ({ ...item, action: 'keep' })))}>Restaurar todos</button>
      </div>
      {state.silences.map((segment) => (
        <button key={segment.id} className={`silence-row ${segment.action}`} onClick={() => onSave(state.silences.map((item) => item.id === segment.id ? { ...item, action: item.action === 'cut' ? 'keep' : 'cut' } : item))}>
          <span>
            <b>{formatDuration(segment.startMs)} - {formatDuration(segment.endMs)}</b>
            <small>{formatDuration(segment.durationMs)} detectado</small>
          </span>
          <strong>{segment.action === 'cut' ? 'cortar' : 'mantener'}</strong>
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

function applyDrag(range: { startMs: number; endMs: number }, deltaMs: number, mode: DragMode) {
  if (mode === 'start') return { ...range, startMs: range.startMs + deltaMs };
  if (mode === 'end') return { ...range, endMs: range.endMs + deltaMs };
  return { startMs: range.startMs + deltaMs, endMs: range.endMs + deltaMs };
}

function snapshotEditorState(state: ApiState): EditorHistorySnapshot {
  return {
    silences: state.silences.map((item) => ({ ...item })),
    subtitles: state.subtitles.map((item) => ({ ...item, style: { ...item.style } })),
    timeline: state.timeline.map((item) => ({ ...item, payload: { ...item.payload } }))
  };
}

function sameSnapshot(first: EditorHistorySnapshot, second: EditorHistorySnapshot) {
  return JSON.stringify(first) === JSON.stringify(second);
}

function timelineTrackWidth(ruler: HTMLElement) {
  return Math.max(1, ruler.scrollWidth - timelineLabelWidth - timelineRightPad);
}

function timelineTickInterval(durationMs: number) {
  const options = [1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000];
  const target = Math.max(1, durationMs / 8);
  return options.find((value) => value >= target) ?? options[options.length - 1];
}

function canSplitRange(startMs: number, endMs: number, splitMs: number) {
  return splitMs - startMs >= 160 && endMs - splitMs >= 160;
}

function splitPointForRange(startMs: number, endMs: number, preferredMs: number) {
  const preferred = Math.round(preferredMs);
  if (canSplitRange(startMs, endMs, preferred)) return preferred;
  const middle = Math.round(startMs + ((endMs - startMs) / 2));
  return canSplitRange(startMs, endMs, middle) ? middle : null;
}

function splitSubtitleText(text: string, ratio: number) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= 1) return [text, text];
  const splitIndex = Math.max(1, Math.min(words.length - 1, Math.round(words.length * clamp(ratio, 0.15, 0.85))));
  return [words.slice(0, splitIndex).join(' '), words.slice(splitIndex).join(' ')];
}

function clampRange(range: { startMs: number; endMs: number }, durationMs: number) {
  const minDuration = Math.min(180, Math.max(40, durationMs / 30));
  let startMs = Math.max(0, Math.min(durationMs - minDuration, Math.round(range.startMs)));
  let endMs = Math.max(startMs + minDuration, Math.min(durationMs, Math.round(range.endMs)));
  if (endMs > durationMs) {
    const overflow = endMs - durationMs;
    startMs = Math.max(0, startMs - overflow);
    endMs = durationMs;
  }
  return { startMs, endMs };
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
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
    generate_waveform: 'Waveform',
    generate_thumbnails: 'Thumbnails',
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

function parseWords(value: string) {
  return value.split(',').map((word) => word.trim()).filter(Boolean);
}

function previewAssetLayers(state: ApiState, currentMs: number, selection: SelectionTarget): PreviewAssetLayer[] {
  const byAsset = new Map<string, PreviewAssetLayer>();
  const addLayer = (asset: ApiAsset | undefined, target: NonNullable<SelectionTarget>) => {
    if (!asset?.fileUrl) return;
    const current = byAsset.get(asset.id);
    const targetSelected = selection?.kind === target.kind && selection.id === target.id;
    if (!current || targetSelected) {
      byAsset.set(asset.id, { id: `${target.kind}-${target.id}`, asset, selection: target });
    }
  };

  for (const event of state.timeline.filter((item) => item.type === 'image_overlay' && item.enabled)) {
    if (currentMs < event.startMs || currentMs > event.endMs) continue;
    const asset = state.assets.find((item) => item.id === event.payload.assetId);
    addLayer(asset, { kind: 'image_overlay', id: event.id });
  }

  const activeSegment = state.transcript.find((item) => currentMs >= item.startMs && currentMs <= item.endMs);
  const lower = activeSegment?.text.toLowerCase() ?? '';
  if (lower) {
    for (const asset of state.assets.filter((item) => item.timingMode === 'word_match')) {
      if (asset.triggerWords.some((word) => lower.includes(word.toLowerCase()))) {
        addLayer(asset, { kind: 'asset', id: asset.id });
      }
    }
  }

  if (selection?.kind === 'asset') {
    addLayer(state.assets.find((asset) => asset.id === selection.id), { kind: 'asset', id: selection.id });
  }
  if (selection?.kind === 'image_overlay') {
    const event = state.timeline.find((item) => item.id === selection.id && item.type === 'image_overlay');
    const asset = state.assets.find((item) => item.id === event?.payload.assetId);
    addLayer(asset, { kind: 'image_overlay', id: selection.id });
  }

  return Array.from(byAsset.values());
}

function previewZoomScale(timeline: TimelineEvent[], currentMs: number, selection: SelectionTarget) {
  const active = timeline.find((event) => (
    event.type === 'zoom' && event.enabled && currentMs >= event.startMs && currentMs <= event.endMs
  ));
  const selected = selection?.kind === 'zoom'
    ? timeline.find((event) => event.id === selection.id && event.type === 'zoom')
    : undefined;
  const scale = Number((active ?? selected)?.payload.scale ?? 1);
  return clamp(scale, 1, 2.5);
}

function readLatestSilenceSettings(jobs: VideoJob[]): SilenceDetectRequest {
  const job = jobs.find((item) => item.type === 'detect_silence' && item.result && typeof item.result === 'object');
  const result = job?.result as { settings?: Partial<SilenceDetectRequest> } | undefined;
  const settings = result?.settings ?? {};
  return {
    noiseDb: finiteNumber(settings.noiseDb, defaultSilenceDetectRequest.noiseDb),
    minDurationSec: finiteNumber(settings.minDurationSec, defaultSilenceDetectRequest.minDurationSec),
    paddingBeforeMs: finiteNumber(settings.paddingBeforeMs, defaultSilenceDetectRequest.paddingBeforeMs),
    paddingAfterMs: finiteNumber(settings.paddingAfterMs, defaultSilenceDetectRequest.paddingAfterMs),
    preserveBreaths: settings.preserveBreaths !== false
  };
}

function completeSubtitleStyle(style?: Partial<SubtitleStyle>): SubtitleStyle {
  const preset: SubtitleStyle['preset'] = style?.preset === 'yellow' || style?.preset === 'neon' || style?.preset === 'pill' || style?.preset === 'minimal'
    ? style.preset
    : 'bold';
  return {
    ...defaultSubtitleStyle,
    ...style,
    preset,
    fontSize: finiteNumber(style?.fontSize, defaultSubtitleStyle.fontSize),
    outlineWidth: finiteNumber(style?.outlineWidth, defaultSubtitleStyle.outlineWidth),
    shadow: finiteNumber(style?.shadow, defaultSubtitleStyle.shadow),
    box: style?.box === true,
    position: style?.position === 'top' || style?.position === 'middle' ? style.position : 'bottom'
  };
}

function subtitlePreviewStyle(source: Partial<SubtitleStyle>): React.CSSProperties {
  const style = completeSubtitleStyle(source);
  const stroke = Math.max(0, style.outlineWidth * 0.45);
  return {
    fontFamily: `${style.fontFamily}, Inter, Arial, sans-serif`,
    fontSize: `clamp(18px, ${Math.max(1.4, style.fontSize / 25)}vw, ${Math.round(style.fontSize * 0.8)}px)`,
    color: style.primaryColor,
    backgroundColor: style.box ? hexToRgba(style.backColor, 0.88) : 'transparent',
    fontWeight: style.bold ? 900 : 700,
    WebkitTextStroke: stroke ? `${stroke}px ${style.outlineColor}` : undefined,
    textShadow: style.shadow ? `0 ${style.shadow}px ${style.shadow * 5}px ${hexToRgba(style.outlineColor, 0.72)}` : undefined
  };
}

function initialInspectorTab(): InspectorTab {
  const tab = new URLSearchParams(window.location.search).get('tab');
  return tab === 'subtitles' || tab === 'silences' || tab === 'assets' || tab === 'zooms' ? tab : 'transcript';
}

function pipelineSteps(state: ApiState, jobsByType: Map<string, VideoJob>, uploadProgress: number | null) {
  const step = (
    key: PipelineStepKey,
    label: string,
    done: boolean,
    detailDone: string,
    action?: 'waveform' | 'thumbnails' | 'detect-silence' | 'transcribe'
  ) => {
    const job = jobsByType.get(key);
    const status = uploadProgress !== null && key === 'ingest'
      ? 'running'
      : job?.status === 'failed'
        ? 'failed'
        : done
          ? 'done'
          : job?.status === 'running'
            ? 'running'
            : job?.status === 'queued'
              ? 'queued'
              : 'idle';
    const detail = status === 'done'
      ? detailDone
      : status === 'running'
        ? `${jobLabel(key)} ${job?.progress ?? uploadProgress ?? 0}%`
        : status === 'failed'
          ? 'fallo, podes reintentar'
          : status === 'queued'
            ? 'en cola'
            : 'pendiente';
    return { key, label, status, detail, action: key === 'ingest' ? undefined : action };
  };
  return [
    step('ingest', 'Preview', Boolean(state.video.proxyUrl || state.video.durationMs), state.video.proxyUrl ? 'proxy listo' : 'metadata lista'),
    step('generate_waveform', 'Audio', state.waveform.length > 0, `${state.waveform.length} pts`, 'waveform'),
    step('generate_thumbnails', 'Frames', state.thumbnails.length > 0, `${state.thumbnails.length} frames`, 'thumbnails'),
    step('detect_silence', 'Cortes', state.silences.length > 0 || Boolean(jobsByType.get('detect_silence')?.status === 'done'), `${state.silences.length} cortes`, 'detect-silence'),
    step('transcribe', 'Subs', state.transcript.length > 0 || state.subtitles.length > 0, `${state.subtitles.length} subs`, 'transcribe')
  ];
}

function clientId() {
  return `ui_${Math.random().toString(36).slice(2, 12)}`;
}

function finiteNumber(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function hexToRgba(hex: string, alpha: number) {
  const clean = hex.replace('#', '').padEnd(6, '0').slice(0, 6);
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${Math.min(1, Math.max(0, alpha))})`;
}

createRoot(document.getElementById('root')!).render(<App />);
