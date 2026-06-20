# Editor de Video Pro - Plan Ambicioso de Producto

## Vision

Crear un editor de video web tipo CapCut, pero enfocado en performance marketing, creadores UGC, founders y equipos que necesitan producir videos cortos rapido.

El producto no deberia sentirse como "FFmpeg con botones". Tiene que sentirse como un editor visual, rapido, moderno e inteligente:

- subis un video crudo;
- la app lo analiza;
- corta silencios;
- transcribe;
- arma subtitulos lindos;
- permite editar timeline;
- permite agregar PNGs, zooms y overlays;
- renderiza en calidad publicable.

El norte es claro: que una persona pueda pasar de video crudo a pieza lista para Reels, TikTok, Shorts o ads sin abrir CapCut.

## Estado Actual

El MVP actual valida la arquitectura inicial, pero todavia no valida producto.

Problemas principales:

- cortar silencios no funciona de forma confiable;
- transcripcion no funciona si no hay proveedor configurado;
- subtitulos son visualmente pobres;
- timeline es muy basica;
- upload y procesamiento se sienten toscos;
- proyectos se ven poco profesionales;
- preview del video no se siente como editor;
- la experiencia general no transmite calidad premium.

La prioridad no es agregar mas botones. La prioridad es convertirlo en un editor real.

## Principio De Producto

Cada feature debe cumplir una de estas funciones:

- ahorrar tiempo;
- dar control visual;
- mejorar retencion del video;
- hacer que el resultado parezca editado por un humano bueno;
- reducir errores y frustracion.

Si una feature no mejora una de esas cinco cosas, no va primero.

## Experiencia Ideal

El flujo perfecto:

1. El usuario entra al dashboard.
2. Sube un video.
3. Ve una carga clara, con progreso real.
4. El sistema genera proxy, waveform, thumbnails, silencios y transcripcion.
5. El editor abre con preview, timeline, transcript y controles.
6. La app propone cortes de silencio.
7. El usuario ajusta sensibilidad y aplica.
8. La app genera subtitulos con estilo.
9. El usuario edita texto, timing y diseno.
10. El usuario agrega zooms, PNGs y overlays.
11. Ve todo en preview casi final.
12. Exporta en formato vertical, cuadrado u horizontal.
13. Descarga un MP4 listo para publicar.

El usuario nunca deberia preguntarse si la app se rompio. Siempre tiene que haber estado, progreso y accion siguiente.

## Dashboard De Proyectos

La pantalla inicial tiene que sentirse como un estudio de edicion.

Debe incluir:

- grilla de proyectos con thumbnails reales;
- titulo del proyecto;
- duracion;
- formato;
- fecha de ultima edicion;
- estado claro: subiendo, procesando, listo, error, renderizando;
- ultimo render descargable;
- boton principal "Nuevo video";
- filtros por estado, fecha y formato;
- busqueda por nombre;
- acciones rapidas: abrir, duplicar, borrar, descargar ultimo render.

Estados visuales:

- proyecto sin procesar;
- proyecto listo;
- proyecto con error;
- proyecto renderizando;
- proyecto sin transcripcion.

El dashboard no debe parecer un CRUD. Tiene que parecer una herramienta creativa.

## Upload Profesional

El upload actual tiene que cambiar completamente.

Nuevo upload:

- drag and drop grande;
- selector de archivo;
- validacion de formato antes de subir;
- mostrar nombre, peso y duracion estimada;
- barra de progreso real de subida;
- barra separada para procesamiento;
- posibilidad de cancelar;
- errores humanos, no logs tecnicos;
- thumbnail apenas sea posible;
- vista de pasos del pipeline.

Pasos visibles:

- Subiendo video
- Analizando metadata
- Generando preview liviana
- Extrayendo audio
- Detectando silencios
- Transcribiendo
- Preparando timeline
- Listo para editar

Si algo falla, el usuario debe poder reintentar ese paso sin perder todo.

## Pipeline De Procesamiento

El backend debe convertirse en una maquina de jobs clara y resistente.

Jobs separados:

- `ingest_video`
- `generate_proxy`
- `extract_audio`
- `generate_waveform`
- `generate_thumbnails`
- `detect_silences`
- `transcribe_audio`
- `align_words`
- `generate_subtitle_cues`
- `suggest_zooms`
- `prepare_editor_state`
- `render_export`

