# Améliorations RIG — Feuille de route

Analyse des lacunes de spec-gen pour en faire un RIG (Retrieval-Indexed Generation)
pleinement efficace.

---

## Contexte architectural

Le retrieval sert **deux usages distincts** aux contraintes opposées :

| | MCP / agents de coding | Génération de specs |
|---|---|---|
| **Latence** | Critique (<1s) | Non critique |
| **Exhaustivité** | Partielle (top-k) | Maximale |
| **Mode** | Interactif, requête unique | Batch, multi-hop |
| **Contexte** | Fourni par l'agent | Construit par le pipeline |

Ces deux usages partagent le **même index** mais appellent deux **stratégies de
retrieval distinctes** :

- **MCP / agents** → graph-first (call graph existant) puis semantic refinement.
  Rapide, ciblé.
- **Génération de specs** → semantic-first pour identifier les fichiers pertinents
  par domaine, puis graph expansion pour couvrir les dépendances indirectes.
  Lent, exhaustif.

spec-gen n'est pas un RAG classique (`code → vector DB → LLM`) mais un **GraphRAG** :

```
graph retrieval
      +
semantic retrieval
      ↓
spec synthesis / agent response
```

---

## Phase 1 — Fondations (bloquant) ✅

### ~~#1 — Le vector index n'est PAS utilisé pendant la génération (critique)~~ ✅

**Fichier :** `src/core/generator/spec-pipeline.ts`

`getSchemaFiles()`, `getServiceFiles()`, `getApiFiles()` sélectionnent les fichiers
par **heuristique de nom** (`name.includes('model')`, `name.includes('service')`…).
Le vector index est construit en option (`--embed`) mais n'est jamais interrogé
pendant les stages de génération.

**Objectif :** Remplacer les heuristiques de nommage par du retrieval sémantique,
puis étendre les résultats via le call graph (graph expansion) pour couvrir les
implémentations indirectes.

---

### ~~#2 — Corps de fonctions absents de l'index (élevé)~~ ✅

**Fichier :** `src/core/analyzer/vector-index.ts` — `buildText()`

Le texte embarqué = `[language] path qualifiedName + signature + docstring`.
Le **corps de la fonction** n'est pas indexé. Sans lui, impossible d'inférer les
règles métier (ex. `calculatePrice()` sans le body ne révèle pas les règles de
remise, de taxe, de devise).

**Solution recommandée : skeleton plutôt que body brut.**
`src/core/analyzer/code-shaper.ts` — `getSkeletonContent()` — est déjà implémenté.
Il supprime le bruit (logs, commentaires inline, lignes vides) tout en préservant
exactement les signaux utiles pour l'embedding :

- appels de fonctions → contexte topologique
- noms de variables → vocabulaire métier (`discount`, `taxRate`, `isVIP`)
- flux de contrôle → structure de la logique métier
- return / throw → contrats de sortie

`isSkeletonWorthIncluding()` existe déjà pour ignorer le skeleton quand il n'apporte
pas au moins 20% de réduction. Le body brut inclurait les logs, validations et
plomberie qui polluent l'espace d'embedding sans valeur sémantique ajoutée.
Un résumé LLM serait plus précis mais coûteux et non déterministe — le skeleton est
le bon compromis pour l'indexation à large échelle.

**Impact concret :** `buildText()` doit appeler `getSkeletonContent(body, node.language)`
et l'ajouter au texte uniquement si `isSkeletonWorthIncluding(body, skeleton)` est vrai.

---

### ~~#3 — Chunking par lignes vides plutôt que par frontières AST (moyen)~~ ✅

**Fichier :** `src/core/generator/spec-pipeline.ts` — `chunkContent()`

tree-sitter est déjà une dépendance. Les chunks devraient être délimités par des
frontières réelles (fonction, classe, interface) que tree-sitter peut identifier,
pas par la présence accidentelle d'une ligne vide.

C'est le standard de tous les code RAG modernes (Sourcegraph Cody, Cursor, Aider).

---

## Phase 2 — Intelligence (valeur métier)

