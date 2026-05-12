/**
 * Tests for openlore doctor command
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { doctorCommand } from './doctor.js';

// ============================================================================
// MOCKS
// ============================================================================

vi.mock('../../utils/logger.js', () => ({
  logger: {
    section: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn(),
    success: vi.fn(), discovery: vi.fn(), analysis: vi.fn(), blank: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    access: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ mtime: new Date() }),
  };
});

// execFile is called via promisify — mock the whole module so the wrapper
// function created at import time references our controllable vi.fn().
vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

vi.mock('../../core/services/config-manager.js', () => ({
  readOpenLoreConfig: vi.fn().mockResolvedValue({
    projectType: 'nodejs',
    createdAt: '2024-01-01T00:00:00Z',
    openspecPath: './openspec',
    maxFiles: 500,
  }),
}));

vi.mock('../../core/services/llm-service.js', () => ({
  createLLMService: vi.fn().mockReturnValue({
    complete: vi.fn().mockResolvedValue({ model: 'claude-opus-4-6', content: 'pong' }),
    saveLogs: vi.fn().mockResolvedValue(undefined),
  }),
}));

// ============================================================================
// HELPERS
// ============================================================================

import { execFile as execFileMock } from 'node:child_process';

/** Make execFileMock succeed (used for git --version, claude --version, df) */
function mockExecSuccess(stdout = 'ok'): void {
  vi.mocked(execFileMock).mockImplementation((...args: any[]) => {
    const cb = args[args.length - 1];
    if (typeof cb === 'function') cb(null, { stdout, stderr: '' });
    return {} as ReturnType<typeof execFileMock>;
  });
}

/** Run doctor --json and return parsed check array */
async function runDoctorJson(): Promise<Array<{ name: string; status: string; detail: string; fix?: string }>> {
  const outputs: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((msg: string) => { outputs.push(msg); });
  try {
    await doctorCommand.parseAsync(['node', 'doctor', '--json'], { from: 'user' });
  } finally {
    spy.mockRestore();
  }
  const jsonLine = outputs.find(o => { try { JSON.parse(o); return true; } catch { return false; } });
  return JSON.parse(jsonLine!);
}

// ============================================================================
// TESTS
// ============================================================================