Cada job debe tener:

- status;
- progress;
- started_at;
- finished_at;
- attempts;
- error tecnico interno;
- error visible para usuario;
- payload;
- result;
- logs internos.

Estados:

- queued;
- running;
- completed;
- failed;
- canceled;
- retrying.

Esto permite que la app sea confiable aunque FFmpeg o un proveedor externo fallen.

## Corte De Silencios

Esta es una feature core. Tiene que ser excelente.

El corte de silencios debe incluir:

- deteccion automatica por audio;
- sensibilidad configurable;
- minimo de silencio detectable;
- padding antes del corte;
- padding despues del corte;
- opcion de mantener respiraciones naturales;
- preview de cortes antes de aplicar;
- timeline con zonas marcadas;
- posibilidad de desactivar un corte puntual;
- restaurar todos los cortes;
- aplicar cortes como eventos no destructivos.

Controles:

- slider de sensibilidad;
- slider de duracion minima;
- input de padding;
- boton "Detectar de nuevo";
- boton "Aplicar cortes";
- boton "Comparar antes/despues".

La deteccion inicial puede seguir con FFmpeg, pero debe estar mejor envuelta:

- thresholds ajustables;
- parseo robusto;
- logs;
- tests con videos reales;
- fallback si no detecta nada;
- mensaje claro si el audio esta muy bajo.

El usuario debe sentir que controla el ritmo, no que la app decide a ciegas.

## Waveform

Sin waveform, la timeline se siente ciega.

Necesitamos generar una representacion del audio:

- waveform por muestras;
- cacheada por video;
- renderizable rapido en frontend;
- sincronizada con playhead;
- compatible con zoom de timeline.

La waveform permite:

- entender silencios;
- cortar manualmente;
- ajustar subtitulos;
- ver pausas;
- confiar en el editor.

## Transcripcion Robusta

La transcripcion es el motor del producto.

Debe soportar:

- proveedor configurable;
- word-level timestamps;
- idioma automatico;
- espanol rioplatense;
- regeneracion;
- edicion manual;
- busqueda;
- reemplazo;
- correccion de palabras;
- separacion entre transcript y subtitulos.

Arquitectura:

- `TranscriptionProvider` como interfaz;
- `OpenAITranscriptionProvider`;
- `GroqWhisperProvider`;
- `DeepgramProvider`;
- `LocalWhisperProvider` opcional;
- fallback manual si no hay proveedor.

Datos necesarios:

- segmentos;
- palabras;
- start_ms;
- end_ms;
- confidence si existe;
- source;
- edited flag.

La transcripcion no debe ser un bloque de texto muerto. Debe ser editable y sincronizada.

## Editor De Transcript

El transcript debe parecer un documento vivo.

Features:

- click en palabra salta al momento exacto;
- editar palabra inline;
- dividir segmento;
- unir segmento;
- buscar palabra;
- reemplazar palabra;
- marcar palabra como trigger;
- seleccionar frase y crear subtitulo;
- seleccionar frase y crear zoom;
- seleccionar frase y crear overlay.

Esto convierte el texto en la interfaz de edicion.

## Subtitulos Premium

Los subtitulos actuales deben ser reemplazados por un sistema visual serio.

Controles globales:

- fuente;
- tamano;
- peso;
- color;
- stroke;
- sombra;
- fondo;
- radius;
- posicion;
- ancho maximo;
- safe area;
- palabras por linea;
- maximo de caracteres por cue;
- duracion minima;
- duracion maxima.

Estilos base:

- bold blanco con stroke;
- amarillo punch;
- blanco minimalista;
- neon Metamize;
- caption con fondo tipo pill;
- karaoke word highlight;
- subtitulo grande centrado;
- subtitulo bajo para talking head.

Animaciones:

- fade;
- pop;
- bounce suave;
- slide up;
- word highlight;
- karaoke progresivo.

La preview debe mostrar subtitulos en tiempo real. El usuario no puede esperar al render final para saber si queda bien.

## Separar Transcript De Subtitles

Esto es clave.

Transcript:

- lo que se dijo;
- palabras y tiempos;
- editable como texto.

