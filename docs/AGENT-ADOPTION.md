# Agent Adoption — Feuille de route

Diagnostic et propositions pour améliorer l'utilisation effective des outils
openlore par les agents de coding (Claude Code, Cline, Cursor).

Constat : les deux agents observés (Claude Code + Cline) ont accès aux fichiers
et n'utilisent les outils MCP que de façon marginale. Le problème n'est pas
le manque de fonctionnalités — c'est structurel.

---

## Diagnostic

### Les outils sont en mode "pull", la connaissance architecturale fonctionne en "push"

Quand un agent démarre une tâche, il lit automatiquement `CLAUDE.md` / `.clinerules`
sans coût de décision. Pour appeler `analyze_codebase`, il doit :

1. Décider que cet outil est pertinent pour sa tâche
2. Choisir parmi 26 outils lequel invoquer
3. Attendre le résultat
4. Intégrer un JSON volumineux dans son contexte

Ce coût de friction existe même quand l'information aurait aidé. L'agent
l'évite et lit directement les fichiers — ce qu'il sait toujours faire.

### Les outils qui battent la lecture directe sont rares

Un outil gagne sur la lecture de fichiers uniquement s'il fournit une
information que l'agent ne peut pas reconstituer facilement en lisant quelques
fichiers. Avec 26 outils dans la liste, le LLM a du mal à identifier lesquels
sont réellement indispensables.

Outils qui gagnent réellement sur la lecture directe :
- `get_subgraph` / `analyze_impact` — topologie d'appels sur 200+ fichiers en un seul call
- `search_code` — trouver des fonctions par concept quand on ne connaît pas leur nom
- `check_spec_drift` — impossible à répliquer sans git + corrélation avec mapping.json

Outils qui perdent face à la lecture directe :
- `get_function_skeleton` — lire le fichier est plus simple
- `get_function_body` — idem
- `get_signatures` — glob + lecture des headers suffit
- `get_architecture_overview` — lisible depuis package.json + structure de répertoires

---

## Propositions

### ~~#A — Générer un CODEBASE.md lisible par les agents (critique)~~ ✅

**Principe :** transformer la sortie statique de l'analyse en fichier Markdown
que les agents lisent passivement via `CLAUDE.md` ou `.clinerules` — sans
décision, sans friction.

**Contenu de `.openlore/CODEBASE.md` :**

```markdown
# Architecture — [nom du projet]
> Généré par openlore analyze le [date]

## Points d'entrée
- `src/api/server.ts` — `startServer()` — serveur HTTP principal (fanIn: 0, fanOut: 12)
- `src/cli/index.ts` — `run()` — point d'entrée CLI

## Hubs critiques (fonctions les plus appelées)
| Fonction | Fichier | fanIn | fanOut |
|----------|---------|-------|--------|
| `validateDirectory` | mcp-handlers/utils.ts | 18 | 1 |
| `readCachedContext` | mcp-handlers/utils.ts | 12 | 2 |

## Domaines spec disponibles
- `analyzer` — analyse statique, call graph, embeddings
- `auth` — authentification, sessions, JWT
- `api` — endpoints REST, validation, routing

## Fichiers les plus couplés (à éviter de toucher sans test)
- `src/core/generator/spec-pipeline.ts` (couplé à 14 fichiers)
- `src/core/analyzer/artifact-generator.ts` (couplé à 11 fichiers)

## Zones de risque
- Cycles détectés : [liste]
- God functions : [liste]
```

**Ce que les agents font ensuite :**
- Ils ont le contexte architectural sans appel MCP
- Ils savent quels domaines de spec existent → `search_specs` devient une requête ciblée
- Ils connaissent les hubs critiques → ils font attention avant de modifier

