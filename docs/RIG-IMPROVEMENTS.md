# Améliorations RIG — Feuille de route

Analyse des lacunes de spec-gen pour en faire un RIG (Retrieval-Indexed Generation)
pleinement efficace. Classées par ordre de priorité décroissant.

---

## Lacune #1 — Le vector index n'est PAS utilisé pendant la génération (critique)

**Fichier :** `src/core/generator/spec-pipeline.ts`

`getSchemaFiles()`, `getServiceFiles()`, `getApiFiles()` sélectionnent les fichiers
par **heuristique de nom** (`name.includes('model')`, `name.includes('service')`…).
Le vector index est construit en option (`--embed`) mais n'est jamais interrogé
pendant les stages de génération.

**Objectif :** Pour chaque domaine/entité en cours de génération, interroger le vector
index pour retrouver les chunks de code les plus sémantiquement pertinents, plutôt
que de se fier aux conventions de nommage.

---

## Lacune #2 — Pas de boucle retrieve → generate → retrieve (élevé)

Le pipeline s'exécute en séquence linéaire sans jamais re-questionner l'index.
Un RIG efficace devrait :
1. Générer un premier draft
2. Identifier ce qui est ambigu ou manquant
3. Faire une nouvelle requête vectorielle ciblée
4. Raffiner la génération

---

## Lacune #3 — Les corps de fonctions sont absents de l'index (élevé)

**Fichier :** `src/core/analyzer/vector-index.ts` — `buildText()`

Le texte embarqué = `[language] path qualifiedName + signature + docstring`.
Le **corps de la fonction** n'est pas indexé. Pour inférer le comportement métier
(ce que le code *fait*, pas juste ce qu'il s'appelle), l'implémentation est essentielle.

---

## Lacune #4 — Retrieval purement dense, pas de retrieval hybride (moyen)

Uniquement de la similarité cosinus sur embeddings denses. Pour du code :
- Les noms de symboles exacts (BM25 / TF-IDF) comptent autant que la sémantique
- Un retrieval hybride dense + sparse surpasse systématiquement l'un ou l'autre seul

---

## Lacune #5 — Aucun cache d'embeddings (moyen)

**Fichier :** `src/core/analyzer/vector-index.ts` — `build()`

`VectorIndex.build()` réembedde la totalité des fonctions à chaque exécution.
Le drift detector (`src/core/drift/`) détecte déjà les fichiers modifiés — cette
information n'est pas utilisée pour une mise à jour incrémentale de l'index.

**Objectif :** Cache par hash de contenu par fichier, mise à jour incrémentale.

---

## Lacune #6 — Chunking sémantiquement faible (moyen)

**Fichier :** `src/core/generator/spec-pipeline.ts` — `chunkContent()`

La segmentation se fait sur les lignes vides. tree-sitter est déjà une dépendance —
les chunks devraient être délimités par des frontières réelles (fonctions, classes)
que tree-sitter peut identifier.

---

## Lacune #7 — Pas de liaison bidirectionnelle code ↔ spec (moyen)

Les deux index (fonctions et specs) sont des silos. `mapping.json` lie
requirements → fichiers source, mais cette liaison n'est pas exploitée lors des
recherches en temps réel.

**Objectif :**
- Depuis une spec : trouver les fonctions qui l'implémentent
- Depuis une fonction : trouver les specs qu'elle est censée satisfaire

---

## Lacune #8 — Pas de re-ranking après retrieval (faible)

**Fichier :** `src/core/services/mcp-handlers/semantic.ts`

Le score composite (distance sémantique + bonus structurel hub/entry-point) est
fixe et heuristique. Un cross-encoder re-classerait les candidats selon leur
pertinence réelle à la question posée.

---

## Lacune #9 — Context packing non adaptatif (faible)

Le pipeline charge les 20 fichiers les plus significatifs (`phase2_deep`) par score
statique. Le contexte LLM devrait être rempli dynamiquement avec les chunks
pertinents à la stage en cours, pas un ensemble fixe déterminé à l'avance.

---

## Tableau récapitulatif

| # | Lacune | Impact |
|---|--------|--------|
| 1 | Vector index non utilisé dans la génération | **Critique** |
| 2 | Pas de boucle retrieve-then-generate | **Élevé** |
| 3 | Corps de fonctions absents de l'index | **Élevé** |
| 4 | Pas de retrieval hybride (dense+sparse) | **Moyen** |
| 5 | Pas de cache d'embeddings | **Moyen** |
| 6 | Chunking faible (lignes vides vs tree-sitter) | **Moyen** |
| 7 | Liaison code↔spec non exploitée | **Moyen** |
| 8 | Pas de re-ranking | **Faible** |
| 9 | Context packing non optimisé | **Faible** |