### ~~#4 — Pas de liaison bidirectionnelle code ↔ spec (critique pour spec-gen)~~ ✅

Les deux index (fonctions et specs) sont des silos. `mapping.json` lie
requirements → fichiers source, mais cette liaison n'est pas exploitée lors des
recherches en temps réel.

**Objectif :**
- Depuis une spec : trouver les fonctions qui l'implémentent
- Depuis une fonction : trouver les specs qu'elle est censée satisfaire

Sans cela, impossible de détecter le drift de façon sémantique, de naviguer entre
requirements et implémentation, ou d'assister un agent à modifier du code en
respectant les specs.

---

### ~~#5 — Pas de stratégie de retrieval différenciée MCP vs génération (élevé)~~ ✅

Aujourd'hui les outils MCP et le pipeline de génération utilisent le même appel
`VectorIndex.search()` avec les mêmes paramètres.

**Objectif :** Deux stratégies explicites :
- **MCP** : graph traversal (call graph) → semantic search → top-k résultats
- **Génération** : semantic search par domaine → graph expansion → context packing exhaustif

---

## Phase 3 — Optimisations

### ~~#6 — Aucun cache d'embeddings (moyen)~~ ✅

**Fichier :** `src/core/analyzer/vector-index.ts` — `build()`

`VectorIndex.build()` réembedde la totalité des fonctions à chaque exécution.
Le drift detector (`src/core/drift/`) détecte déjà les fichiers modifiés — cette
information n'est pas utilisée pour une mise à jour incrémentale de l'index.

**Objectif :** Cache par hash de contenu, mise à jour incrémentale sur les seuls
fichiers modifiés.

---

### ~~#7 — Retrieval purement dense, pas de retrieval hybride (moyen)~~ ✅

Pour du code, les noms de symboles exacts comptent autant que la sémantique.
Un retrieval hybride dense (embeddings) + sparse (BM25/TF-IDF) surpasse
systématiquement l'un ou l'autre. À traiter après que le graph retrieval et
l'indexation du body sont en place, car ces deux éléments sont des signaux plus
forts que BM25 pour du code.

---

### #8 — Boucle retrieve → generate → retrieve (moyen)

Pattern RAG itératif. Utile pour raffiner une génération ambiguë, mais pas
prioritaire : le problème principal de spec-gen est structurel (comprendre une
architecture), pas conversationnel. À envisager pour les cas où une spec générée
contient des zones d'incertitude élevée.

---

### #9 — Context packing non adaptatif (faible)

Le pipeline charge les 20 fichiers les plus significatifs (`phase2_deep`) par score
statique. Le contexte LLM devrait être rempli dynamiquement avec les chunks
pertinents à la stage en cours.

---

### #10 — Pas de re-ranking après retrieval (faible)

Un cross-encoder re-classerait les candidats selon leur pertinence réelle. Coûteux
et lent — inutile si le graph + embedding retrieval est bien conçu.

---

---

## Phase 4 — Outils MCP manquants ✅

Les 19 outils existants sont bien conçus et bien documentés. `get_subgraph` et
`analyze_impact` ont déjà un fallback sur la recherche sémantique quand il n'y a
pas de match exact — c'est la bonne logique graph-first + semantic fallback.
Il manque cependant cinq outils pour couvrir les cas d'usage courants des agents.

### ~~#11 — Pas de `get_spec(domain)` (élevé)~~ ✅

**Fichiers :** `src/core/services/mcp-handlers/semantic.ts`, `src/cli/commands/mcp.ts`

`search_specs` fait une recherche sémantique et `list_spec_domains` liste les domaines,
mais aucun outil ne permet de lire directement la spec d'un domaine par son nom.
Un agent qui veut consulter la spec `auth` doit formuler une requête approximative
plutôt que d'y accéder directement.

**Objectif :** `get_spec(directory, domain)` — lit et retourne le contenu de
`openspec/specs/{domain}/spec.md` ainsi que le mapping associé.

---

### ~~#12 — Pas de `get_function_body(filePath, functionName)` (élevé)~~ ✅

