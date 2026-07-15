# Cursor History

<p align="center">
  <img src="logo.png" alt="cursor-history logo" width="200">
</p>

[![npm version](https://img.shields.io/npm/v/cursor-history.svg)](https://www.npmjs.com/package/cursor-history)
[![npm downloads](https://img.shields.io/npm/dm/cursor-history.svg)](https://www.npmjs.com/package/cursor-history)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0%2B-blue.svg)](https://www.typescriptlang.org/)

**La herramienta de código abierto definitiva para navegar, buscar, exportar y respaldar tu historial de chat de Cursor AI.**

Una herramienta CLI de estilo POSIX que hace una cosa bien: acceder a tu historial de chat de Cursor AI. Construida sobre la filosofía Unix — simple, componible y enfocada.

```bash
# Compatible con pipes: combina con otras herramientas
cursor-history list --json | jq '.[] | select(.messageCount > 10)'
cursor-history export 1 | grep -i "api" | head -20
cursor-history search "bug" --json | jq -r '.[].sessionId' | xargs -I {} cursor-history export {}
```

Nunca pierdas una conversación otra vez. Ya sea que necesites encontrar ese fragmento de código perfecto de la semana pasada, migrar tu historial a una nueva máquina, o crear respaldos confiables de todas tus sesiones de desarrollo asistido por IA — cursor-history te tiene cubierto. Gratis, de código abierto, y construido por la comunidad para la comunidad.

## Características

- **Interfaz dual** - Úsalo como herramienta CLI o impórtalo como biblioteca en tus proyectos Node.js
- **Listar sesiones** - Ver todas las sesiones de chat en todos los espacios de trabajo
- **Conversaciones completas** - Ver el historial completo de chat con:
  - Respuestas de IA con explicaciones en lenguaje natural
  - **Visualización completa de diff** para ediciones de archivos con resaltado de sintaxis
  - **Llamadas de herramientas detalladas** mostrando todos los parámetros (rutas de archivos, patrones de búsqueda, comandos, etc.)
  - Razonamiento y pensamiento de la IA
  - Marcas de tiempo de mensajes (precisas para todas las sesiones, incluyendo antes de septiembre 2025)
- **Búsqueda** - Encontrar conversaciones por palabra clave con coincidencias resaltadas
- **Exportar** - Guardar sesiones como archivos Markdown o JSON
- **Migrar** - Mover o copiar sesiones entre espacios de trabajo (ej. al renombrar proyectos)
- **Respaldo y restauración** - Crear respaldos completos de todo el historial y restaurar cuando sea necesario
- **Multiplataforma** - Funciona en macOS, Windows y Linux

## Instalación

### Desde NPM (Recomendado)

```bash
# Instalar globalmente
npm install -g cursor-history

# Usar el CLI
cursor-history list
```

### Desde el código fuente

```bash
# Clonar y compilar
git clone https://github.com/S2thend/cursor_chat_history.git
cd cursor_chat_history
npm install
npm run build

# Ejecutar directamente
node dist/cli/index.js list

# O enlazar globalmente
npm link
cursor-history list
```

## Requisitos

- Node.js 20+ (Node.js 22.5+ recomendado para soporte SQLite integrado)
- Cursor IDE (con historial de chat existente)

## Configuración del controlador SQLite

cursor-history soporta dos controladores SQLite para máxima compatibilidad:

| Controlador | Descripción | Versión Node.js |
|-------------|-------------|-----------------|
| `node:sqlite` | Módulo SQLite integrado de Node.js (sin bindings nativos) | 22.5+ |
| `better-sqlite3` | Bindings nativos vía better-sqlite3 | 20+ |

### Selección automática de controlador

Por defecto, cursor-history selecciona automáticamente el mejor controlador disponible:

1. **node:sqlite** (preferido) - Funciona en Node.js 22.5+ sin compilación nativa
2. **better-sqlite3** (respaldo) - Funciona en versiones anteriores de Node.js

### Selección manual de controlador

Puedes forzar un controlador específico usando la variable de entorno:

```bash
# Forzar better-sqlite3
CURSOR_HISTORY_SQLITE_DRIVER=better-sqlite3 cursor-history list

# Forzar node:sqlite (requiere Node.js 22.5+)
CURSOR_HISTORY_SQLITE_DRIVER=node:sqlite cursor-history list
```

### Depurar selección de controlador

Para ver qué controlador se está usando:

```bash
DEBUG=cursor-history:* cursor-history list
```

### Control de controlador vía API de biblioteca

Al usar cursor-history como biblioteca, puedes controlar el controlador programáticamente:

```typescript
import { setDriver, getActiveDriver, listSessions } from 'cursor-history';

// Forzar un controlador específico antes de cualquier operación
setDriver('better-sqlite3');

// Verificar qué controlador está activo
const driver = getActiveDriver();
console.log(`Usando controlador: ${driver}`);

// O configurar vía LibraryConfig
const result = await listSessions({
  sqliteDriver: 'node:sqlite'  // Forzar node:sqlite para esta llamada
});
```

## Uso

### Listar sesiones

```bash
# Listar sesiones recientes (por defecto: 20)
cursor-history list

# Listar todas las sesiones
cursor-history list --all

# Listar con IDs de composer (para herramientas externas)
cursor-history list --ids

# Limitar resultados
cursor-history list -n 10

# Listar solo espacios de trabajo
cursor-history list --workspaces
```

### Ver una sesión

```bash
# Mostrar sesión por número de índice
cursor-history show 1

# Mostrar con mensajes truncados (vista rápida)
cursor-history show 1 --short

# Mostrar texto completo de pensamiento/razonamiento de IA
cursor-history show 1 --think

# Mostrar contenido completo de lectura de archivos (sin truncar)
cursor-history show 1 --fullread

# Mostrar mensajes de error completos (sin truncar a 300 caracteres)
cursor-history show 1 --error

# Filtrar por tipo de mensaje (user, assistant, tool, thinking, error)
cursor-history show 1 --only user
cursor-history show 1 --only user,assistant
cursor-history show 1 --only tool,error

# Combinar opciones
cursor-history show 1 --short --think --fullread --error
cursor-history show 1 --only user,assistant --short

# Salida como JSON
cursor-history show 1 --json
```

### Buscar

```bash
# Buscar palabra clave
cursor-history search "react hooks"

# Limitar resultados
cursor-history search "api" -n 5

# Ajustar contexto alrededor de coincidencias
cursor-history search "error" --context 100
```

### Exportar

```bash
# Exportar una sesión a Markdown
cursor-history export 1

# Exportar a archivo específico
cursor-history export 1 -o ./mi-chat.md

# Exportar como JSON
cursor-history export 1 --format json

# Exportar todas las sesiones a un directorio
cursor-history export --all -o ./exports/

# Sobrescribir archivos existentes
cursor-history export 1 --force
```

### Migrar sesiones

```bash
# Mover una sesión a otro espacio de trabajo
cursor-history migrate-session 1 /ruta/a/nuevo/proyecto

# Mover múltiples sesiones (índices o IDs separados por comas)
cursor-history migrate-session 1,3,5 /ruta/a/proyecto

# Copiar en lugar de mover (mantiene el original)
cursor-history migrate-session --copy 1 /ruta/a/proyecto

# Previsualizar qué pasaría sin hacer cambios
cursor-history migrate-session --dry-run 1 /ruta/a/proyecto

# Mover todas las sesiones de un espacio de trabajo a otro
cursor-history migrate /proyecto/antiguo /proyecto/nuevo

# Copiar todas las sesiones (respaldo)
cursor-history migrate --copy /proyecto /respaldo/proyecto

# Forzar fusión con sesiones existentes en destino
cursor-history migrate --force /proyecto/antiguo /proyecto/existente
```

### Respaldo y restauración

```bash
# Crear respaldo de todo el historial
cursor-history backup

# Crear respaldo en archivo específico
cursor-history backup -o ~/mi-respaldo.zip

# Sobrescribir respaldo existente
cursor-history backup --force

# Listar respaldos disponibles
cursor-history list-backups

# Listar respaldos en directorio específico
cursor-history list-backups -d /ruta/a/respaldos

# Restaurar desde respaldo
cursor-history restore ~/cursor-history-backups/backup.zip

# Restaurar a ubicación personalizada
cursor-history restore backup.zip --target /cursor/data/personalizado

# Forzar sobrescritura de datos existentes
cursor-history restore backup.zip --force

# Ver sesiones de un respaldo sin restaurar
cursor-history list --backup ~/backup.zip
cursor-history show 1 --backup ~/backup.zip
cursor-history search "consulta" --backup ~/backup.zip
cursor-history export 1 --backup ~/backup.zip
```

### Opciones globales

```bash
# Salida como JSON (funciona con todos los comandos)
cursor-history --json list

# Usar ruta de datos de Cursor personalizada
cursor-history --data-path ~/.cursor-alt list

# Filtrar por espacio de trabajo
cursor-history --workspace /ruta/a/proyecto list
```

## Qué puedes ver

Al navegar tu historial de chat, verás:

- **Conversaciones completas** - Todos los mensajes intercambiados con Cursor AI
- **Cada mensaje se renderiza** - Cada mensaje resuelto se muestra una vez en orden; los duplicados consecutivos no se pliegan, por lo que las llamadas a herramientas, la procedencia y los datos de tokens distintos nunca se ocultan
- **Marcas de tiempo** - La hora almacenada directamente de un mensaje cuando está disponible (formato HH:MM:SS); los mensajes sin hora directa no muestran marca de tiempo en lugar de usar un respaldo fabricado
- **Sesiones combinadas entre pilas** - Cuando la misma sesión existe tanto en la pila Composer (vscdb) como en Store (~/.cursor), ambas representaciones se combinan campo a campo (ninguna se descarta), con la fuente principal elegida por plataforma (WSL prefiere Store; Windows/macOS/Linux nativo prefieren Composer)
- **Acciones de herramientas IA** - Vista detallada de lo que hizo Cursor AI:
  - **Ediciones/escrituras de archivos** - Visualización completa de diff con resaltado de sintaxis mostrando exactamente qué cambió
  - **Lecturas de archivos** - Rutas de archivos y previsualizaciones de contenido (usa `--fullread` para contenido completo)
  - **Operaciones de búsqueda** - Patrones, rutas y consultas de búsqueda usadas
  - **Comandos de terminal** - Texto completo del comando
  - **Listados de directorio** - Rutas exploradas
  - **Errores de herramientas** - Operaciones fallidas/canceladas mostradas con indicador de estado ❌ y parámetros
  - **Decisiones del usuario** - Muestra si aceptaste (✓), rechazaste (✗), o pendiente (⏳) en operaciones de herramientas
  - **Errores** - Mensajes de error con resaltado de emoji ❌ (extraídos de `toolFormerData.additionalData.status`)
- **Razonamiento IA** - Ver el proceso de pensamiento de la IA detrás de las decisiones (usa `--think` para texto completo)
- **Artefactos de código** - Diagramas Mermaid, bloques de código, con resaltado de sintaxis
- **Explicaciones en lenguaje natural** - Explicaciones de IA combinadas con código para contexto completo

### Opciones de visualización

- **Vista por defecto** - Mensajes completos con pensamiento truncado (200 car.), lecturas de archivos (100 car.) y errores (300 car.)
- **Modo `--short`** - Trunca mensajes de usuario y asistente a 300 caracteres para escaneo rápido
- **Bandera `--think`** - Muestra texto completo de razonamiento/pensamiento IA (sin truncar)
- **Bandera `--fullread`** - Muestra contenido completo de lectura de archivos en lugar de previsualizaciones
- **Bandera `--error`** - Muestra mensajes de error completos en lugar de previsualización de 300 caracteres
- **Bandera `--only <tipos>`** - Filtra mensajes por tipo: `user`, `assistant`, `tool`, `thinking`, `error` (separados por comas)

## Dónde almacena datos Cursor

| Plataforma | Ruta |
|------------|------|
| macOS | `~/Library/Application Support/Cursor/User/` |
| Windows | `%APPDATA%/Cursor/User/` |
| Linux | `~/.config/Cursor/User/` |

La herramienta encuentra y lee automáticamente tu historial de chat de Cursor desde estas ubicaciones.

## API de biblioteca

Además del CLI, puedes usar cursor-history como biblioteca en tus proyectos Node.js:

```typescript
import {
  listSessions,
  getSession,
  searchSessions,
  exportSessionToMarkdown
} from 'cursor-history';

// Listar todas las sesiones con paginación
const result = listSessions({ limit: 10 });
console.log(`Encontradas ${result.pagination.total} sesiones`);

for (const session of result.data) {
  console.log(`${session.id}: ${session.messageCount} mensajes`);
}

// Obtener una sesión específica (índice basado en cero)
const session = getSession(0);
console.log(session.messages);

// Buscar en todas las sesiones
const results = searchSessions('authentication', { context: 2 });
for (const match of results) {
  console.log(match.match);
}

// Exportar a Markdown
const markdown = exportSessionToMarkdown(0);
```

### API de migración

```typescript
import { migrateSession, migrateWorkspace } from 'cursor-history';

// Mover una sesión a otro espacio de trabajo
const results = migrateSession({
  sessions: 3,  // índice o ID
  destination: '/ruta/a/nuevo/proyecto'
});

// Copiar múltiples sesiones (mantiene originales)
const results = migrateSession({
  sessions: [1, 3, 5],
  destination: '/ruta/a/proyecto',
  mode: 'copy'
});

// Migrar todas las sesiones entre espacios de trabajo
const result = migrateWorkspace({
  source: '/proyecto/antiguo',
  destination: '/proyecto/nuevo'
});
console.log(`Migradas ${result.successCount} sesiones`);
```

### API de respaldo

```typescript
import {
  createBackup,
  restoreBackup,
  validateBackup,
  listBackups,
  getDefaultBackupDir
} from 'cursor-history';

// Crear un respaldo
const result = await createBackup({
  outputPath: '~/mi-respaldo.zip',
  force: true,
  onProgress: (progress) => {
    console.log(`${progress.phase}: ${progress.filesCompleted}/${progress.totalFiles}`);
  }
});
console.log(`Respaldo creado: ${result.backupPath}`);
console.log(`Sesiones: ${result.manifest.stats.sessionCount}`);

// Validar un respaldo
const validation = validateBackup('~/backup.zip');
if (validation.status === 'valid') {
  console.log('El respaldo es válido');
} else if (validation.status === 'warnings') {
  console.log('El respaldo tiene advertencias:', validation.corruptedFiles);
}

// Restaurar desde respaldo
const restoreResult = restoreBackup({
  backupPath: '~/backup.zip',
  force: true
});
console.log(`Restaurados ${restoreResult.filesRestored} archivos`);

// Listar respaldos disponibles
const backups = listBackups();  // Escanea ~/cursor-history-backups/
for (const backup of backups) {
  console.log(`${backup.filename}: ${backup.manifest?.stats.sessionCount} sesiones`);
}

// Leer sesiones de respaldo sin restaurar
const sessions = listSessions({ backupPath: '~/backup.zip' });
```

### Funciones disponibles

| Función | Descripción |
|---------|-------------|
| `listSessions(config?)` | Listar sesiones con paginación |
| `getSession(index, config?)` | Obtener sesión completa por índice |
| `searchSessions(query, config?)` | Buscar en sesiones |
| `exportSessionToJson(index, config?)` | Exportar sesión a JSON |
| `exportSessionToMarkdown(index, config?)` | Exportar sesión a Markdown |
| `exportAllSessionsToJson(config?)` | Exportar todas las sesiones a JSON |
| `exportAllSessionsToMarkdown(config?)` | Exportar todas las sesiones a Markdown |
| `migrateSession(config)` | Mover/copiar sesiones a otro espacio de trabajo |
| `migrateWorkspace(config)` | Mover/copiar todas las sesiones entre espacios de trabajo |
| `createBackup(config?)` | Crear respaldo completo de todo el historial |
| `restoreBackup(config)` | Restaurar historial desde respaldo |
| `validateBackup(path)` | Validar integridad del respaldo |
| `listBackups(directory?)` | Listar archivos de respaldo disponibles |
| `getDefaultBackupDir()` | Obtener ruta del directorio de respaldo por defecto |
| `getDefaultDataPath()` | Obtener ruta de datos de Cursor específica de plataforma |
| `setDriver(name)` | Establecer controlador SQLite ('better-sqlite3' o 'node:sqlite') |
| `getActiveDriver()` | Obtener nombre del controlador SQLite actualmente activo |

### Opciones de configuración

```typescript
interface LibraryConfig {
  dataPath?: string;       // Ruta personalizada de datos de Cursor
  workspace?: string;      // Filtrar por ruta de espacio de trabajo
  limit?: number;          // Límite de paginación
  offset?: number;         // Desplazamiento de paginación
  context?: number;        // Líneas de contexto de búsqueda
  backupPath?: string;     // Leer desde archivo de respaldo en lugar de datos en vivo
  sqliteDriver?: 'better-sqlite3' | 'node:sqlite';  // Forzar controlador SQLite específico
  messageFilter?: MessageType[];  // Filtrar mensajes por tipo (user, assistant, tool, thinking, error)
}
```

### Manejo de errores

```typescript
import {
  listSessions,
  getSession,
  createBackup,
  isDatabaseLockedError,
  isDatabaseNotFoundError,
  isSessionNotFoundError,
  isWorkspaceNotFoundError,
  isInvalidFilterError,
  isBackupError,
  isRestoreError,
  isInvalidBackupError
} from 'cursor-history';

try {
  const result = listSessions();
} catch (err) {
  if (isDatabaseLockedError(err)) {
    console.error('Base de datos bloqueada - cierra Cursor y reintenta');
  } else if (isDatabaseNotFoundError(err)) {
    console.error('Datos de Cursor no encontrados');
  } else if (isSessionNotFoundError(err)) {
    console.error('Sesión no encontrada');
  } else if (isWorkspaceNotFoundError(err)) {
    console.error('Espacio de trabajo no encontrado - abre primero el proyecto en Cursor');
  }
}

// Manejo de errores de filtro
try {
  const session = getSession(0, { messageFilter: ['invalid'] });
} catch (err) {
  if (isInvalidFilterError(err)) {
    console.error('Tipos de filtro inválidos:', err.invalidTypes);
    console.error('Tipos válidos:', err.validTypes);
  }
}

// Errores específicos de respaldo
try {
  const result = await createBackup();
} catch (err) {
  if (isBackupError(err)) {
    console.error('Respaldo fallido:', err.message);
  } else if (isInvalidBackupError(err)) {
    console.error('Archivo de respaldo inválido');
  } else if (isRestoreError(err)) {
    console.error('Restauración fallida:', err.message);
  }
}
```

## Desarrollo

### Compilar desde fuente

```bash
npm install
npm run build
```

### Ejecutar pruebas

```bash
npm test              # Ejecutar todas las pruebas
npm run test:watch    # Modo observación
```

### Publicar en NPM

Este proyecto usa GitHub Actions para publicación automática en NPM. Para publicar una nueva versión:

1. Actualizar versión en `package.json`:
   ```bash
   npm version patch  # Para correcciones de bugs (0.1.0 -> 0.1.1)
   npm version minor  # Para nuevas características (0.1.0 -> 0.2.0)
   npm version major  # Para cambios importantes (0.1.0 -> 1.0.0)
   ```

2. Empujar la etiqueta de versión para disparar publicación automática:
   ```bash
   git push origin main --tags
   ```

3. El flujo de trabajo de GitHub automáticamente:
   - Ejecutará verificaciones de tipos, linting y pruebas
   - Compilará el proyecto
   - Publicará en NPM con procedencia

**Configuración inicial**: Agrega tu token de acceso NPM como secreto de GitHub llamado `NPM_TOKEN`:
1. Crea un token de acceso NPM en https://www.npmjs.com/settings/YOUR_USERNAME/tokens
2. Ve a configuración de tu repositorio GitHub → Secrets and variables → Actions
3. Agrega un nuevo secreto de repositorio llamado `NPM_TOKEN` con tu token NPM

## Contribuir

¡Damos la bienvenida a contribuciones de la comunidad! Así puedes ayudar:

### Reportar problemas

- **Reportes de bugs**: [Abre un issue](https://github.com/S2thend/cursor_chat_history/issues/new) con pasos para reproducir, comportamiento esperado vs real, y tu entorno (SO, versión Node.js)
- **Solicitudes de características**: [Abre un issue](https://github.com/S2thend/cursor_chat_history/issues/new) describiendo la característica y su caso de uso

### Enviar Pull Requests

1. Haz fork del repositorio
2. Crea una rama de característica (`git checkout -b feature/mi-caracteristica`)
3. Haz tus cambios
4. Ejecuta pruebas y linting (`npm test && npm run lint`)
5. Haz commit de tus cambios (`git commit -m 'Agrega mi característica'`)
6. Empuja a tu fork (`git push origin feature/mi-caracteristica`)
7. [Abre un Pull Request](https://github.com/S2thend/cursor_chat_history/pulls)

### Configuración del entorno de desarrollo

```bash
git clone https://github.com/S2thend/cursor_chat_history.git
cd cursor_chat_history
npm install
npm run build
npm test
```

## Licencia

MIT
