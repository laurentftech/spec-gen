# Plan — spec-gen RAG improvements (Pistes 2, 3, 4 + orient)

## Problème concret

Un agent coding reçoit une tâche sur spec-gen. Il appelle `orient`. `orient` retourne des fonctions et des fichiers — mais pas le contenu des specs. L'agent doit appeler `get_spec` séparément, s'il pense à le faire. Dans la pratique : il lit du code brut, infère les contrats de données lui-même, et manque les dépendances cross-domaines.

Résultat : lectures exploratoires inutiles, hallucinations sur les contrats de données, impacts cross-domaines ratés.

**Le but de ce plan :** mettre les specs dans la boucle systématique de l'agent, et enrichir leur contenu pour qu'elles répondent aux questions que l'agent se pose vraiment.

---

## Chaîne de valeur

```
Piste 3 — rag-manifest.json
  (mappe fichiers modifiés → domaines → spec paths)
       ↓ prérequis pour
orient enrichi — inline le contenu des specs détectées
  (l'agent a le contexte domaine sans appel supplémentaire)
       ↓ ce contenu est enrichi par
Piste 4 — ## Dependencies dans chaque spec
  (l'agent voit les domaines impactés, pas besoin d'analyze_impact)
       ↓ combiné avec
Piste 2 — file:line par exigence
  (l'agent navigue directement au code, pas de lecture exploratoire)
```

Sans Piste 3 + orient, les Pistes 2 et 4 améliorent des documents que l'agent ne lit pas systématiquement.

---

## Fichiers critiques

| Fichier | Rôle |
|---------|------|
| `src/core/services/mcp-handlers/orient.ts` | Enrichir la réponse orient avec contenu spec inline |
| `src/core/generator/rag-manifest-generator.ts` | **Nouveau** — génère `openspec/rag-manifest.json` |
| `src/core/generator/openspec-format-generator.ts` | Sections Dependencies + annotations file:line |
| `src/api/generate.ts` | Appel manifest generator + réordonnancement mapping |
| `src/core/generator/mapping-generator.ts` | Retourner MappingArtifact en plus d'écrire |
| `src/constants.ts` | `ARTIFACT_RAG_MANIFEST` |

---

## Étape 1 — Piste 3 : `rag-manifest.json`

Prérequis de tout le reste. Généré après `writer.writeSpecs()` dans `generate.ts`.

### Nouveau fichier : `src/core/generator/rag-manifest-generator.ts`

```typescript
export interface RagManifest {
  generatedAt: string;
  specVersion: string;
  domains: RagDomainEntry[];
}

export interface RagDomainEntry {
  domain: string;
  specPath: string;        // "openspec/specs/analyzer/spec.md"
  sourceFiles: string[];   // chemins relatifs du cluster depGraph
  requirementCount: number;
  dependsOn: string[];     // domaines appelés
  calledBy: string[];      // domaines appelants
}

export class RagManifestGenerator {
  generate(specs: GeneratedSpec[], depGraph?: DependencyGraphResult): RagManifest
}
```

`sourceFiles` vient des `cluster.files` correspondant à `cluster.suggestedDomain === domain`.
`dependsOn` / `calledBy` viennent des edges cross-cluster du depGraph.

### Intégration `generate.ts`

Après `writer.writeSpecs()` :
```typescript
const manifestGen = new RagManifestGenerator();
const manifest = manifestGen.generate(generatedSpecs, depGraph);
await writeJson(join(openspecPath, 'rag-manifest.json'), manifest);
```

### Constante `src/constants.ts`

```typescript
export const ARTIFACT_RAG_MANIFEST = 'rag-manifest.json';
```

---

## Étape 2 — orient enrichi : inline spec context

C'est le **chainon manquant** : la spec doit être dans la réponse `orient`, pas dans un appel `get_spec` ultérieur que l'agent oublie de faire.

### Changements dans `orient.ts`

Après la construction de `specDomains` (actuellement top-5 domaines détectés), charger le contenu condensé des specs correspondantes depuis `rag-manifest.json` :

```typescript
// Charger le manifeste (non-fatal si absent)
const manifest = await loadRagManifest(absDir);

// Pour chaque domaine détecté (top 3 max pour garder la réponse concise)
const inlineSpecs = manifest
  ? await Promise.all(
      specDomains.slice(0, 3).map(async sd => {
        const entry = manifest.domains.find(d => d.domain === sd.domain);
        if (!entry) return null;
        const content = await readSpecFile(join(absDir, entry.specPath));
        return {
          domain: sd.domain,
          specPath: entry.specPath,
          sourceFiles: entry.sourceFiles,
          dependsOn: entry.dependsOn,
          calledBy: entry.calledBy,
          content: condenseSpec(content),  // extrait Purpose + Dependencies + Requirement names
        };
      })
    ).then(r => r.filter(Boolean))
  : undefined;
```

**`condenseSpec(content)`** : extrait du markdown :
- La section `## Purpose` (1er paragraphe seulement)
- La section `## Dependencies` complète (si présente — Piste 4)
- Les en-têtes `### Requirement: {name}` avec leur ligne `> Implementation:` (si présente — Piste 2), sans le corps

