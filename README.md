# Editor de Video Pro

MVP de editor de video con IA para Metamize. La app permite subir videos, generar proxy, detectar silencios con FFmpeg, editar transcripcion/subtitulos, mapear PNGs por palabra, agregar zooms simples y renderizar un MP4 final.

## Que trae

- Upload de videos y proxy 720p para editar rapido.
- Worker de jobs con polling sobre MySQL o JSON local.
- Deteccion de silencios sin API ni IA usando FFmpeg `silencedetect`.
- Transcripcion opcional con OpenAI Audio Transcriptions si existe `OPENAI_API_KEY`.
- Editor manual de transcript y subtitulos para corregir errores.
- Subida de PNG/WEBP/JPG con palabras trigger.
- Timeline con lanes de silencios, subtitulos, PNGs y zooms.
- Render final con cortes, subtitulos quemados, overlays por palabra y zoom punch-in basico.
- Modo local sin MySQL: usa `.data/dev-db.json`.
- Modo Railway: un servicio API+worker con `DATABASE_URL` MySQL y `STORAGE_DIR` apuntando a un Volume.
- Auth opcional con HTTP Basic (`AUTH_PASSWORD`) para no dejar uploads/render publicos.

## Stack

- React + Vite para la UI.
- Express para API.
- Worker Node integrado en el servicio web para el MVP; separable despues.
- MySQL en produccion.
- FFmpeg/FFprobe para video.
- OpenAI opcional para transcripcion.

## Comandos

```bash
npm install
npm run dev
```

En local abre:

- Web: `http://localhost:5173`
- API: `http://localhost:8787/health`

Build produccion:

```bash
npm run build
npm run start
```

Worker separado, solo para escala futura:

```bash
npm run worker
```

`npm run start` arranca API + worker juntos por defecto (`RUN_WORKER_IN_WEB=true`). Para escalar worker separado mas adelante, pon `RUN_WORKER_IN_WEB=false` en el servicio web y crea otro servicio con `npm run worker` usando storage compartido en S3/R2.

Migraciones:

```bash
npm run migrate
```

## Variables

Copiar `.env.example` a `.env`.

```env
PORT=8787
APP_ORIGIN=http://localhost:5173
DATABASE_URL=mysql://root:password@localhost:3306/editor_video_pro
STORAGE_DIR=./storage
JSON_DB_PATH=
PUBLIC_BASE_URL=
FFMPEG_PATH=ffmpeg
FFPROBE_PATH=ffprobe
FFMPEG_TIMEOUT_MS=1200000
SILENCE_NOISE_DB=-35
SILENCE_MIN_DURATION_SEC=0.35
OPENAI_API_KEY=
OPENAI_TRANSCRIBE_MODEL=whisper-1
TRANSCRIPTION_API_KEY=
TRANSCRIPTION_API_URL=https://api.openai.com/v1/audio/transcriptions
TRANSCRIPTION_MODEL=whisper-1
TRANSCRIPTION_LANGUAGE=es
TRANSCRIPTION_PROMPT=Spanish / Argentine Spanish. Marketing, ecommerce, Meta Ads, ROAS, CPA, campanas, ventas.
WORKER_ID=local-worker
MAX_UPLOAD_MB=700
AUTH_USERNAME=metamize
AUTH_PASSWORD=
RUN_WORKER_IN_WEB=true
STALE_JOB_MS=900000
MAX_JOB_ATTEMPTS=3
```

Sin `DATABASE_URL`, el MVP usa JSON local para que puedas probar rapido. En Railway si conviene usar MySQL.

## Railway

1. Crear un proyecto nuevo en Railway desde este repo.
2. Agregar MySQL.
3. Agregar un Volume y montarlo, por ejemplo, en `/data`.
4. Setear variables:

```env
DATABASE_URL=${{MySQL.MYSQL_URL}}
STORAGE_DIR=/data
APP_ORIGIN=https://tu-dominio.up.railway.app
PUBLIC_BASE_URL=https://tu-dominio.up.railway.app
OPENAI_API_KEY=opcional
TRANSCRIPTION_MODEL=whisper-1
TRANSCRIPTION_LANGUAGE=es
AUTH_USERNAME=metamize
AUTH_PASSWORD=una-clave-larga
RUN_WORKER_IN_WEB=true
```

5. Servicio unico recomendado para el MVP:

```bash
npm run start
```

Ese comando arranca API + worker en el mismo proceso y comparte el mismo Volume. Es intencional: en Railway los volumes son por servicio, asi que separar API y worker sin S3/R2 puede hacer que el worker no vea los uploads.

6. Escala futura, no recomendada para el primer MVP: separar worker.

```bash
RUN_WORKER_IN_WEB=false
npm run worker
```

Solo hacerlo si pasas media storage a S3/R2 o un storage compartido real.

El Dockerfile ya instala FFmpeg.

## Flujo del MVP

1. Subis video.
2. El job `ingest` hace `ffprobe` y genera proxy.
3. Tocas `Cortar silencios`.
4. Revisas silencios y apagas los cortes que no queres.
5. Tocas `Transcribir`.
6. Editas texto/subtitulos.
7. Subis PNGs y asignas palabras trigger.
8. Agregas zooms desde el cursor.
9. Tocas `Renderizar`.
10. Descargas el MP4 final desde el ultimo render.

## Limites honestos del MVP

- Los zooms son punch-in basicos; no hay keyframes visuales avanzados todavia.
- La transcripcion local no esta incluida; sin `OPENAI_API_KEY` o `TRANSCRIPTION_API_KEY`, crea bloques editables manuales.
- Para timestamps confiables en OpenAI, usar `TRANSCRIPTION_MODEL=whisper-1`. Modelos `gpt-4o-transcribe` pueden servir para texto simple, pero no entregan el mismo modo `verbose_json` con timestamps.
- El preview simula overlays/zoom de manera simple; el render final usa FFmpeg.
- Para muchos usuarios concurrentes conviene cambiar la cola MySQL por Redis/BullMQ o una cola gestionada.
- Para worker separado o archivos grandes conviene mover storage a S3/R2.

## Proximo salto

- Drag & drop real de timeline.
- Waveform real.
- Word-level timestamps.
- Plantillas de subtitulos por marca.
- Render con Remotion para motion graphics mas complejos.
- Redis queue y workers autoscalables.
