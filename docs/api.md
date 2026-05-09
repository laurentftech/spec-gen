## Programmatic API

spec-gen exposes a typed Node.js API for integration into other tools (like [OpenSpec CLI](https://github.com/Fission-AI/OpenSpec)). Every CLI command has a corresponding API function that returns structured results instead of printing to the console.

```bash
npm install spec-gen-cli
```

```typescript
import { specGenAnalyze, specGenDrift, specGenRun } from 'spec-gen';

// Run the full pipeline
const result = await specGenRun({
  rootPath: '/path/to/project',
  adr: true,
  onProgress: (event) => console.log(`[${event.phase}] ${event.step}`),
});
console.log(`Generated ${result.generation.report.filesWritten.length} specs`);

// Check for drift
const drift = await specGenDrift({
  rootPath: '/path/to/project',
  failOn: 'warning',
});
if (drift.hasDrift) {
  console.warn(`${drift.summary.total} drift issues found`);
}

// Static analysis only (no API key needed)
const analysis = await specGenAnalyze({
  rootPath: '/path/to/project',
  maxFiles: 1000,
});
console.log(`Analyzed ${analysis.repoMap.summary.analyzedFiles} files`);
```

### API Functions

| Function | Description | API Key |
|----------|-------------|---------|
| `specGenInit(options?)` | Initialize config and openspec directory | No |
| `specGenAnalyze(options?)` | Run static analysis | No |
| `specGenGenerate(options?)` | Generate specs from analysis | Yes |
| `specGenVerify(options?)` | Verify spec accuracy | Yes |
| `specGenDrift(options?)` | Detect spec-to-code drift | No* |
| `specGenRun(options?)` | Full pipeline: init + analyze + generate | Yes |
| `specGenAudit(options?)` | Parity audit: uncovered functions, hub gaps, orphan requirements, stale domains | No |
| `specGenGetSpecRequirements(options?)` | Read requirement blocks from generated specs | No |

\* `specGenDrift` requires an API key only when `llmEnhanced: true`.

All functions accept an optional `onProgress` callback for status updates and throw errors instead of calling `process.exit`. See [src/api/types.ts](src/api/types.ts) for full option and result type definitions.

### Error handling

All API functions throw `Error` on failure. Wrap calls in try-catch for production use:

```typescript
import { specGenRun } from 'spec-gen-cli';

try {
  const result = await specGenRun({ rootPath: '/path/to/project' });
  console.log(`Done — ${result.generation.report.filesWritten.length} specs written`);
} catch (err) {
  if ((err as Error).message.includes('API key')) {
    console.error('Set ANTHROPIC_API_KEY or OPENAI_API_KEY');
  } else {
    console.error('spec-gen failed:', (err as Error).message);
  }
}
```

### Reading generated spec requirements

After running `specGenGenerate`, you can programmatically query the requirement-to-function mapping:

```typescript
import { specGenGetSpecRequirements } from 'spec-gen-cli';

const { requirements } = await specGenGetSpecRequirements({ rootPath: '/path/to/project' });
for (const [key, req] of Object.entries(requirements)) {
  console.log(`${key}: ${req.title} (${req.specFile})`);
}
```

