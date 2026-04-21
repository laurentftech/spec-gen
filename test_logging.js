#!/usr/bin/env node

/**
 * Simple test script to verify logging in validateDirectory function
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { validateDirectory } from './src/core/services/mcp-handlers/utils.js';
import { configureLogger } from './src/utils/logger.js';

// Configure logger for verbose output
configureLogger({ verbose: true, quiet: false, noColor: false });

const __dirname = dirname(fileURLToPath(import.meta.url));

async function testLogging() {
  console.log('\n=== Testing validateDirectory logging ===\n');

  // Test 1: Valid directory
  console.log('Test 1: Valid directory');
  try {
    const result = await validateDirectory(__dirname);
    console.log(`✓ Success: ${result}\n`);
  } catch (error) {
    console.log(`✗ Error: ${error.message}\n`);
  }

  // Test 2: Invalid input (null)
  console.log('Test 2: Invalid input (null)');
  try {
    await validateDirectory(null);
    console.log('✗ Should have thrown an error\n');
  } catch (error) {
    console.log(`✓ Expected error: ${error.message}\n`);
  }

  // Test 3: Invalid input (empty string)
  console.log('Test 3: Invalid input (empty string)');
  try {
    await validateDirectory('');
    console.log('✗ Should have thrown an error\n');
  } catch (error) {
    console.log(`✓ Expected error: ${error.message}\n`);
  }

  // Test 4: Non-existent directory
  console.log('Test 4: Non-existent directory');
  try {
    await validateDirectory('/path/that/does/not/exist');
    console.log('✗ Should have thrown an error\n');
  } catch (error) {
    console.log(`✓ Expected error: ${error.message}\n`);
  }

  // Test 5: File path instead of directory
  console.log('Test 5: File path instead of directory');
  try {
    await validateDirectory(resolve(__dirname, 'package.json'));
    console.log('✗ Should have thrown an error\n');
  } catch (error) {
    console.log(`✓ Expected error: ${error.message}\n`);
  }

  console.log('=== All tests completed ===\n');
}

testLogging().catch(console.error);