Subtitles:

- como se muestra;
- agrupacion de palabras;
- estilo;
- animacion;
- posicion;
- timing ajustado.

No deben ser la misma tabla ni la misma entidad conceptual.

## Timeline Real

La timeline actual debe rehacerse como una pieza central del producto.

Tracks:

- video;
- audio waveform;
- silence cuts;
- subtitles;
- zooms;
- image assets;
- overlays;
- markers.

Funciones:

- playhead fluido;
- zoom in/out horizontal;
- drag para mover eventos;
- resize para duracion;
- snap a palabras;
- snap a cortes;
- seleccion multiple;
- borrar eventos;
- duplicar eventos;
- bloquear track;
- ocultar track;
- undo/redo;
- shortcuts.

Atajos minimos:

- Space: play/pause;
- S: split;
- Delete: borrar seleccionado;
- Ctrl/Cmd+Z: undo;
- Ctrl/Cmd+Shift+Z: redo;
- +/-: zoom timeline;
- flechas: mover playhead.

La timeline debe sentirse como editor, no como lista de eventos.

## Preview Del Video

La preview es el centro emocional del producto.

Debe incluir:

- player grande;
- aspect ratio selector;
- safe areas;
- overlays en vivo;
- subtitulos en vivo;
- PNGs en vivo;
- zoom crop simulado;
- seleccion visual de elementos;
- drag de elementos en canvas;
- fullscreen;
- controles de playback;
- velocidad;
- volumen;
- frame step.

Aspect ratios:

- 9:16;
- 1:1;
- 4:5;
- 16:9.

La preview debe usar proxy liviano para que no se trabe. El render final puede usar el original.

## Inspector Derecho

Cuando seleccionas algo, aparece su inspector.

Si seleccionas subtitulo:

- texto;
- fuente;
- tamano;
- color;
- stroke;
- posicion;
- animacion;
- timing.

Si seleccionas PNG:

- archivo;
- palabras trigger;
- posicion;
- escala;
- entrada;
- salida;
- duracion;
- repeticion.

Si seleccionas zoom:

- inicio;
- fin;
- escala;
- easing;
- posicion;
- intensidad.

Si no hay seleccion:

- ajustes del proyecto;
- formato;
- fondo;
- calidad de preview;
- estilo global.

Este inspector es lo que hace que el editor se sienta profesional.

## PNGs Y Assets Por Palabras

Esta puede ser una diferencia fuerte frente a editores genericos.

Features:

- biblioteca de assets por proyecto;
- subir PNG, WEBP, JPG;
- asociar asset a palabras;
- crear triggers;
- mostrar ocurrencias detectadas;
- activar/desactivar ocurrencia;
- controlar posicion por asset;
- controlar timing;
- controlar animacion;
- limitar repeticiones.

Ejemplo:

- palabra: "ROAS";
- asset: grafico de ROAS;
- aparece 0.4s despues de la palabra;
- dura 1.2s;
- entra con pop;
- sale con fade.

Esto hace que el editor sea especialmente bueno para videos de ventas, ads y producto.

## Zooms Inteligentes

Los zooms deben mejorar ritmo y retencion.

Tipos:

- punch-in;
- slow zoom;
- snap zoom;
- zoom out;
- zoom hacia zona especifica.

Controles:

- escala;
- duracion;
- easing;
- posicion;
- intensidad.

Sugerencias automaticas:

- al inicio de frases fuertes;
- despues de silencios cortados;
- cuando aparecen numeros;
- cuando aparece una palabra trigger;
- cada X segundos si el video esta plano.

No hace falta que al principio detecte caras. Primero debe ser editable y verse bien.

## IA Por Acciones

No conviene depender de un "agente magico" que hace cualquier cosa. Conviene crear acciones concretas, testeables y editables.

Acciones:

- cortar silencios;
- mejorar subtitulos;
- generar subtitulos desde transcript;
- sugerir zooms;
- hacer version mas rapida;
- detectar mejores momentos;
- detectar partes aburridas;
- proponer hooks;
- proponer CTAs;
- asociar PNGs a palabras;
- convertir a 9:16;
- resumir video en clips.