**Fichiers :** `src/core/services/mcp-handlers/analysis.ts`, `src/cli/commands/mcp.ts`

`search_code` retourne signature + docstring mais pas le corps de la fonction.
Après avoir trouvé une fonction pertinente, l'agent n'a aucun outil pour lire son
implémentation. `get_function_skeleton` existe mais opère sur un fichier entier —
il n'isole pas une fonction précise.

**Objectif :** `get_function_body(directory, filePath, functionName)` — utilise
tree-sitter (déjà disponible) pour extraire le corps exact d'une fonction nommée
dans un fichier. Complète naturellement `search_code`.

---

### ~~#13 — `suggest_insertion_points` n'utilise pas le graphe (élevé)~~ ✅

**Fichier :** `src/core/services/mcp-handlers/semantic.ts` — `handleSuggestInsertionPoints()`

L'outil fait du semantic search puis applique un scoring structurel statique
(fanIn/fanOut/isHub), mais ne traverse pas le call graph pour étendre les candidats
aux voisins directs. Ce serait le premier endroit où implémenter le GraphRAG pour
les agents : semantic search → graph expansion → candidats enrichis.

**Objectif :** Après le top-k sémantique, traverser le call graph (BFS profondeur 1-2)
pour inclure les orchestrateurs directs des fonctions trouvées.

---

### ~~#14 — Pas de requête de dépendances au niveau fichier (moyen)~~ ✅

**Fichiers :** `src/core/services/mcp-handlers/graph.ts`, `src/cli/commands/mcp.ts`

`get_subgraph` opère au niveau fonction. Il n'existe aucun outil pour répondre à
"quels fichiers importent ce module ?" ou "de quoi ce fichier dépend-il ?" —
questions fréquentes lors de la planification d'un refactoring ou d'une nouvelle
fonctionnalité. Le `dependency-graph.json` produit par l'analyse contient déjà
cette information.

**Objectif :** `get_file_dependencies(directory, filePath, direction)` — retourne
les imports entrants et/ou sortants d'un fichier depuis le graphe de dépendances
mis en cache.

---

### ~~#15 — Pas d'accès aux ADRs via MCP (moyen)~~ ✅

**Fichiers :** `src/core/services/mcp-handlers/`, `src/cli/commands/mcp.ts`

`spec-gen generate --adrs` produit des Architecture Decision Records dans
`openspec/decisions/`, mais aucun outil MCP ne permet de les lire ni de les
chercher. Un agent qui veut comprendre pourquoi une décision d'architecture a été
prise n'a pas accès à cette information.

**Objectif :** `get_decisions(directory, query?)` — liste les ADRs disponibles ou
retourne ceux correspondant à une requête textuelle simple (filtrage par titre/statut).

---

---

## Phase 5 — Tests d'intégration sur données réelles (en cours)

Les tests d'intégration existants ont un défaut structurel commun : ils utilisent
des fixtures synthétiques avec des noms de fonctions déjà sémantiquement explicites
(`verifyToken`, `executeQuery`, `hashPassword`). Un modèle d'embedding peut produire
les bons résultats en se basant uniquement sur ces noms, sans jamais lire les
docstrings ni les signatures. C'est précisément pourquoi le bug "docstrings non
indexées dans la recherche sémantique" n'a pas été détecté par les tests existants
et n'a été découvert que par des tests sur du code réel.

**Principe directeur :** les tests d'intégration doivent utiliser du code réel où
les noms de fonctions seuls sont insuffisants pour valider le comportement.

---

### ~~#16 — Tests sémantiques avec noms de fonctions ambigus (critique)~~ ✅

**Fichier :** `src/core/analyzer/vector-index.integration.test.ts`

Les fixtures actuelles ont des noms parlants. Il faut des cas où le nom est opaque
(`process`, `handle`, `run`, `execute`, `compute`) et où seules la docstring ou la
signature permettent de retrouver la fonction via une requête sémantique. Cela
garantit que le texte embarqué (`buildText()`) exploite réellement tous les champs,
et pas uniquement le nom.

