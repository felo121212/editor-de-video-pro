import { EditorState, ImageAsset, RenderRecord, VideoProject } from '../../shared/types.js';
import { publicMediaUrl } from './storage.service.js';

export function presentVideo(video: VideoProject) {
  return {
    ...video,
    originalUrl: publicMediaUrl(video.originalPath),
    proxyUrl: publicMediaUrl(video.proxyPath),
    renderUrl: publicMediaUrl(video.renderPath)
  };
}

export function presentAsset(asset: ImageAsset) {
  return {
    ...asset,
    fileUrl: publicMediaUrl(asset.filePath)
  };
}

export function presentRender(render: RenderRecord) {
  return {
    ...render,
    downloadUrl: publicMediaUrl(render.outputPath)
  };
}

export function presentEditorState(state: EditorState) {
  return {
    ...state,
    video: presentVideo(state.video),
    assets: state.assets.map(presentAsset),
    renders: state.renders.map(presentRender)
  };
}

