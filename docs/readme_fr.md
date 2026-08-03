# Cursor History

<p align="center">
  <img src="logo.png" alt="cursor-history logo" width="200">
</p>

[![npm version](https://img.shields.io/npm/v/cursor-history.svg)](https://www.npmjs.com/package/cursor-history)
[![npm downloads](https://img.shields.io/npm/dm/cursor-history.svg)](https://www.npmjs.com/package/cursor-history)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0%2B-blue.svg)](https://www.typescriptlang.org/)

**L'outil open-source ultime pour parcourir, rechercher, exporter et sauvegarder votre historique de chat Cursor AI.**

Un outil CLI de style POSIX qui fait une chose bien : accéder à votre historique de chat Cursor AI. Construit sur la philosophie Unix — simple, composable et ciblé.

```bash
# Compatible avec les pipes : combinez avec d'autres outils
cursor-history list --json | jq '.[] | select(.messageCount > 10)'
cursor-history export 1 | grep -i "api" | head -20
cursor-history search "bug" --json | jq -r '.[].sessionId' | xargs -I {} cursor-history export {}
```

Ne perdez plus jamais une conversation. Que vous ayez besoin de retrouver ce snippet de code parfait de la semaine dernière, de migrer votre historique vers une nouvelle machine, ou de créer des sauvegardes fiables de toutes vos sessions de développement assisté par IA — cursor-history est là pour vous. Gratuit, open-source, et construit par la communauté pour la communauté.

## Fonctionnalités

- **Double interface** - Utilisable en tant qu'outil CLI ou importable comme bibliothèque dans vos projets Node.js
- **Liste des sessions** - Voir toutes les sessions de chat à travers les espaces de travail
- **Conversations complètes** - Voir l'historique complet des chats avec :
  - Réponses IA avec explications en langage naturel
  - **Affichage complet des diff** pour les modifications de fichiers avec coloration syntaxique
  - **Appels d'outils détaillés** montrant tous les paramètres (chemins de fichiers, motifs de recherche, commandes, etc.)
  - Raisonnement et réflexion de l'IA
  - Horodatages des messages (précis pour toutes les sessions, y compris avant septembre 2025)
- **Recherche** - Trouver des conversations par mot-clé avec mise en évidence des correspondances
- **Export** - Sauvegarder les sessions en fichiers Markdown ou JSON
- **Migration** - Déplacer ou copier des sessions entre espaces de travail (ex. lors du renommage de projets)
- **Sauvegarde et restauration** - Créer des sauvegardes complètes de tout l'historique et restaurer si nécessaire
- **Multi-plateforme** - Fonctionne sur macOS, Windows et Linux

## Installation

### Depuis NPM (Recommandé)

```bash
# Installation globale
npm install -g cursor-history

# Utiliser le CLI
cursor-history list
```

### Depuis les sources

```bash
# Cloner et compiler
git clone https://github.com/S2thend/cursor_chat_history.git
cd cursor_chat_history
npm install
npm run build

# Exécuter directement
node dist/cli/index.js list

# Ou lier globalement
npm link
cursor-history list
```

## Prérequis

- Node.js 20+ (Node.js 22.5+ recommandé pour le support SQLite intégré)
- Cursor IDE (avec un historique de chat existant)

## Configuration du pilote SQLite

cursor-history supporte deux pilotes SQLite pour une compatibilité maximale :

| Pilote | Description | Version Node.js |
|--------|-------------|-----------------|
| `node:sqlite` | Module SQLite intégré à Node.js (pas de bindings natifs) | 22.5+ |
| `better-sqlite3` | Bindings natifs via better-sqlite3 | 20+ |

### Sélection automatique du pilote

Par défaut, cursor-history sélectionne automatiquement le meilleur pilote disponible :

1. **node:sqlite** (préféré) - Fonctionne sur Node.js 22.5+ sans compilation native
2. **better-sqlite3** (repli) - Fonctionne sur les versions plus anciennes de Node.js

### Sélection manuelle du pilote

Vous pouvez forcer un pilote spécifique en utilisant la variable d'environnement :

```bash
# Forcer better-sqlite3
CURSOR_HISTORY_SQLITE_DRIVER=better-sqlite3 cursor-history list

# Forcer node:sqlite (nécessite Node.js 22.5+)
CURSOR_HISTORY_SQLITE_DRIVER=node:sqlite cursor-history list
```

### Déboguer la sélection du pilote

Pour voir quel pilote est utilisé :

```bash
DEBUG=cursor-history:* cursor-history list
```

### Contrôle du pilote via l'API bibliothèque

Lors de l'utilisation de cursor-history comme bibliothèque, vous pouvez contrôler le pilote par programmation :

```typescript
import { setDriver, getActiveDriver, listSessions } from 'cursor-history';

// Forcer un pilote spécifique avant toute opération
setDriver('better-sqlite3');

// Vérifier quel pilote est actif
const driver = getActiveDriver();
console.log(`Pilote utilisé : ${driver}`);

// Ou configurer via LibraryConfig
const result = await listSessions({
  sqliteDriver: 'node:sqlite'  // Forcer node:sqlite pour cet appel
});
```

## Utilisation

### Lister les sessions

```bash
# Lister les sessions récentes (par défaut : 20)
cursor-history list

# Lister toutes les sessions
cursor-history list --all

# Lister avec les IDs composer (pour les outils externes)
cursor-history list --ids

# Limiter les résultats
cursor-history list -n 10

# Lister uniquement les espaces de travail
cursor-history list --workspaces
```

### Voir une session

```bash
# Afficher une session par numéro d'index
cursor-history show 1

# Afficher avec messages tronqués (aperçu rapide)
cursor-history show 1 --short

# Afficher le texte complet de réflexion/raisonnement de l'IA
cursor-history show 1 --think

# Afficher le contenu complet des lectures de fichiers (non tronqué)
cursor-history show 1 --fullread

# Afficher les messages d'erreur complets (non tronqués à 300 caractères)
cursor-history show 1 --error

# Filtrer par type de message (user, assistant, tool, thinking, error)
cursor-history show 1 --only user
cursor-history show 1 --only user,assistant
cursor-history show 1 --only tool,error

# Combiner les options
cursor-history show 1 --short --think --fullread --error
cursor-history show 1 --only user,assistant --short

# Sortie en JSON
cursor-history show 1 --json
```

### Rechercher

```bash
# Rechercher un mot-clé
cursor-history search "react hooks"

# Limiter les résultats
cursor-history search "api" -n 5

# Ajuster le contexte autour des correspondances
cursor-history search "error" --context 100
```

### Exporter

```bash
# Exporter une seule session en Markdown
cursor-history export 1

# Exporter vers un fichier spécifique
cursor-history export 1 -o ./mon-chat.md

# Exporter en JSON
cursor-history export 1 --format json

# Exporter toutes les sessions vers un répertoire
cursor-history export --all -o ./exports/

# Écraser les fichiers existants
cursor-history export 1 --force
```

### Migrer des sessions

```bash
# Déplacer une seule session vers un autre espace de travail
cursor-history migrate-session 1 /chemin/vers/nouveau/projet

# Déplacer plusieurs sessions (indices ou IDs séparés par des virgules)
cursor-history migrate-session 1,3,5 /chemin/vers/projet

# Copier au lieu de déplacer (garde l'original)
cursor-history migrate-session --copy 1 /chemin/vers/projet

# Prévisualiser ce qui se passerait sans effectuer de changements
cursor-history migrate-session --dry-run 1 /chemin/vers/projet

# Déplacer toutes les sessions d'un espace de travail vers un autre
cursor-history migrate /ancien/projet /nouveau/projet

# Copier toutes les sessions (sauvegarde)
cursor-history migrate --copy /projet /sauvegarde/projet

# Forcer la fusion avec les sessions existantes à la destination
cursor-history migrate --force /ancien/projet /projet/existant
```

### Sauvegarde et restauration

```bash
# Créer une sauvegarde de tout l'historique
cursor-history backup

# Créer une sauvegarde vers un fichier spécifique
cursor-history backup -o ~/ma-sauvegarde.zip

# Écraser une sauvegarde existante
cursor-history backup --force

# Lister les sauvegardes disponibles
cursor-history list-backups

# Lister les sauvegardes dans un répertoire spécifique
cursor-history list-backups -d /chemin/vers/sauvegardes

# Restaurer depuis une sauvegarde
cursor-history restore ~/cursor-history-backups/backup.zip

# Restaurer vers un emplacement personnalisé
cursor-history restore backup.zip --target /cursor/data/personnalisé

# Forcer l'écrasement des données existantes
cursor-history restore backup.zip --force

# Voir les sessions d'une sauvegarde sans restaurer
cursor-history list --backup ~/backup.zip
cursor-history show 1 --backup ~/backup.zip
cursor-history search "requête" --backup ~/backup.zip
cursor-history export 1 --backup ~/backup.zip
```

### Options globales

```bash
# Sortie en JSON (fonctionne avec toutes les commandes)
cursor-history --json list

# Utiliser un chemin de données Cursor personnalisé
cursor-history --data-path ~/.cursor-alt list

# Filtrer par espace de travail
cursor-history --workspace /chemin/vers/projet list
```

## Ce que vous pouvez voir

En parcourant votre historique de chat, vous verrez :

- **Conversations complètes** - Tous les messages échangés avec Cursor AI
- **Chaque message rendu** - Chaque message résolu est affiché une fois dans l'ordre ; les doublons consécutifs ne sont pas pliés, afin que les appels d'outils, la provenance et les données de tokens distincts ne soient jamais masqués
- **Horodatages** - L'heure directement stockée d'un message quand elle est disponible (format HH:MM:SS) ; les messages sans heure directement stockée n'affichent pas d'horodatage plutôt qu'un repli fabriqué
- **Sessions fusionnées entre piles** - Quand la même session existe à la fois dans la pile Composer (vscdb) et Store (~/.cursor), les deux représentations sont fusionnées champ par champ (aucune n'est écartée), la source principale étant choisie par plateforme (WSL préfère Store ; Windows/macOS/Linux natif préfèrent Composer)
- **Actions des outils IA** - Vue détaillée de ce que Cursor AI a fait :
  - **Modifications/écritures de fichiers** - Affichage complet des diff avec coloration syntaxique montrant exactement ce qui a changé
  - **Lectures de fichiers** - Chemins de fichiers et aperçus du contenu (utilisez `--fullread` pour le contenu complet)
  - **Opérations de recherche** - Motifs, chemins et requêtes de recherche utilisés
  - **Commandes terminal** - Texte complet des commandes
  - **Listages de répertoires** - Chemins explorés
  - **Erreurs d'outils** - Opérations échouées/annulées affichées avec l'indicateur de statut ❌ et les paramètres
  - **Décisions utilisateur** - Indique si vous avez accepté (✓), rejeté (✗), ou en attente (⏳) les opérations d'outils
  - **Erreurs** - Messages d'erreur avec mise en évidence emoji ❌ (extraits de `toolFormerData.additionalData.status`)
- **Raisonnement IA** - Voir le processus de réflexion de l'IA derrière les décisions (utilisez `--think` pour le texte complet)
- **Artefacts de code** - Diagrammes Mermaid, blocs de code, avec coloration syntaxique
- **Explications en langage naturel** - Explications IA combinées avec le code pour un contexte complet

### Options d'affichage

- **Vue par défaut** - Messages complets avec réflexion tronquée (200 car.), lectures de fichiers (100 car.) et erreurs (300 car.)
- **Mode `--short`** - Tronque les messages utilisateur et assistant à 300 caractères pour un scan rapide
- **Drapeau `--think`** - Affiche le texte complet de raisonnement/réflexion IA (non tronqué)
- **Drapeau `--fullread`** - Affiche le contenu complet des lectures de fichiers au lieu des aperçus
- **Drapeau `--error`** - Affiche les messages d'erreur complets au lieu de l'aperçu de 300 caractères
- **Drapeau `--only <types>`** - Filtre les messages par type : `user`, `assistant`, `tool`, `thinking`, `error` (séparés par des virgules)

## Où Cursor stocke les données

| Plateforme | Chemin |
|------------|--------|
| macOS | `~/Library/Application Support/Cursor/User/` |
| Windows | `%APPDATA%/Cursor/User/` |
| Linux | `~/.config/Cursor/User/` |

L'outil trouve et lit automatiquement votre historique de chat Cursor depuis ces emplacements.

## API Bibliothèque

En plus du CLI, vous pouvez utiliser cursor-history comme bibliothèque dans vos projets Node.js :

```typescript
import {
  listSessions,
  getSession,
  searchSessions,
  exportSessionToMarkdown
} from 'cursor-history';

// Lister toutes les sessions avec pagination
const result = listSessions({ limit: 10 });
console.log(`Trouvé ${result.pagination.total} sessions`);

for (const session of result.data) {
  console.log(`${session.id}: ${session.messageCount} messages`);
}

// Obtenir une session spécifique (index à base zéro)
const session = getSession(0);
console.log(session.messages);

// Rechercher dans toutes les sessions
const results = searchSessions('authentication', { context: 2 });
for (const match of results) {
  console.log(match.match);
}

// Exporter en Markdown
const markdown = exportSessionToMarkdown(0);
```

### API de migration

```typescript
import { migrateSession, migrateWorkspace } from 'cursor-history';

// Déplacer une session vers un autre espace de travail
const results = migrateSession({
  sessions: 3,  // index ou ID
  destination: '/chemin/vers/nouveau/projet'
});

// Copier plusieurs sessions (garde les originaux)
const results = migrateSession({
  sessions: [1, 3, 5],
  destination: '/chemin/vers/projet',
  mode: 'copy'
});

// Migrer toutes les sessions entre espaces de travail
const result = migrateWorkspace({
  source: '/ancien/projet',
  destination: '/nouveau/projet'
});
console.log(`Migré ${result.successCount} sessions`);
```

### API de sauvegarde

```typescript
import {
  createBackup,
  restoreBackup,
  validateBackup,
  listBackups,
  getDefaultBackupDir
} from 'cursor-history';

// Créer une sauvegarde
const result = await createBackup({
  outputPath: '~/ma-sauvegarde.zip',
  force: true,
  onProgress: (progress) => {
    console.log(`${progress.phase}: ${progress.filesCompleted}/${progress.totalFiles}`);
  }
});
console.log(`Sauvegarde créée : ${result.backupPath}`);
console.log(`Sessions : ${result.manifest.stats.sessionCount}`);

// Valider une sauvegarde
const validation = validateBackup('~/backup.zip');
if (validation.status === 'valid') {
  console.log('La sauvegarde est valide');
} else if (validation.status === 'warnings') {
  console.log('La sauvegarde a des avertissements :', validation.corruptedFiles);
}

// Restaurer depuis une sauvegarde
const restoreResult = restoreBackup({
  backupPath: '~/backup.zip',
  force: true
});
console.log(`Restauré ${restoreResult.filesRestored} fichiers`);

// Lister les sauvegardes disponibles
const backups = listBackups();  // Scanne ~/cursor-history-backups/
for (const backup of backups) {
  console.log(`${backup.filename}: ${backup.manifest?.stats.sessionCount} sessions`);
}

// Lire les sessions depuis une sauvegarde sans restaurer
const sessions = listSessions({ backupPath: '~/backup.zip' });
```

### Fonctions disponibles

| Fonction | Description |
|----------|-------------|
| `listSessions(config?)` | Lister les sessions avec pagination |
| `getSession(index, config?)` | Obtenir une session complète par index |
| `searchSessions(query, config?)` | Rechercher dans les sessions |
| `exportSessionToJson(index, config?)` | Exporter une session en JSON |
| `exportSessionToMarkdown(index, config?)` | Exporter une session en Markdown |
| `exportAllSessionsToJson(config?)` | Exporter toutes les sessions en JSON |
| `exportAllSessionsToMarkdown(config?)` | Exporter toutes les sessions en Markdown |
| `migrateSession(config)` | Déplacer/copier des sessions vers un autre espace de travail |
| `migrateWorkspace(config)` | Déplacer/copier toutes les sessions entre espaces de travail |
| `createBackup(config?)` | Créer une sauvegarde complète de tout l'historique |
| `restoreBackup(config)` | Restaurer l'historique depuis une sauvegarde |
| `validateBackup(path)` | Valider l'intégrité d'une sauvegarde |
| `listBackups(directory?)` | Lister les fichiers de sauvegarde disponibles |
| `getDefaultBackupDir()` | Obtenir le chemin du répertoire de sauvegarde par défaut |
| `getDefaultDataPath()` | Obtenir le chemin des données Cursor spécifique à la plateforme |
| `setDriver(name)` | Définir le pilote SQLite ('better-sqlite3' ou 'node:sqlite') |
| `getActiveDriver()` | Obtenir le nom du pilote SQLite actuellement actif |

### Options de configuration

```typescript
interface LibraryConfig {
  dataPath?: string;       // Chemin personnalisé des données Cursor
  workspace?: string;      // Filtrer par chemin d'espace de travail
  limit?: number;          // Limite de pagination
  offset?: number;         // Décalage de pagination
  context?: number;        // Lignes de contexte de recherche
  backupPath?: string;     // Lire depuis un fichier de sauvegarde au lieu des données en direct
  sqliteDriver?: 'better-sqlite3' | 'node:sqlite';  // Forcer un pilote SQLite spécifique
  messageFilter?: MessageType[];  // Filtrer les messages par type (user, assistant, tool, thinking, error)
}
```

### Gestion des erreurs

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
    console.error('Base de données verrouillée - fermez Cursor et réessayez');
  } else if (isDatabaseNotFoundError(err)) {
    console.error('Données Cursor non trouvées');
  } else if (isSessionNotFoundError(err)) {
    console.error('Session non trouvée');
  } else if (isWorkspaceNotFoundError(err)) {
    console.error('Espace de travail non trouvé - ouvrez d\'abord le projet dans Cursor');
  }
}

// Gestion des erreurs de filtre
try {
  const session = getSession(0, { messageFilter: ['invalid'] });
} catch (err) {
  if (isInvalidFilterError(err)) {
    console.error('Types de filtre invalides :', err.invalidTypes);
    console.error('Types valides :', err.validTypes);
  }
}

// Erreurs spécifiques aux sauvegardes
try {
  const result = await createBackup();
} catch (err) {
  if (isBackupError(err)) {
    console.error('Échec de la sauvegarde :', err.message);
  } else if (isInvalidBackupError(err)) {
    console.error('Fichier de sauvegarde invalide');
  } else if (isRestoreError(err)) {
    console.error('Échec de la restauration :', err.message);
  }
}
```

## Développement

### Compiler depuis les sources

```bash
npm install
npm run build
```

### Exécuter les tests

```bash
npm test              # Exécuter tous les tests
npm run test:watch    # Mode surveillance
```

### Publier sur NPM

Ce projet utilise GitHub Actions pour la publication automatique sur NPM. Pour publier une nouvelle version :

1. Mettre à jour la version dans `package.json` :
   ```bash
   npm version patch  # Pour les corrections de bugs (0.1.0 -> 0.1.1)
   npm version minor  # Pour les nouvelles fonctionnalités (0.1.0 -> 0.2.0)
   npm version major  # Pour les changements majeurs (0.1.0 -> 1.0.0)
   ```

2. Pousser le tag de version pour déclencher la publication automatique :
   ```bash
   git push origin main --tags
   ```

3. Le workflow GitHub va automatiquement :
   - Exécuter les vérifications de types, le linting et les tests
   - Compiler le projet
   - Publier sur NPM avec provenance

**Configuration initiale** : Ajoutez votre token d'accès NPM comme secret GitHub nommé `NPM_TOKEN` :
1. Créez un token d'accès NPM sur https://www.npmjs.com/settings/YOUR_USERNAME/tokens
2. Allez dans les paramètres de votre dépôt GitHub → Secrets and variables → Actions
3. Ajoutez un nouveau secret de dépôt nommé `NPM_TOKEN` avec votre token NPM

## Contribuer

Nous accueillons les contributions de la communauté ! Voici comment vous pouvez aider :

### Signaler des problèmes

- **Rapports de bugs** : [Ouvrez une issue](https://github.com/S2thend/cursor_chat_history/issues/new) avec les étapes pour reproduire, le comportement attendu vs réel, et votre environnement (OS, version Node.js)
- **Demandes de fonctionnalités** : [Ouvrez une issue](https://github.com/S2thend/cursor_chat_history/issues/new) décrivant la fonctionnalité et son cas d'utilisation

### Soumettre des Pull Requests

1. Forkez le dépôt
2. Créez une branche de fonctionnalité (`git checkout -b feature/ma-fonctionnalite`)
3. Faites vos modifications
4. Exécutez les tests et le linting (`npm test && npm run lint`)
5. Committez vos modifications (`git commit -m 'Ajoute ma fonctionnalité'`)
6. Poussez vers votre fork (`git push origin feature/ma-fonctionnalite`)
7. [Ouvrez une Pull Request](https://github.com/S2thend/cursor_chat_history/pulls)

### Configuration de l'environnement de développement

```bash
git clone https://github.com/S2thend/cursor_chat_history.git
cd cursor_chat_history
npm install
npm run build
npm test
```

## Licence

MIT