**Implémentation :**
- Fichier : `src/core/analyzer/codebase-digest.ts`
- Appelé depuis `src/cli/commands/analyze.ts` après l'analyse complète
- Format Markdown, ~100 lignes max (au-delà c'est du bruit)
- Mis à jour à chaque `openlore analyze`
- Documenté dans le README : "ajouter `.openlore/CODEBASE.md` à votre CLAUDE.md"

---

### ~~#B — Fallback BM25 pour `search_code` sans serveur d'embedding (critique)~~ ✅

**Problème :** `search_code` retourne une erreur si le serveur d'embedding
n'est pas démarré. Un agent qui tente l'outil et échoue apprend à ne plus
l'utiliser. Un outil qui rate silencieusement est pire qu'un outil absent.

**Solution :** quand `VectorIndex.exists()` est vrai mais que le serveur est
injoignable, effectuer une recherche BM25 pure sur les champs `text` stockés
dans LanceDB. Qualité moindre qu'avec les embeddings, mais toujours utile pour
les requêtes exactes (noms de fonctions, termes techniques).

**Interface attendue :**
```json
{
  "query": "rate limiting",
  "mode": "bm25_fallback",
  "note": "Embedding server unavailable — results based on keyword matching only",
  "results": [...]
}
```

**Implémentation :**
- `VectorIndex.search()` — ajouter `mode: 'hybrid' | 'dense' | 'bm25'`
- Si `embedSvc` échoue → retry en mode BM25 seul sur le corpus en mémoire
- Le corpus BM25 est déjà calculé (`_bm25Cache`) — aucune infrastructure supplémentaire
- Fichier : `src/core/analyzer/vector-index.ts` — modifier `search()` pour
  intercepter les erreurs d'embedding et basculer en BM25

---

### ~~#C — Outil `orient` : point d'entrée unique pour les tâches nouvelles (élevé)~~ ✅

**Problème :** avec 26 outils, l'agent doit choisir. Pour une tâche nouvelle
sur un codebase inconnu, aucun outil ne répond clairement à "par où commencer ?".
L'agent lit des fichiers parce que c'est la seule action toujours pertinente.

**Solution :** un outil composite qui prend une description de tâche et retourne
en un seul appel :
- Les 5 fichiers les plus pertinents (recherche sémantique si embedding dispo,
  BM25 sinon)
- Les domaines de spec qui se recoupent
- Le sous-graphe autour des fonctions candidates
- Les points d'insertion suggérés
- Les specs liées

```typescript
// Usage type :
// orient(directory, "add rate limiting to the HTTP API")
// → { relevantFiles, specDomains, callPaths, insertionPoints, linkedSpecs }
```

**Ce que ça change :** le coût de décision passe de "quel outil parmi 26 ?"
à "appeler `orient` en premier, toujours." Les agents comprennent les règles
simples et universelles.

**Implémentation :**
- Nouveau handler : `src/core/services/mcp-handlers/orient.ts`
- Compose : `VectorIndex.search` + `loadMappingIndex` + `readCachedContext`
  + graph traversal (callers depth-1)
- Enregistré dans `mcp.ts` et `chat-tools.ts`
- Description MCP : "START HERE. Call this before any other tool when beginning
  a new task."

---

### ~~#D — Élaguer les outils redondants avec la lecture directe (moyen)~~ ✅

**Principe :** moins d'outils = meilleure sélection par le LLM. Chaque outil
superflu dilue l'attention et augmente le risque de mauvais choix.

**À retirer du registre `chat-tools.ts` (chatbot diagram) :**
- `get_function_skeleton` — `Read` sur le fichier est plus simple et plus complet
- `get_function_body` — idem
- `get_signatures` — idem

Ces outils restent dans `mcp.ts` pour les clients MCP qui n'ont pas accès
aux fichiers (cas edge). Mais ils n'ont pas leur place dans le chatbot qui
opère déjà dans un contexte riche.

**À fusionner :**
- `list_spec_domains` → intégrer dans `search_specs` comme champ `availableDomains`
  quand la query est vide, plutôt qu'un outil séparé

---

### ~~#E — Réécrire les descriptions d'outils comme des conditions de déclenchement (moyen)~~ ✅

**Problème :** les descriptions actuelles décrivent ce que l'outil fait.
Les LLMs sélectionnent les outils sur la base de quand les utiliser.

**Avant :**
```
"Semantic search over indexed functions using a natural language query.
Returns the closest functions by meaning..."
```

**Après :**
```
"USE THIS when you don't know which file or function handles a concept —
e.g. 'where is rate limiting implemented?', 'which function validates tokens?'.
Beats grep when the function name is unknown. Falls back to keyword search
if the embedding server is down."
```

Le pattern : `USE THIS WHEN [condition] — [ce que ça donne que la lecture de
fichiers ne donne pas] — [limitation à connaître]`.

**Fichiers :** `src/cli/commands/mcp.ts` (TOOL_DEFINITIONS) +
`src/core/services/chat-tools.ts` (CHAT_TOOLS)

---

### ~~#F — Documenter le workflow d'adoption dans README et CLAUDE.md (moyen)~~ ✅

Le vrai problème est que les utilisateurs ne savent pas quoi mettre dans leur
`CLAUDE.md` pour que les agents utilisent openlore correctement.

**Ajouter au README une section "Agent setup" :**

```markdown
## Setting up your AI agent

After running `openlore analyze`, add this to your project's `CLAUDE.md`:

\`\`\`markdown
## Codebase analysis (openlore)
Read `.openlore/CODEBASE.md` for architecture context before starting any task.

When you need to:
- Find where a concept is implemented → use `search_code` MCP tool
- Understand call topology → use `get_subgraph` MCP tool
- Find where to add a feature → use `orient` or `suggest_insertion_points`
- Check if code matches spec → use `check_spec_drift`
\`\`\`
```

Le `CODEBASE.md` (#A) donne le contexte passif. Le `CLAUDE.md` indique quand
switcher vers les outils actifs. Les deux ensemble créent le workflow complet.

---

## Tableau récapitulatif

| # | Proposition | Impact | Effort | Statut |
|---|-------------|--------|--------|--------|
| A | Générer CODEBASE.md (push architectural context) | **Critique** | Moyen | ✅ |
| B | BM25 fallback sans serveur d'embedding | **Critique** | Faible | ✅ |
| C | Outil `orient` composite | **Élevé** | Élevé | ✅ |
| D | Élaguer les outils redondants | **Moyen** | Faible | ✅ |
| E | Réécrire descriptions comme triggers | **Moyen** | Faible | ✅ |
| F | Documentation workflow agent setup | **Moyen** | Faible | ✅ |