Mas adelante puede existir un chat de edicion, pero internamente debe ejecutar acciones reales sobre la timeline.

Ejemplo:

Usuario: "hacelo mas dinamico"

La app deberia:

- aumentar cortes;
- agregar zooms suaves;
- reducir pausas;
- mejorar subtitulos;
- marcar cambios en timeline;
- permitir deshacer.

## Render De Alta Calidad

El render final debe ser confiable.

Export presets:

- TikTok/Reels 1080x1920;
- YouTube Shorts 1080x1920;
- Instagram Feed 1080x1350;
- Square 1080x1080;
- Landscape 1920x1080.

Calidades:

- Draft;
- High;
- Ultra.

Debe incluir:

- progreso real;
- estado visible;
- historial de renders;
- descarga;
- reintentar;
- cancelar;
- versionado;
- error claro.

El renderer puede seguir siendo FFmpeg inicialmente, pero con filtros mucho mas cuidados. Para composiciones visuales complejas se puede sumar Remotion.

## Jobs De Render

Render no debe bloquear la API.

Debe correr como worker:

- toma job;
- prepara archivos temporales;
- arma filter graph;
- ejecuta FFmpeg;
- guarda output;
- limpia temporales;
- registra render;
- actualiza proyecto.

Necesitamos logs internos por render para debuggear.

## Diseno Visual

Direccion: editor oscuro, premium, funcional.

Layout:

- topbar con nombre del proyecto, formato y export;
- sidebar izquierda para proyectos/assets/transcript;
- preview central;
- inspector derecha;
- timeline abajo.

Estilo:

- fondo oscuro;
- bordes sutiles;
- morado Metamize como acento, no como exceso;
- verde solo para estados positivos;
- rojo solo para errores;
- tipografia limpia;
- iconos claros;
- botones compactos;
- microinteracciones.

Evitar:

- cards gigantes innecesarias;
- gradients decorativos por todos lados;
- textos explicativos largos dentro del editor;
- UI tipo landing page;
- controles sin estado.

Inspiracion:

- CapCut;
- Descript;
- Runway;
- Premiere Rush;
- Figma;
- Linear.

## Arquitectura Frontend

Stack recomendado:

- React;
- Zustand para editor state local;
- TanStack Query para server state;
- HTML video para preview;
- canvas/SVG para timeline;
- overlays DOM/canvas para subtitulos y assets;
- CSS modular o estructura de estilos clara.

Modulos:

- `ProjectDashboard`;
- `UploadFlow`;
- `EditorShell`;
- `VideoPreview`;
- `Timeline`;
- `WaveformTrack`;
- `TranscriptEditor`;
- `SubtitleInspector`;
- `AssetInspector`;
- `ZoomInspector`;
- `ExportPanel`;
- `JobStatusPanel`.

El estado de edicion debe poder serializarse. La timeline deberia ser una fuente clara de verdad.

## Arquitectura Backend

Stack inicial:

- Express API;
- worker Node;
- MySQL;
- Railway Volume;
- FFmpeg;
- proveedor de transcripcion configurable.

Mejora recomendada:

- queue real con Redis/BullMQ;
- object storage tipo R2/S3;
- workers separados para render;
- logs persistentes;
- rate limits;
- auth real;
- multi workspace.

Separaciones importantes:

- API no renderiza;
- worker no decide UI;
- renderer no conoce negocio;
- transcriber es intercambiable;
- storage es abstraccion, no path hardcodeado.

## Modelo De Datos Ideal

Entidades:

- users;
- workspaces;
- projects;
- videos;
- video_files;
- jobs;
- job_logs;
- transcript_segments;
- transcript_words;
- subtitle_cues;
- timeline_events;
- image_assets;
- renders;
- render_settings;
- editor_presets;

Timeline events:

- silence_cut;
- subtitle;
- image;
- zoom;
- marker;
- overlay.

Cada evento debe tener:

- id;
- project_id;
- type;
- start_ms;
- end_ms;
- enabled;
- payload_json;
- created_at;
- updated_at.

## Calidad Y Testing

Hay que testear con videos reales.

Set de pruebas:

- video con mucho silencio;
- video con musica;
- video con audio bajo;
- video vertical;
- video horizontal;
- video largo;
- video corto;
- video con espanol rapido;
- video con mala iluminacion;
- video con archivo pesado.

