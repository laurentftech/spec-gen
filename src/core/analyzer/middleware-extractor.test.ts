/**
 * Middleware Extractor Tests
 *
 * Tests each framework/type combination using temp files written to os.tmpdir().
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extractMiddleware } from './middleware-extractor.js';

// ============================================================================
// HELPERS
// ============================================================================

async function createTempDir(): Promise<string> {
  const dir = join(tmpdir(), `middleware-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function createFile(dir: string, name: string, content: string): Promise<string> {
  const parts = name.split('/');
  if (parts.length > 1) {
    await mkdir(join(dir, ...parts.slice(0, -1)), { recursive: true });
  }
  const fp = join(dir, name);
  await writeFile(fp, content, 'utf-8');
  return fp;
}

// ============================================================================
// TESTS — Express
// ============================================================================

describe('extractMiddleware — Express', () => {
  let tmpDir: string;

  beforeEach(async () => { tmpDir = await createTempDir(); });
  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

  it('detects CORS middleware via app.use(cors())', async () => {
    const fp = await createFile(tmpDir, 'app.ts', `
import express from 'express';
import cors from 'cors';
const app = express();
app.use(cors());
`);
    const entries = await extractMiddleware([fp], tmpDir);
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const cors = entries.find(e => e.type === 'cors');
    expect(cors).toBeDefined();
    expect(cors!.framework).toBe('express');
  });

  it('detects auth middleware via helmet()', async () => {
    const fp = await createFile(tmpDir, 'server.ts', `
import express from 'express';
import helmet from 'helmet';
const app = express();
app.use(helmet());
`);
    const entries = await extractMiddleware([fp], tmpDir);
    const auth = entries.find(e => e.type === 'auth' && e.name === 'helmet');
    expect(auth).toBeDefined();
  });

  it('detects auth middleware via passport.authenticate', async () => {
    const fp = await createFile(tmpDir, 'routes.ts', `
import express from 'express';
import passport from 'passport';
const router = express.Router();
router.get('/profile', passport.authenticate('jwt'), getProfile);
`);
    const entries = await extractMiddleware([fp], tmpDir);
    const auth = entries.find(e => e.type === 'auth' && e.name === 'passport');
    expect(auth).toBeDefined();
  });

  it('detects auth middleware via jwt(', async () => {
    const fp = await createFile(tmpDir, 'auth.ts', `
import express from 'express';
import { expressjwt as jwt } from 'express-jwt';
const app = express();
app.use(jwt({ secret: 'shh' }));
`);
    const entries = await extractMiddleware([fp], tmpDir);
    const auth = entries.find(e => e.type === 'auth' && e.name === 'jwt');
    expect(auth).toBeDefined();
  });

  it('detects rate-limit middleware via rateLimit(', async () => {
    const fp = await createFile(tmpDir, 'app.ts', `
import express from 'express';
import rateLimit from 'express-rate-limit';
const app = express();
app.use(rateLimit({ windowMs: 60000, max: 100 }));
`);
    const entries = await extractMiddleware([fp], tmpDir);
    const rl = entries.find(e => e.type === 'rate-limit');
    expect(rl).toBeDefined();
    expect(rl!.name).toBe('rateLimit');
  });

  it('detects logging middleware via morgan(', async () => {
    const fp = await createFile(tmpDir, 'app.ts', `
import express from 'express';
import morgan from 'morgan';
const app = express();
app.use(morgan('combined'));
`);
    const entries = await extractMiddleware([fp], tmpDir);
    const logging = entries.find(e => e.type === 'logging');
    expect(logging).toBeDefined();
    expect(logging!.name).toBe('morgan');
  });

  it('detects validation middleware via express.json', async () => {
    const fp = await createFile(tmpDir, 'app.ts', `
import express from 'express';
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
`);
    const entries = await extractMiddleware([fp], tmpDir);
    const validation = entries.find(e => e.type === 'validation');
    expect(validation).toBeDefined();
  });

  it('detects error-handler via 4-argument function signature', async () => {
    const fp = await createFile(tmpDir, 'errorHandler.ts', `
import express from 'express';
const app = express();
function handleError(err, req, res, next) {
  res.status(500).json({ error: err.message });
}
app.use(handleError);
`);
    const entries = await extractMiddleware([fp], tmpDir);
    const errHandler = entries.find(e => e.type === 'error-handler');
    expect(errHandler).toBeDefined();
    expect(errHandler!.framework).toBe('express');
  });

  it('detects error-handler via arrow function 4-argument signature', async () => {
    const fp = await createFile(tmpDir, 'app.ts', `
import express from 'express';
const app = express();
app.use((err, req, res, next) => {
  res.status(500).send(err.message);
});
`);
    const entries = await extractMiddleware([fp], tmpDir);
    const errHandler = entries.find(e => e.type === 'error-handler');
    expect(errHandler).toBeDefined();
  });
});

// ============================================================================
// TESTS — NestJS
// ============================================================================

describe('extractMiddleware — NestJS', () => {
  let tmpDir: string;

  beforeEach(async () => { tmpDir = await createTempDir(); });
  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

  it('detects auth via @UseGuards()', async () => {
    const fp = await createFile(tmpDir, 'users.controller.ts', `
import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Controller('users')
@UseGuards(AuthGuard('jwt'))
export class UsersController {
  @Get()
  findAll() { return []; }
}
`);
    const entries = await extractMiddleware([fp], tmpDir);
    const auth = entries.find(e => e.type === 'auth' && e.name === 'UseGuards');
    expect(auth).toBeDefined();
    expect(auth!.framework).toBe('nestjs');
  });

  it('detects custom via @UseInterceptors()', async () => {
    const fp = await createFile(tmpDir, 'logging.interceptor.ts', `
import { Injectable, NestInterceptor, ExecutionContext, CallHandler, UseInterceptors } from '@nestjs/common';

@UseInterceptors(LoggingInterceptor)
export class SomeController {}
`);
    const entries = await extractMiddleware([fp], tmpDir);
    const custom = entries.find(e => e.type === 'custom' && e.name === 'UseInterceptors');
    expect(custom).toBeDefined();
    expect(custom!.framework).toBe('nestjs');
  });

  it('detects auth via APP_GUARD', async () => {
    const fp = await createFile(tmpDir, 'app.module.ts', `
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

@Module({
  providers: [{ provide: APP_GUARD, useClass: JwtAuthGuard }],
})
export class AppModule {}
`);
    const entries = await extractMiddleware([fp], tmpDir);
    const guard = entries.find(e => e.name === 'APP_GUARD');
    expect(guard).toBeDefined();
    expect(guard!.type).toBe('auth');
    expect(guard!.framework).toBe('nestjs');
  });

  it('detects custom via APP_INTERCEPTOR', async () => {
    const fp = await createFile(tmpDir, 'app.module.ts', `
import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';

@Module({
  providers: [{ provide: APP_INTERCEPTOR, useClass: LoggingInterceptor }],
})
export class AppModule {}
`);
    const entries = await extractMiddleware([fp], tmpDir);
    const interceptor = entries.find(e => e.name === 'APP_INTERCEPTOR');
    expect(interceptor).toBeDefined();
    expect(interceptor!.type).toBe('custom');
    expect(interceptor!.framework).toBe('nestjs');
  });
});

// ============================================================================
// TESTS — Next.js
// ============================================================================

describe('extractMiddleware — Next.js', () => {
  let tmpDir: string;

  beforeEach(async () => { tmpDir = await createTempDir(); });
  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

  it('detects Next.js middleware from middleware.ts file at root', async () => {
    const fp = await createFile(tmpDir, 'middleware.ts', `
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  return NextResponse.next();
}

export const config = { matcher: ['/api/:path*'] };
`);
    const entries = await extractMiddleware([fp], tmpDir);
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const mw = entries.find(e => e.framework === 'nextjs');
    expect(mw).toBeDefined();
    expect(mw!.type).toBe('custom');
  });

  it('detects Next.js middleware from src/middleware.ts', async () => {
    const fp = await createFile(tmpDir, 'src/middleware.ts', `
import { NextResponse } from 'next/server';
export function middleware() { return NextResponse.next(); }
`);
    const entries = await extractMiddleware([fp], tmpDir);
    const mw = entries.find(e => e.framework === 'nextjs' && e.type === 'custom');
    expect(mw).toBeDefined();
  });
});

// ============================================================================
// TESTS — Fastify
// ============================================================================

describe('extractMiddleware — Fastify', () => {
  let tmpDir: string;

  beforeEach(async () => { tmpDir = await createTempDir(); });
  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

  it('detects auth via fastify.addHook onRequest', async () => {
    const fp = await createFile(tmpDir, 'server.ts', `
import fastify from 'fastify';
const server = fastify();
server.addHook('onRequest', async (req, reply) => {
  // auth logic
});
`);
    const entries = await extractMiddleware([fp], tmpDir);
    const auth = entries.find(e => e.type === 'auth' && e.framework === 'fastify');
    expect(auth).toBeDefined();
  });

  it('detects cors via fastify.register(cors', async () => {
    const fp = await createFile(tmpDir, 'app.ts', `
import fastify from 'fastify';
import cors from '@fastify/cors';
const server = fastify();
server.register(cors, { origin: true });
`);
    const entries = await extractMiddleware([fp], tmpDir);
    const corsEntry = entries.find(e => e.type === 'cors' && e.framework === 'fastify');
    expect(corsEntry).toBeDefined();
  });
});

// ============================================================================
// TESTS — general behaviour
// ============================================================================

describe('extractMiddleware — general', () => {
  let tmpDir: string;

  beforeEach(async () => { tmpDir = await createTempDir(); });
  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

  it('returns relative paths in file field', async () => {
    const fp = await createFile(tmpDir, 'src/app.ts', `
import express from 'express';
import cors from 'cors';
const app = express();
app.use(cors());
`);
    const entries = await extractMiddleware([fp], tmpDir);
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0].file).not.toContain(tmpDir);
    expect(entries[0].file).toContain('src');
  });

  it('skips non-JS/TS files', async () => {
    const fp = await createFile(tmpDir, 'schema.prisma', `
model User { id Int @id }
`);
    const entries = await extractMiddleware([fp], tmpDir);
    expect(entries).toHaveLength(0);
  });

  it('returns empty array when no middleware detected', async () => {
    const fp = await createFile(tmpDir, 'utils.ts', `
export function add(a: number, b: number): number {
  return a + b;
}
`);
    const entries = await extractMiddleware([fp], tmpDir);
    expect(entries).toHaveLength(0);
  });

  it('includes line number in entries', async () => {
    const fp = await createFile(tmpDir, 'app.ts', `
import express from 'express';
import cors from 'cors';
const app = express();

app.use(cors());
`);
    const entries = await extractMiddleware([fp], tmpDir);
    const corsEntry = entries.find(e => e.type === 'cors');
    expect(corsEntry).toBeDefined();
    expect(typeof corsEntry!.line).toBe('number');
    expect(corsEntry!.line).toBeGreaterThan(0);
  });
});