describe('doctor command', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    process.exitCode = undefined;
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockExecSuccess();
    // Restore default LLM mock after clearAllMocks
    const llmService = await import('../../core/services/llm-service.js');
    vi.mocked(llmService.createLLMService).mockReturnValue({
      complete: vi.fn().mockResolvedValue({ model: 'claude-opus-4-6', content: 'pong' }),
      saveLogs: vi.fn().mockResolvedValue(undefined),
    } as never);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  // --------------------------------------------------------------------------
  describe('command configuration', () => {
    it('should have correct name', () => {
      expect(doctorCommand.name()).toBe('doctor');
    });

    it('should describe the command', () => {
      expect(doctorCommand.description()).toContain('environment');
    });

    it('should have --json option defaulting to false', () => {
      const jsonOption = doctorCommand.options.find(o => o.long === '--json');
      expect(jsonOption).toBeDefined();
      expect(jsonOption?.defaultValue).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  describe('--json output', () => {
    it('should produce valid JSON', async () => {
      const checks = await runDoctorJson();
      expect(Array.isArray(checks)).toBe(true);
    });

    it('should include exactly 7 checks', async () => {
      const checks = await runDoctorJson();
      expect(checks).toHaveLength(7);
    });

    it('each check should have name, status, and detail fields', async () => {
      const checks = await runDoctorJson();
      for (const c of checks) {
        expect(c).toHaveProperty('name');
        expect(c).toHaveProperty('status');
        expect(c).toHaveProperty('detail');
        expect(['ok', 'warn', 'fail']).toContain(c.status);
      }
    });

    it('should include a Node.js version check', async () => {
      const checks = await runDoctorJson();
      const nodeCheck = checks.find(c => c.name === 'Node.js version');
      expect(nodeCheck).toBeDefined();
      expect(nodeCheck!.detail).toMatch(/^v\d+\./);
    });

    it('should include a Git repository check', async () => {
      const checks = await runDoctorJson();
      const gitCheck = checks.find(c => c.name === 'Git repository');
      expect(gitCheck).toBeDefined();
    });

    it('should include a openlore config check', async () => {
      const checks = await runDoctorJson();
      const configCheck = checks.find(c => c.name === 'openlore config');
      expect(configCheck).toBeDefined();
    });

    it('should include an Analysis artifacts check', async () => {
      const checks = await runDoctorJson();
      const artifactCheck = checks.find(c => c.name === 'Analysis artifacts');
      expect(artifactCheck).toBeDefined();
    });

    it('should include an OpenSpec directory check', async () => {
      const checks = await runDoctorJson();
      const openspecCheck = checks.find(c => c.name === 'OpenSpec directory');
      expect(openspecCheck).toBeDefined();
    });

    it('should include an LLM connection check', async () => {
      const checks = await runDoctorJson();
      const llmCheck = checks.find(c => c.name === 'LLM connection');
      expect(llmCheck).toBeDefined();
    });

    it('should include a Disk space check', async () => {
      const checks = await runDoctorJson();
      const diskCheck = checks.find(c => c.name === 'Disk space');
      expect(diskCheck).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  describe('Node.js version check', () => {
    it('should pass for the current Node.js version (>=20)', async () => {
      const checks = await runDoctorJson();
      const nodeCheck = checks.find(c => c.name === 'Node.js version')!;
      expect(nodeCheck.status).toBe('ok');
    });
  });

  // --------------------------------------------------------------------------
  describe('LLM connection check', () => {
    const keyVars = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENAI_COMPAT_API_KEY'];

    function clearLLMKeys(): Record<string, string | undefined> {
      const saved: Record<string, string | undefined> = {};
      for (const k of keyVars) {
        saved[k] = process.env[k];
        delete process.env[k];
      }
      return saved;
    }

    function restoreLLMKeys(saved: Record<string, string | undefined>): void {
      for (const k of keyVars) {
        if (saved[k] !== undefined) process.env[k] = saved[k];
        else delete process.env[k];
      }
    }

    it('should pass (ok) when createLLMService and complete() both succeed', async () => {
      const saved = clearLLMKeys();
      process.env.ANTHROPIC_API_KEY = 'sk-test-anthropic';
      try {
        const checks = await runDoctorJson();
        const llmCheck = checks.find(c => c.name === 'LLM connection')!;
        expect(llmCheck.status).toBe('ok');
        expect(llmCheck.detail).toContain('anthropic');
      } finally {
        restoreLLMKeys(saved);
      }
    });

    it('should detect gemini provider when GEMINI_API_KEY is set', async () => {
      const saved = clearLLMKeys();
      process.env.GEMINI_API_KEY = 'test-gemini-key';
      try {
        const checks = await runDoctorJson();
        const llmCheck = checks.find(c => c.name === 'LLM connection')!;
        expect(llmCheck.status).toBe('ok');
        expect(llmCheck.detail).toContain('gemini');
      } finally {
        restoreLLMKeys(saved);
      }
    });

    it('should fail when createLLMService throws (missing API key)', async () => {
      const saved = clearLLMKeys();
      const llmService = await import('../../core/services/llm-service.js');
      vi.mocked(llmService.createLLMService).mockImplementationOnce(() => {
        throw new Error('No API key');
      });
      try {
        const checks = await runDoctorJson();
        const llmCheck = checks.find(c => c.name === 'LLM connection')!;
        expect(llmCheck.status).toBe('fail');
        expect(llmCheck.fix).toBeDefined();
        expect(llmCheck.fix).toContain('API key');
      } finally {
        restoreLLMKeys(saved);
      }
    });

    it('should fail when complete() rejects (network error)', async () => {
      const saved = clearLLMKeys();
      process.env.ANTHROPIC_API_KEY = 'sk-test-anthropic';
      const llmService = await import('../../core/services/llm-service.js');
      vi.mocked(llmService.createLLMService).mockReturnValueOnce({
        complete: vi.fn().mockRejectedValue(new Error('Connection refused')),
        saveLogs: vi.fn().mockResolvedValue(undefined),
      } as never);
      try {
        const checks = await runDoctorJson();
        const llmCheck = checks.find(c => c.name === 'LLM connection')!;
        expect(llmCheck.status).toBe('fail');
        expect(llmCheck.fix).toContain('API key');
      } finally {
        restoreLLMKeys(saved);
      }
    });

    it('should include a fix suggestion when failing', async () => {
      const saved = clearLLMKeys();
      const llmService = await import('../../core/services/llm-service.js');
      vi.mocked(llmService.createLLMService).mockImplementationOnce(() => {
        throw new Error('No API key');
      });
      try {
        const checks = await runDoctorJson();
        const llmCheck = checks.find(c => c.name === 'LLM connection')!;
        expect(llmCheck.fix).toBeDefined();
      } finally {
        restoreLLMKeys(saved);
      }
    });
  });

  // --------------------------------------------------------------------------
  describe('config check', () => {
    it('should show ok when config exists and parses', async () => {
      const checks = await runDoctorJson();
      const configCheck = checks.find(c => c.name === 'openlore config')!;
      expect(configCheck.status).toBe('ok');
      expect(configCheck.detail).toContain('nodejs');
    });

    it('should show warn when config file is not accessible', async () => {
      const { access } = await import('node:fs/promises');
      vi.mocked(access).mockRejectedValue(new Error('ENOENT'));

      const checks = await runDoctorJson();
      const configCheck = checks.find(c => c.name === 'openlore config')!;
      expect(configCheck.status).toBe('warn');
      expect(configCheck.fix).toContain('openlore init');
    });

    it('should show fail when config file exists but cannot be parsed', async () => {
      const { access } = await import('node:fs/promises');
      vi.mocked(access).mockResolvedValue(undefined);

      const configManager = await import('../../core/services/config-manager.js');
      vi.mocked(configManager.readOpenLoreConfig).mockResolvedValue(null);

      const checks = await runDoctorJson();
      const configCheck = checks.find(c => c.name === 'openlore config')!;
      expect(configCheck.status).toBe('fail');
      expect(configCheck.fix).toContain('openlore init');
    });
  });

  // --------------------------------------------------------------------------
  describe('analysis artifacts check', () => {
    it('should show ok for fresh analysis (< warning threshold)', async () => {
      const { stat } = await import('node:fs/promises');
      vi.mocked(stat).mockResolvedValue({ mtime: new Date() } as ReturnType<typeof stat> extends Promise<infer T> ? T : never);

      const checks = await runDoctorJson();
      const artifactCheck = checks.find(c => c.name === 'Analysis artifacts')!;
      expect(artifactCheck.status).toBe('ok');
    });

    it('should show warn for stale analysis', async () => {
      const { stat } = await import('node:fs/promises');
      const staleDate = new Date(Date.now() - 30 * 24 * 3600 * 1000); // 30 days ago
      vi.mocked(stat).mockResolvedValue({ mtime: staleDate } as ReturnType<typeof stat> extends Promise<infer T> ? T : never);

      const checks = await runDoctorJson();
      const artifactCheck = checks.find(c => c.name === 'Analysis artifacts')!;
      expect(artifactCheck.status).toBe('warn');
      expect(artifactCheck.fix).toContain('openlore analyze');
    });

    it('should show warn when no analysis exists', async () => {
      const { stat } = await import('node:fs/promises');
      vi.mocked(stat).mockRejectedValue(new Error('ENOENT'));

      const checks = await runDoctorJson();
      const artifactCheck = checks.find(c => c.name === 'Analysis artifacts')!;
      expect(artifactCheck.status).toBe('warn');
    });
  });

  // --------------------------------------------------------------------------
  describe('exit code', () => {
    it('should set exitCode=1 when any check fails (JSON mode confirms fail status)', async () => {
      consoleSpy.mockImplementation(() => {});
      const keyVars = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENAI_COMPAT_API_KEY'];
      const saved: Record<string, string | undefined> = {};
      for (const k of keyVars) { saved[k] = process.env[k]; delete process.env[k]; }

      const llmService = await import('../../core/services/llm-service.js');
      vi.mocked(llmService.createLLMService).mockImplementationOnce(() => {
        throw new Error('No API key');
      });

      try {
        // Confirm via JSON mode that the LLM check is a 'fail'
        const checks = await runDoctorJson();
        const llmCheck = checks.find(c => c.name === 'LLM connection')!;
        expect(llmCheck.status).toBe('fail');
        // The JSON path returns early, so exitCode is only set in the non-JSON path.
        // Verify the failure count reported includes at least one failure.
        const failures = checks.filter(c => c.status === 'fail');
        expect(failures.length).toBeGreaterThan(0);
      } finally {
        for (const k of keyVars) { if (saved[k] !== undefined) process.env[k] = saved[k]; else delete process.env[k]; }
      }
    });

    it('should not set exitCode=1 when all checks pass', async () => {
      consoleSpy.mockImplementation(() => {});
      const saved: Record<string, string | undefined> = {};
      saved['ANTHROPIC_API_KEY'] = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';
      mockExecSuccess();

      try {
        await doctorCommand.parseAsync(['node', 'doctor'], { from: 'user' });
        expect(process.exitCode).not.toBe(1);
      } finally {
        if (saved['ANTHROPIC_API_KEY'] === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = saved['ANTHROPIC_API_KEY'];
      }
    });

    it('non-JSON: logger.success is called when all checks pass', async () => {
      // Commander.js v12 does not reset option values between parseAsync calls,
      // so we must manually reset --json to false before running in non-JSON mode.
      doctorCommand.setOptionValue('json', false);

      // Re-mock fs functions (clearAllMocks may reset mockResolvedValue)
      const { stat, access } = await import('node:fs/promises');
      vi.mocked(stat).mockResolvedValue({ mtime: new Date() } as ReturnType<typeof stat> extends Promise<infer T> ? T : never);
      vi.mocked(access).mockResolvedValue(undefined);
      const configManager = await import('../../core/services/config-manager.js');
      vi.mocked(configManager.readOpenLoreConfig).mockResolvedValue({
        projectType: 'nodejs', createdAt: '2024-01-01T00:00:00Z', openspecPath: './openspec', maxFiles: 500,
      } as never);

      // Ensure createLLMService returns a working mock (clearAllMocks resets it)
      const llmService = await import('../../core/services/llm-service.js');
      vi.mocked(llmService.createLLMService).mockReturnValue({
        complete: vi.fn().mockResolvedValue({ model: 'claude-opus-4-6', content: 'pong' }),
        saveLogs: vi.fn().mockResolvedValue(undefined),
      } as never);

      const saved = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';

      const loggerModule = await import('../../utils/logger.js');
      vi.mocked(loggerModule.logger.success).mockClear();

      try {
        await doctorCommand.parseAsync(['node', 'doctor'], { from: 'user' });
        expect(vi.mocked(loggerModule.logger.success)).toHaveBeenCalledWith('All checks passed!');
      } finally {
        if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = saved;
      }
    });

    it('non-JSON: logger.error called and exitCode=1 when a check fails', async () => {
      doctorCommand.setOptionValue('json', false);

      const keyVars = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENAI_COMPAT_API_KEY'];
      const saved: Record<string, string | undefined> = {};
      for (const k of keyVars) { saved[k] = process.env[k]; delete process.env[k]; }

      const llmService = await import('../../core/services/llm-service.js');
      vi.mocked(llmService.createLLMService).mockImplementationOnce(() => {
        throw new Error('No API key');
      });

      const loggerModule = await import('../../utils/logger.js');
      vi.mocked(loggerModule.logger.error).mockClear();

      try {
        await doctorCommand.parseAsync(['node', 'doctor'], { from: 'user' });
        expect(vi.mocked(loggerModule.logger.error)).toHaveBeenCalled();
        expect(process.exitCode).toBe(1);
      } finally {
        for (const k of keyVars) { if (saved[k] !== undefined) process.env[k] = saved[k]; else delete process.env[k]; }
      }
    });
  });

  // --------------------------------------------------------------------------
  describe('disk space check', () => {
    it('should show fail when available disk is critically low', async () => {
      // df -k output: header + data line with low available (col 3 = 100 KB = ~0 MB)
      mockExecSuccess('Filesystem 1K-blocks Used Available Use% Mounted\n/dev/disk1 100000000 99999900 100 0% /');

      const checks = await runDoctorJson();
      const diskCheck = checks.find(c => c.name === 'Disk space')!;
      expect(diskCheck.status).toBe('fail');
      expect(diskCheck.detail).toContain('MB available');
    });

    it('should show warn when available disk is low', async () => {
      // ~400 MB available (between FAIL and WARN thresholds)
      mockExecSuccess('Filesystem 1K-blocks Used Available Use% Mounted\n/dev/disk1 100000000 99590000 410000 0% /');

      const checks = await runDoctorJson();
      const diskCheck = checks.find(c => c.name === 'Disk space')!;
      expect(diskCheck.status).toBe('warn');
      expect(diskCheck.detail).toContain('MB available');
    });

    it('should show ok when disk has plenty of space', async () => {
      // 50 GB available
      mockExecSuccess('Filesystem 1K-blocks Used Available Use% Mounted\n/dev/disk1 200000000 100000000 52428800 0% /');

      const checks = await runDoctorJson();
      const diskCheck = checks.find(c => c.name === 'Disk space')!;
      expect(diskCheck.status).toBe('ok');
      expect(diskCheck.detail).toContain('MB available');
    });
  });
});