Tests necesarios:

- parseo de silencios;
- generacion de subtitles;
- render con cortes;
- render con PNGs;
- render con zooms;
- upload grande;
- job retry;
- errores de proveedor de transcripcion.

Smoke test ideal:

1. subir video;
2. esperar processing;
3. aplicar cortes;
4. editar subtitulo;
5. agregar PNG;
6. agregar zoom;
7. renderizar;
8. validar MP4 final.

## Roadmap

### Fase 1 - Core Confiable

Objetivo: que lo basico ande siempre.

- arreglar corte de silencios;
- mejorar deteccion y parametros;
- conectar transcripcion real;
- guardar word timestamps;
- separar transcript de subtitles;
- arreglar render;
- mejorar errores;
- mejorar jobs;
- mejorar upload status;
- validar en Railway.

Resultado: producto usable aunque todavia no sea hermoso.

### Fase 2 - Editor Visual

Objetivo: que se sienta como editor.

- rehacer layout completo;
- preview central;
- timeline abajo;
- inspector derecho;
- panel izquierdo;
- waveform;
- transcript editable;
- subtitles preview;
- zooms editables;
- assets editables.

Resultado: deja de parecer demo tecnica.

### Fase 3 - Subtitulos Y Timeline Premium

Objetivo: que el output se vea bueno.

- subtitulos con estilos;
- animaciones;
- word highlight;
- drag en preview;
- timeline con drag/resize;
- snap;
- undo/redo;
- shortcuts;
- render consistente con preview.

Resultado: primer producto que se puede mostrar con orgullo.

### Fase 4 - IA Util

Objetivo: que edite mas rapido que una persona.

- sugerir cortes;
- sugerir zooms;
- detectar hooks;
- detectar partes aburridas;
- asociar PNGs a palabras;
- generar captions mejores;
- proponer versiones mas dinamicas;
- acciones de edicion desde texto.

Resultado: diferencial real frente a un editor comun.

### Fase 5 - Producto SaaS

Objetivo: escalar.

- login;
- workspaces;
- billing;
- limites por plan;
- storage cloud;
- render workers separados;
- historial;
- presets de marca;
- colaboracion;
- comentarios;
- metricas de uso.

Resultado: producto vendible.

## Prioridad De Ejecucion

Orden recomendado:

1. Arreglar backend core.
2. Arreglar transcripcion.
3. Arreglar corte de silencios.
4. Rehacer upload.
5. Rehacer editor layout.
6. Rehacer preview.
7. Rehacer subtitulos.
8. Rehacer timeline.
9. Agregar waveform.
10. Agregar assets por palabras.
11. Agregar zooms buenos.
12. Mejorar render.
13. Agregar IA por acciones.

El error seria invertir meses en UI hermosa si silencio/transcripcion/render siguen rotos. Pero tambien seria un error quedarse solo en backend: el producto se vende por sensacion visual.

## Sobre Costos De IA

Para una web en produccion, Codex no puede quedar conectado como "backend gratis" que transcribe y edita por los usuarios.

Opciones reales:

- usar una API de transcripcion;
- usar un modelo local en el servidor;
- usar un modelo local en la maquina del usuario;
- usar un proveedor barato y cachear resultados;
- permitir que cada usuario conecte su propia API key;
- ofrecer modo manual sin IA.

El producto puede minimizar gasto:

- cachear transcripciones;
- no retranscribir si el audio no cambio;
- mandar solo audio comprimido;
- permitir elegir calidad;
- usar proveedores mas baratos para draft;
- usar proveedores mejores solo para final;
- procesar localmente si el server tiene capacidad.

La IA debe usarse donde realmente cambia el resultado. Para cortar silencios, waveform, render, timeline y subtitulos visuales, muchas cosas pueden hacerse sin LLM.

## Norte Final

El producto ideal es:

- rapido;
- visual;
- confiable;
- editable;
- lindo;
- especializado en videos cortos;
- fuerte en subtitulos;
- fuerte en cortes;
- fuerte en assets y zooms;
- facil de exportar.

La promesa:

"Subi un video crudo y convertile el ritmo, subtitulos y overlays en una pieza lista para publicar."