**Exemple de cas à couvrir :**
```
function process(input: unknown): Result
// docstring: "Validates an email address format using RFC 5322 rules"
```
→ la requête `"validate email format"` doit retourner cette fonction,
  prouvant que la docstring est bien indexée.

---

### #17 — Pipeline end-to-end sur un vrai dépôt open source (élevé)

Il n'existe aucun test qui exécute la chaîne complète `analyze → embed → search`
sur un vrai codebase. Les bugs de production (champs manquants dans l'index,
troncature silencieuse, mauvais chemin de fichier) n'apparaissent que sur du vrai
code avec toutes ses irrégularités.

**Objectif :** Fixture permanente pointant sur un petit dépôt open source connu
(ex. le propre codebase de spec-gen, ou un projet tiers fixé à un commit précis).
Le test doit au minimum :
- Construire l'index complet (call graph + embeddings)
- Vérifier que des requêtes métier connues retournent les bons fichiers
- Vérifier que les résultats contiennent des docstrings non vides pour les fonctions
  qui en ont

---

### ~~#18 — Tests de régression pour chaque bug trouvé en production (élevé)~~ ✅

Quand un bug est découvert sur du vrai code (comme le bug des docstrings), le
correctif doit s'accompagner d'un test de régression qui aurait échoué avant le
correctif. Actuellement ce processus n'est pas formalisé — les bugs sont corrigés
sans filet.

**Objectif :** Créer un fichier `src/core/analyzer/regression.integration.test.ts`
dédié aux régressions, avec un commentaire par test indiquant le bug original et la
date de découverte.

---

### #19 — Tests MCP de bout en bout sur données réelles (moyen)

Les handlers MCP sont testés unitairement, mais jamais dans la chaîne complète :
client MCP → serveur → handler → call graph réel → réponse. Des bugs d'intégration
(sérialisation JSON, taille de réponse, timeout, cache périmé) ne peuvent apparaître
que dans ce contexte.

**Objectif :** Tests d'intégration qui démarrent le serveur MCP en mode stdio,
appellent les outils sur un vrai projet analysé, et vérifient la cohérence des
réponses (types corrects, pas de champs `undefined`, scores dans les bornes attendues).

---

## Tableau récapitulatif

| # | Lacune | Phase | Impact | Statut |
|---|--------|-------|--------|--------|
| 1 | Vector index non utilisé dans la génération | 1 | **Critique** | ✅ |
| 2 | Corps de fonctions absents de l'index | 1 | **Élevé** | ✅ |
| 3 | Chunking faible (lignes vides vs AST) | 1 | **Moyen** | ✅ |
| 4 | Liaison code↔spec non exploitée | 2 | **Critique pour spec-gen** | ✅ |
| 5 | Pas de stratégie retrieval différenciée MCP/génération | 2 | **Élevé** | ✅ |
| 6 | Pas de cache d'embeddings | 3 | **Moyen** | ✅ |
| 7 | Pas de retrieval hybride (dense+sparse) | 3 | **Moyen** | ✅ |
| 8 | Pas de boucle retrieve-then-generate | 3 | **Moyen** | — |
| 9 | Context packing non adaptatif | 3 | **Faible** | — |
| 10 | Pas de re-ranking | 3 | **Faible** | — |
| 11 | Pas de `get_spec(domain)` | 4 | **Élevé** | ✅ |
| 12 | Pas de `get_function_body` | 4 | **Élevé** | ✅ |
| 13 | `suggest_insertion_points` sans graph expansion | 4 | **Élevé** | ✅ |
| 14 | Pas de requête dépendances fichier | 4 | **Moyen** | ✅ |
| 15 | Pas d'accès aux ADRs via MCP | 4 | **Moyen** | ✅ |
| 16 | Tests sémantiques avec noms ambigus | 5 | **Critique** | ✅ |
| 17 | Pipeline e2e sur vrai dépôt open source | 5 | **Élevé** | — |
| 18 | Tests de régression formalisés | 5 | **Élevé** | ✅ |
| 19 | Tests MCP bout en bout sur données réelles | 5 | **Moyen** | — |
