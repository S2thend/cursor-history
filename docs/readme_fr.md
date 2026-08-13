# Cursor History

<p align="center">
  <img src="logo.png" alt="cursor-history logo" width="200">
</p>

[![npm version](https://img.shields.io/npm/v/cursor-history.svg)](https://www.npmjs.com/package/cursor-history)
[![npm downloads](https://img.shields.io/npm/dm/cursor-history.svg)](https://www.npmjs.com/package/cursor-history)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-20%2C%2022--26-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0%2B-blue.svg)](https://www.typescriptlang.org/)

> **Contrat de compatibilité :** le document canonique en anglais
> [Compatibility and Data-Integrity Contract](./compatibility.md) définit l'identité stable, la
> portée et la base des indices, la frontière d'E/S par espace de travail, la fidélité/provenance,
> les horodatages inférés, les limites de lecture, les permissions de sauvegarde et les exemples
> CLI/bibliothèque vérifiés. En cas de divergence, ce contrat fait autorité.
>
> Les consommateurs incrémentaux de la bibliothèque doivent épingler v0.16 jusqu'à validation de
> v0.18.0 avant une mise à niveau depuis v0.17. Le chemin sans modification du
> consommateur est garanti pour les archives v0.16 Composer uniquement ; il ne promet pas de
> conserver les ID Store synthétiques instables de v0.17.
>
> v0.18.0 corrige directement les coordonnées publiques de recherche de v0.16/v0.17 et ajoute
> l'index zéro-basé aux exports JSON comme nouvelle métadonnée. Le contrat canonique définit aussi
> le point de publication et les erreurs typées de permissions ou de nettoyage après publication ;
> un chemin résiduel non vérifié ne doit jamais être supprimé à l'aveugle. La
> restauration ignore les entrées corrompues et refuse les chemins, destinations dupliquées ou
> liens non sûrs avant toute écriture ; `--force` ne désactive pas ces contrôles. Après toute
> publication, un échec ne tente aucun retour arrière automatique : il préserve chaque fichier et
> renvoie `RESTORE_ROLLBACK_INCOMPLETE` ; arrêtez Cursor et restaurez une sauvegarde fiable.

**L'outil open-source ultime pour parcourir, rechercher, exporter et sauvegarder votre historique de chat Cursor AI.**

Un outil CLI de style POSIX qui fait une chose bien : accéder à votre historique de chat Cursor AI. Construit sur la philosophie Unix — simple, composable et ciblé.

```bash
# Compatible avec les pipes : combinez avec d'autres outils
cursor-history list --json | jq '.sessions[] | select(.messageCount > 10)'
cursor-history export 1 | grep -i "api" | head -20
cursor-history search "bug" --json | jq -r '.results[].sessionId' | xargs -I {} cursor-history export {}
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
  - Horodatages avec provenance explicite (stockée ou inférée)
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

- Node.js 20.x ou 22.x–26.x (Node 21 n'est pas pris en charge ; Node.js 22.5+ est recommandé pour SQLite intégré)
- Cursor IDE (avec un historique de chat existant)

## Configuration du pilote SQLite

cursor-history supporte deux pilotes SQLite pour une compatibilité maximale :

| Pilote | Description | Limite de capacité Node.js |
|--------|-------------|----------------------------|
| `node:sqlite` | Module intégré ; sélectionné uniquement s'il fournit toutes les API requises | Lecture dès 22.5 ; sauvegarde en ligne dès 22.16.0 et 23.8.0 |
| `better-sqlite3` | Binding natif et repli automatique lorsqu'il est capable | Versions majeures 20 et 22–26 |

### Sélection automatique du pilote

cursor-history sélectionne par opération et vérifie les capacités réelles, pas seulement si le
module s'importe :

1. il préfère **node:sqlite** lorsque toutes les API requises sont disponibles ;
2. sinon il utilise un **better-sqlite3** installé et capable.

Un pilote forcé ne se replie jamais sur l'autre : une capacité manquante produit une erreur typée
et une solution exploitable.

### Sélection manuelle du pilote

Vous pouvez forcer un pilote spécifique en utilisant la variable d'environnement :

```bash
# Forcer better-sqlite3
CURSOR_HISTORY_SQLITE_DRIVER=better-sqlite3 cursor-history list

# Forcer node:sqlite (doit fournir toutes les API requises par l'opération)
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
- **Sessions résolues entre piles** - Quand le même UUID existe dans Composer et Store, cursor-history conserve les identités Composer compatibles et produit une vue à provenance explicite. La portée de l'espace de travail est appliquée avant la lecture du contenu : une source connue hors frontière n'est pas ouverte et rend la vue partielle ; les sources permises suivent la politique canonique de backbone et d'enrichissement, pas une fusion aveugle champ par champ.
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
const result = await listSessions({ limit: 10 });
console.log(`Trouvé ${result.pagination.total} sessions`);

for (const session of result.data) {
  console.log(`${session.id}: ${session.messageCount} messages`);
}

// Obtenir une session spécifique (index à base zéro)
const session = await getSession(0);
console.log(session.messages);

// Rechercher dans toutes les sessions
const results = await searchSessions('authentication', { context: 2 });
for (const match of results) {
  // Index dans le tableau complet, décalage UTF-16 et ligne source complète.
  console.log(match.messageIndex, match.offset, match.match);
}

// Exporter en Markdown
const markdown = await exportSessionToMarkdown(0);
```

### API de migration

```typescript
import { migrateSession, migrateWorkspace } from 'cursor-history';

// Déplacer une session vers un autre espace de travail
const moveResults = await migrateSession({
  sessions: 3,  // index ou ID
  destination: '/chemin/vers/nouveau/projet'
});
console.log(moveResults);

// Copier plusieurs sessions (garde les originaux)
const copyResults = await migrateSession({
  sessions: [1, 3, 5],
  destination: '/chemin/vers/projet',
  mode: 'copy'
});
console.log(copyResults);

// Migrer toutes les sessions entre espaces de travail
const workspaceResult = await migrateWorkspace({
  source: '/ancien/projet',
  destination: '/nouveau/projet'
});
console.log(`Migré ${workspaceResult.successCount} sessions`);
```

### API de sauvegarde

```typescript
import {
  createBackup,
  restoreBackup,
  validateBackup,
  listBackups,
  getDefaultBackupDir,
  listSessions
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
const validation = await validateBackup('~/backup.zip');
if (validation.status === 'valid') {
  console.log('La sauvegarde est valide');
} else if (validation.status === 'warnings') {
  console.log('La sauvegarde a des avertissements :', validation.corruptedFiles);
}

// Restaurer depuis une sauvegarde
const restoreResult = await restoreBackup({
  backupPath: '~/backup.zip',
  force: true
});
console.log(`Restauré ${restoreResult.filesRestored} fichiers`);
// Consultez restoreResult.warnings : les entrées corrompues sont ignorées, jamais restaurées.

// Lister les sauvegardes disponibles
const backups = await listBackups();  // Scanne ~/cursor-history-backups/
for (const backup of backups) {
  console.log(`${backup.filename}: ${backup.manifest?.stats.sessionCount} sessions`);
}

// Lire les sessions depuis une sauvegarde sans restaurer
const sessions = await listSessions({ backupPath: '~/backup.zip' });
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
import type { MessageType } from 'cursor-history';

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
  createBackup,
  restoreBackup,
  isDatabaseLockedError,
  isDatabaseNotFoundError,
  isSessionNotFoundError,
  isWorkspaceNotFoundError,
  isBackupError,
  isBackupPublishedPermissionError,
  isRestoreRollbackError,
  isRestoreError,
  isInvalidBackupError,
  validateMessageTypes
} from 'cursor-history';

try {
  const result = await listSessions();
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

try {
  await createBackup({ outputPath: '/private/backups/cursor.zip' });
} catch (err) {
  if (isBackupPublishedPermissionError(err)) {
    if (err.details.pathIdentityVerified) {
      console.error('La sauvegarde publiée vérifiée nécessite une correction de mode :', err.details.outputPath);
    } else {
      // Le point de validation est franchi, mais ce chemin n'est pas fiable. Ne changez pas son mode ici.
      console.error("Le chemin de sauvegarde publié nécessite une récupération d'identité :", err.details.outputPath);
    }
  }
}

// Valider les valeurs de filtre non typées avant de les passer à une opération de lecture
const invalidTypes = validateMessageTypes(['invalid']);
if (invalidTypes.length > 0) {
  console.error('Types de filtre invalides :', invalidTypes);
}

// Erreurs spécifiques aux sauvegardes
try {
  await createBackup();
} catch (err) {
  if (isBackupError(err)) {
    console.error('Échec de la sauvegarde :', err.message);
  } else if (isInvalidBackupError(err)) {
    console.error('Fichier de sauvegarde invalide');
  } else if (isRestoreError(err)) {
    console.error('Échec de la restauration :', err.message);
  }
}

try {
  await restoreBackup({ backupPath: '/private/backups/cursor.zip', force: true });
} catch (err) {
  if (isRestoreRollbackError(err)) {
    // Ce sont des chemins relatifs au manifeste, jamais des localisateurs physiques privés.
    console.error('Récupération manuelle requise pour :', err.details.residualFiles);
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

### Publier sur npm

Les versions utilisent la publication de confiance npm via GitHub Actions. Aucun secret de dépôt
`NPM_TOKEN` n'est utilisé. Avant la première publication :

1. Configurez l'éditeur de confiance du paquet npm pour ce dépôt exact, saisissez
   `npm-publish.yml` comme nom du workflow (le fichier se trouve dans
   `.github/workflows/npm-publish.yml`), définissez l'environnement `npm-release-verification` et
   autorisez l'action `npm publish`.
2. Créez l'environnement GitHub `npm-release-verification`, imposez des mainteneurs désignés comme
   réviseurs et empêchez tout contournement non révisé conformément à la politique du dépôt.

Pour chaque version :

1. Mettez à jour et validez toutes les métadonnées versionnées et les notes de version, terminez les
   contrôles documentés, puis figez une révision propre.
2. Vérifiez que le tag n'existe pas, puis poussez uniquement ce tag (par exemple,
   `git push origin v0.18.0`). Ne poussez ni ne déplacez un tag avant que la révision soit figée.
3. Le workflow valide les sources et tous les environnements pris en charge, empaquette une seule
   fois et lie le candidat à sa révision et à son SHA-256. Une fois ces contrôles réussis, la vraie
   tâche `publish` s'arrête sur l'environnement protégé `npm-release-verification` avant de demander
   son jeton OIDC.
4. Téléchargez ce candidat adressé par sa somme et effectuez les contrôles privés de l'artefact exact
   décrits dans [release-verification.md](release-verification.md). N'approuvez l'environnement
   qu'après leur réussite.
5. L'approbation publie exactement ces octets conservés avec la provenance npm, sans nouvelle
   compilation ni nouvel empaquetage.

Tout échec de source, de runtime, d'artefact ou de vérification privée bloque la publication. Ne
forcez jamais silencieusement le déplacement d'un tag : corrigez explicitement un candidat non
publié et utilisez une nouvelle version si des octets ont déjà été publiés.

## Compatibilité de la v0.18

- Les UUID canoniques sont insensibles à la casse pour la recherche et le regroupement, mais l'ID
  renvoyé conserve l'orthographe réellement observée dans Cursor. Les identifiants non canoniques,
  notamment les noms Store compacts de 32 caractères hexadécimaux, restent exacts et sensibles à la
  casse.
- Une migration avec `--workspace` ne lit hors périmètre que les métadonnées nécessaires, lie les
  clés physiques exactes et prépare tout le lot avant la première écriture. Une cible ambiguë ou
  inéligible annule le lot sans modification.
- Lors de la fusion Composer/Store, les tours Store actifs placés au début, au milieu ou à la fin
  apparaissent une seule fois ; les branches latérales restent exclues et les anciens ID Composer ne
  changent pas.
- À date égale, les lignes Composer conservent l'ordre de découverte de la v0.16 fondé sur
  `String.localeCompare()` dans le même environnement pris en charge.
- Le manifeste de sauvegarde conserve `manifest.version: "1.0.0"` ; l'inventaire facultatif utilise
  son propre `schemaVersion: 1`. Consultez [compatibility.md](compatibility.md) pour le contrat
  normatif.

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