Résultat : ~200-400 tokens par spec, pas 2000.

### Nouveau champ dans la réponse `orient`

```typescript
return {
  // ... champs existants inchangés ...
  specDomains,          // existant
  inlineSpecs?,         // NOUVEAU : contenu condensé des specs détectées
  matchingSpecs?,       // existant
  nextSteps,
};
```

`nextSteps` reste avec `get_spec(domain)` pour l'accès au contenu complet.

---

## Étape 3 — Piste 4 : section `## Dependencies` dans les specs de domaine

Enrichit le contenu qu'`orient` va inliner.

### Changements dans `openspec-format-generator.ts`

1. Ajouter `depGraph?: DependencyGraphResult` au constructeur (champ privé).
2. Méthode privée `buildDependencySection(domainName: string): string[]` :
   - Trouver le cluster `suggestedDomain === domainName`
   - Set des fichiers du cluster
   - Scanner `depGraph.edges` :
     - `source ∈ clusterFiles` AND `target ∉ clusterFiles` → "Calls into" (résoudre le cluster cible)
     - `target ∈ clusterFiles` AND `source ∉ clusterFiles` → "Called by" (résoudre le cluster source)
   - Grouper par domaine cible/source, prendre les `importedNames` les plus fréquents (max 3)
3. Injecter après Technical Notes :

```markdown
## Dependencies

### Called by this domain
- `api` → via `specGenGenerate()` · `generate.ts:220`

### Calls into
- `analyzer` → `DependencyGraphResult`, `RepositoryMapper`
- `types` → `PipelineResult`, `ExtractedService`
```

### Passage de `depGraph` au formatter dans `generate.ts`

```typescript
const formatGenerator = new OpenSpecFormatGenerator({
  version: specGenConfig.version,
  includeConfidence: true,
  includeTechnicalNotes: true,
  depGraph,   // NOUVEAU
});
```

---

## Étape 4 — Piste 2 : annotations `file:line` par exigence

Enrichit les specs pour que l'agent navigue directement au code.

### Changements dans `mapping-generator.ts`

`generate()` : `Promise<void>` → `Promise<MappingArtifact>`. Retourne le résultat calculé (en plus de l'écrire).

### Réordonnancement dans `generate.ts`

```typescript
// AVANT
let generatedSpecs = formatGenerator.generateSpecs(pipelineResult);
await mapper.generate(pipelineResult, depGraph);

// APRÈS
const mappingArtifact = depGraph
  ? await mapper.generate(pipelineResult, depGraph)
  : undefined;
let generatedSpecs = formatGenerator.generateSpecs(pipelineResult, mappingArtifact);
```

### Changements dans `openspec-format-generator.ts`

`generateSpecs(result, mappingArtifact?)` — paramètre optionnel passé à `generateDomainSpec`.

Dans `generateDomainSpec()`, après chaque `### Requirement: {opName}` :

```typescript
const match = mappingArtifact?.mappings.find(
  m => m.requirement === opName && m.domain.toLowerCase() === domain.name.toLowerCase()
);
const bestFn = match?.functions.sort(byConfidence)[0];
if (bestFn) {
  lines.push(`> Implementation: \`${bestFn.file}:${bestFn.line}\` · confidence: ${bestFn.confidence}`);
  lines.push('');
}
```

Résultat :

```markdown
### Requirement: TokenManagement
> Implementation: `src/services/token-tracker.ts:42` · confidence: llm

The system SHALL track token usage per LLM call...
```

Enrichir aussi `DomainGroup.files` depuis le cluster depGraph (dans `groupByDomain()`) pour que `> Source files:` dans le header soit complet.

---

## Ordre d'implémentation

| Étape | Ce qu'elle débloque |
|-------|---------------------|
| 1. Piste 3 — manifest | Prérequis pour orient + rag-manifest disponible |
| 2. orient inline | Specs dans la boucle agent à chaque `orient` |
| 3. Piste 4 — Dependencies | `orient` retourne les liens cross-domaines |
| 4. Piste 2 — file:line | `orient` retourne les points d'entrée directs |

---

## Vérification

1. `npm run build` — zéro erreur TypeScript
2. `npm test` — tous les tests existants passent
3. `spec-gen generate` sur le repo spec-gen :
   - `openspec/rag-manifest.json` créé avec 10+ domaines, `sourceFiles` et `dependsOn` remplis
   - `openspec/specs/generator/spec.md` contient `## Dependencies` avec `api` dans "Called by"
   - `openspec/specs/generator/spec.md` contient `> Implementation:` sur au moins un `### Requirement:`
4. Appel MCP `orient("add dependency links to domain specs")` :
   - Réponse contient `inlineSpecs` avec le domaine `generator`
   - `inlineSpecs[0].dependsOn` liste `analyzer` et `types`
   - `inlineSpecs[0].content` contient les noms des requirements avec leurs `file:line`
