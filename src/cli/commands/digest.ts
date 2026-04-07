/**
 * spec-gen digest command
 *
 * Generates a plain-English summary of all OpenSpec specs for human review.
 * Source spec files are never modified.
 */

import { Command } from 'commander';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../../utils/logger.js';
import { parseList } from '../../utils/command-helpers.js';
import { generateDigest, renderDigestMarkdown } from '../../core/digest/digest-generator.js';

export const digestCommand = new Command('digest')
  .description('Generate a plain-English digest of your specs for human review')
  .option(
    '--domains <list>',
    'Only include specific domains (comma-separated)',
    parseList
  )
  .option(
    '--output <path>',
    'Write digest to a file instead of printing to stdout'
  )
  .option(
    '--save',
    'Write digest to openspec/digest.md',
    false
  )
  .addHelpText(
    'after',
    `
Examples:
  $ spec-gen digest                        Print digest to stdout
  $ spec-gen digest --save                 Write to openspec/digest.md
  $ spec-gen digest --output review.md     Write to a custom path
  $ spec-gen digest --domains auth,payment Only show selected domains
`
  )
  .action(async function (options: {
    domains?: string[];
    output?: string;
    save?: boolean;
  }) {
    const rootPath = process.cwd();

    try {
      const result = await generateDigest({
        rootPath,
        domains: options.domains,
      });

      if (result.domains.length === 0) {
        logger.error('No spec files found. Run "spec-gen generate" first.');
        process.exitCode = 1;
        return;
      }

      const markdown = renderDigestMarkdown(result);

      // Determine output target
      const outputPath = options.output
        ? options.output
        : options.save
          ? join(rootPath, 'openspec', 'digest.md')
          : null;

      if (outputPath) {
        await writeFile(outputPath, markdown, 'utf-8');
        logger.success(`Digest written to ${outputPath}`);
        logger.info('Domains', result.domains.length);
        logger.info('Requirements', result.totalRequirements);
        logger.info('Scenarios', result.totalScenarios);
      } else {
        // Print to stdout
        console.log(markdown);
      }
    } catch (error) {
      logger.error((error as Error).message);
      process.exitCode = 1;
    }
  });
