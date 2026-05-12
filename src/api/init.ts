/**
 * openlore init — programmatic API
 *
 * Detects project type and creates openlore configuration.
 * No side effects (no process.exit, no console.log).
 */

import { resolve, relative } from 'node:path';
import { OPENLORE_DIR, OPENLORE_CONFIG_REL_PATH, DEFAULT_OPENSPEC_PATH } from '../constants.js';
import {
  detectProjectType,
  getProjectTypeName,
} from '../core/services/project-detector.js';
import {
  getDefaultConfig,
  writeOpenLoreConfig,
  openloreConfigExists,
  openspecDirExists,
  createOpenSpecStructure,
} from '../core/services/config-manager.js';
import {
  gitignoreExists,
  isInGitignore,
  addToGitignore,
} from '../core/services/gitignore-manager.js';
import type { InitApiOptions, InitResult, ProgressCallback } from './types.js';

function progress(onProgress: ProgressCallback | undefined, step: string, status: 'start' | 'progress' | 'complete' | 'skip', detail?: string): void {
  onProgress?.({ phase: 'init', step, status, detail });
}

/**
 * Initialize openlore in a project directory.
 *
 * Creates `.openlore/config.json`, the `openspec/` directory structure,
 * and updates `.gitignore`.
 *
 * @throws Error if openspec path is outside project root
 * @throws Error if config exists and force is false
 */
export async function openloreInit(options: InitApiOptions = {}): Promise<InitResult> {
  const rootPath = options.rootPath ?? process.cwd();
  const openspecRelPath = options.openspecPath ?? DEFAULT_OPENSPEC_PATH;
  const openspecFullPath = resolve(rootPath, openspecRelPath);
  const force = options.force ?? false;
  const { onProgress } = options;

  // Validate path traversal
  const relPath = relative(rootPath, openspecFullPath);
  if (relPath.startsWith('..')) {
    throw new Error('OpenSpec path must be within the project directory.');
  }

  // Detect project type
  progress(onProgress, 'Detecting project type', 'start');
  const detection = await detectProjectType(rootPath);
  const projectType = getProjectTypeName(detection.projectType);
  progress(onProgress, 'Detecting project type', 'complete', projectType);

  // Check existing config
  const configExists = await openloreConfigExists(rootPath);
  if (configExists && !force) {
    progress(onProgress, 'Configuration exists', 'skip');
    return {
      configPath: OPENLORE_CONFIG_REL_PATH,
      openspecPath: openspecRelPath,
      projectType,
      created: false,
    };
  }

  // Create config
  progress(onProgress, 'Creating configuration', 'start');
  const config = getDefaultConfig(detection.projectType, openspecRelPath);
  await writeOpenLoreConfig(rootPath, config);
  progress(onProgress, 'Creating configuration', 'complete');

  // Create openspec directory
  const hasOpenspec = await openspecDirExists(openspecFullPath);
  if (!hasOpenspec) {
    progress(onProgress, 'Creating openspec directory', 'start');
    await createOpenSpecStructure(openspecFullPath);
    progress(onProgress, 'Creating openspec directory', 'complete');
  } else {
    progress(onProgress, 'OpenSpec directory exists', 'skip');
  }

  // Update .gitignore
  const hasGitignore = await gitignoreExists(rootPath);
  if (hasGitignore) {
    const alreadyIgnored = await isInGitignore(rootPath, `${OPENLORE_DIR}/`);
    if (!alreadyIgnored) {
      progress(onProgress, 'Updating .gitignore', 'start');
      await addToGitignore(rootPath, `${OPENLORE_DIR}/`, 'openlore analysis artifacts');
      progress(onProgress, 'Updating .gitignore', 'complete');
    }
  }

  return {
    configPath: OPENLORE_CONFIG_REL_PATH,
    openspecPath: openspecRelPath,
    projectType,
    created: true,
  };
}
