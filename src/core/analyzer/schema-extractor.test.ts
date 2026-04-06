/**
 * Schema Extractor Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extractSchemas, summarizeSchemas } from './schema-extractor.js';

// ============================================================================
// HELPERS
// ============================================================================

async function createTempDir(): Promise<string> {
  const dir = join(tmpdir(), `schema-extractor-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function createFile(dir: string, name: string, content: string): Promise<string> {
  const filePath = join(dir, name);
  await writeFile(filePath, content, 'utf-8');
  return filePath;
}

// ============================================================================
// TESTS
// ============================================================================

describe('extractSchemas – Prisma', () => {
  let tmpDir: string;

  beforeEach(async () => { tmpDir = await createTempDir(); });
  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

  it('extracts a basic Prisma model', async () => {
    const fp = await createFile(tmpDir, 'schema.prisma', `
model User {
  id        Int     @id @default(autoincrement())
  email     String  @unique
  name      String?
  createdAt DateTime @default(now())
}
`);
    const tables = await extractSchemas([fp], tmpDir);
    expect(tables).toHaveLength(1);
    expect(tables[0].name).toBe('User');
    expect(tables[0].orm).toBe('prisma');
    const fields = tables[0].fields.map(f => f.name);
    expect(fields).toContain('email');
    expect(fields).toContain('name');
    // audit fields should be excluded
    expect(fields).not.toContain('createdAt');
  });

  it('extracts multiple Prisma models', async () => {
    const fp = await createFile(tmpDir, 'schema.prisma', `
model Post {
  id      Int    @id
  title   String
  content String?
}

model Comment {
  id   Int    @id
  body String
}
`);
    const tables = await extractSchemas([fp], tmpDir);
    expect(tables).toHaveLength(2);
    expect(tables.map(t => t.name).sort()).toEqual(['Comment', 'Post']);
  });

  it('detects nullable fields via ?', async () => {
    const fp = await createFile(tmpDir, 'schema.prisma', `
model Item {
  id   Int     @id
  note String?
}
`);
    const tables = await extractSchemas([fp], tmpDir);
    const noteField = tables[0].fields.find(f => f.name === 'note');
    expect(noteField?.nullable).toBe(true);
    const idField = tables[0].fields.find(f => f.name === 'id');
    expect(idField?.nullable).toBe(false);
  });
});

describe('extractSchemas – Drizzle variants', () => {
  let tmpDir: string;

  beforeEach(async () => { tmpDir = await createTempDir(); });
  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

  it('extracts a Drizzle mysqlTable definition', async () => {
    const fp = await createFile(tmpDir, 'schema-mysql.ts', `
import { mysqlTable, serial, varchar, int } from 'drizzle-orm/mysql-core';

export const orders = mysqlTable('orders', {
  id: serial('id').primaryKey(),
  customerId: int('customer_id').notNull(),
  status: varchar('status', { length: 50 }),
  createdAt: varchar('created_at', { length: 30 }),
});
`);
    const tables = await extractSchemas([fp], tmpDir);
    expect(tables).toHaveLength(1);
    expect(tables[0].name).toBe('orders');
    expect(tables[0].orm).toBe('drizzle');
    const fields = tables[0].fields.map(f => f.name);
    expect(fields).toContain('id');
    expect(fields).toContain('customerId');
    expect(fields).toContain('status');
    expect(fields).not.toContain('createdAt');
  });

  it('extracts a Drizzle sqliteTable definition', async () => {
    const fp = await createFile(tmpDir, 'schema-sqlite.ts', `
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const notes = sqliteTable('notes', {
  id: integer('id').primaryKey(),
  content: text('content').notNull(),
  updatedAt: text('updated_at'),
});
`);
    const tables = await extractSchemas([fp], tmpDir);
    expect(tables).toHaveLength(1);
    expect(tables[0].name).toBe('notes');
    expect(tables[0].orm).toBe('drizzle');
    const fields = tables[0].fields.map(f => f.name);
    expect(fields).toContain('id');
    expect(fields).toContain('content');
    expect(fields).not.toContain('updatedAt');
  });
});

describe('extractSchemas – Drizzle', () => {
  let tmpDir: string;

  beforeEach(async () => { tmpDir = await createTempDir(); });
  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

  it('extracts a Drizzle pgTable definition', async () => {
    const fp = await createFile(tmpDir, 'schema.ts', `
import { pgTable, serial, text, integer } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  age: integer('age'),
  createdAt: text('created_at'),
});
`);
    const tables = await extractSchemas([fp], tmpDir);
    expect(tables).toHaveLength(1);
    expect(tables[0].name).toBe('users');
    expect(tables[0].orm).toBe('drizzle');
    const fields = tables[0].fields.map(f => f.name);
    expect(fields).toContain('id');
    expect(fields).toContain('name');
    expect(fields).toContain('age');
    // audit field excluded
    expect(fields).not.toContain('createdAt');
  });
});

describe('extractSchemas – TypeORM', () => {
  let tmpDir: string;

  beforeEach(async () => { tmpDir = await createTempDir(); });
  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

  it('extracts a TypeORM entity', async () => {
    const fp = await createFile(tmpDir, 'user.entity.ts', `
import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity()
export class User {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  name: string;

  @Column({ nullable: true })
  bio: string | null;

  @UpdateDateColumn()
  updatedAt: Date;
}
`);
    const tables = await extractSchemas([fp], tmpDir);
    expect(tables).toHaveLength(1);
    expect(tables[0].name).toBe('User');
    expect(tables[0].orm).toBe('typeorm');
    const fields = tables[0].fields.map(f => f.name);
    expect(fields).toContain('name');
    expect(fields).not.toContain('updatedAt');
  });

  it('excludes @CreateDateColumn and @UpdateDateColumn as audit fields', async () => {
    const fp = await createFile(tmpDir, 'post.entity.ts', `
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity()
export class Post {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  title: string;

  @Column()
  body: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
`);
    const tables = await extractSchemas([fp], tmpDir);
    expect(tables).toHaveLength(1);
    const fields = tables[0].fields.map(f => f.name);
    expect(fields).toContain('title');
    expect(fields).toContain('body');
    // Audit fields should be excluded
    expect(fields).not.toContain('createdAt');
    expect(fields).not.toContain('updatedAt');
  });
});

describe('extractSchemas – SQLAlchemy', () => {
  let tmpDir: string;

  beforeEach(async () => { tmpDir = await createTempDir(); });
  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

  it('extracts a SQLAlchemy model', async () => {
    const fp = await createFile(tmpDir, 'models.py', `
from sqlalchemy import Column, Integer, String, Boolean
from sqlalchemy.ext.declarative import declarative_base

Base = declarative_base()

class Product(Base):
    __tablename__ = 'products'
    id = Column(Integer, primary_key=True)
    name = Column(String, nullable=False)
    active = Column(Boolean, nullable=False)
    created_at = Column(String)
`);
    const tables = await extractSchemas([fp], tmpDir);
    expect(tables).toHaveLength(1);
    expect(tables[0].name).toBe('Product');
    expect(tables[0].orm).toBe('sqlalchemy');
    const fields = tables[0].fields.map(f => f.name);
    expect(fields).toContain('id');
    expect(fields).toContain('name');
    // audit field excluded
    expect(fields).not.toContain('created_at');
  });

  it('extracts a SQLAlchemy model using mapped_column() syntax (without type annotation)', async () => {
    const fp = await createFile(tmpDir, 'models2.py', `
from sqlalchemy.orm import DeclarativeBase, mapped_column
from sqlalchemy import Integer, String

class Category(DeclarativeBase):
    __tablename__ = 'categories'
    id = mapped_column(Integer, primary_key=True)
    label = mapped_column(String(100), nullable=False)
    description = mapped_column(String, nullable=True)
    updated_at = mapped_column(String)
`);
    const tables = await extractSchemas([fp], tmpDir);
    expect(tables).toHaveLength(1);
    expect(tables[0].name).toBe('Category');
    expect(tables[0].orm).toBe('sqlalchemy');
    const fields = tables[0].fields.map(f => f.name);
    expect(fields).toContain('id');
    expect(fields).toContain('label');
    expect(fields).toContain('description');
    // audit field excluded
    expect(fields).not.toContain('updated_at');
  });
});

describe('extractSchemas – edge cases', () => {
  let tmpDir: string;

  beforeEach(async () => { tmpDir = await createTempDir(); });
  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

  it('returns empty for plain .ts files without ORM decorators', async () => {
    const fp = await createFile(tmpDir, 'service.ts', `
export class UserService {
  getUser() { return null; }
}
`);
    const tables = await extractSchemas([fp], tmpDir);
    expect(tables).toHaveLength(0);
  });

  it('uses relative paths in file field', async () => {
    const fp = await createFile(tmpDir, 'schema.prisma', `
model Thing { id Int @id }
`);
    const tables = await extractSchemas([fp], tmpDir);
    expect(tables[0].file).toBe('schema.prisma');
    expect(tables[0].file).not.toContain(tmpDir);
  });
});

describe('summarizeSchemas', () => {
  it('counts tables by ORM', () => {
    const tables = [
      { name: 'A', file: 'a', orm: 'prisma' as const, fields: [], line: 1 },
      { name: 'B', file: 'b', orm: 'prisma' as const, fields: [], line: 1 },
      { name: 'C', file: 'c', orm: 'drizzle' as const, fields: [], line: 1 },
    ];
    const summary = summarizeSchemas(tables);
    expect(summary['prisma']).toBe(2);
    expect(summary['drizzle']).toBe(1);
    expect(summary['typeorm']).toBeUndefined();
  });
});
