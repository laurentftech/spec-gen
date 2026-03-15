import { describe, it, expect } from 'vitest';
import { inferTypesFromSource } from './type-inference-engine.js';

describe('Python', () => {
  it('direct instantiation', () =>
    expect(inferTypesFromSource('service = MyService()\n', 'Python').get('service')).toBe('MyService'));
  it('type hint annotation', () =>
    expect(inferTypesFromSource('repo: UserRepo = get_repo()\n', 'Python').get('repo')).toBe('UserRepo'));
  it('annotated parameter', () =>
    expect(inferTypesFromSource('def run(svc: MyService): pass', 'Python').get('svc')).toBe('MyService'));
});

describe('C++', () => {
  it('explicit declaration', () =>
    expect(inferTypesFromSource('MyService svc;', 'C++').get('svc')).toBe('MyService'));
  it('pointer + new', () =>
    expect(inferTypesFromSource('MyService* svc = new MyService();', 'C++').get('svc')).toBe('MyService'));
  it('shared_ptr', () =>
    expect(inferTypesFromSource('shared_ptr<MyService> svc;', 'C++').get('svc')).toBe('MyService'));
  it('make_unique', () =>
    expect(inferTypesFromSource('auto svc = make_unique<MyService>();', 'C++').get('svc')).toBe('MyService'));
  it('make_shared', () =>
    expect(inferTypesFromSource('auto svc = make_shared<MyService>();', 'C++').get('svc')).toBe('MyService'));
});

describe('TypeScript', () => {
  it('const = new ClassName()', () =>
    expect(inferTypesFromSource('const svc = new MyService();', 'TypeScript').get('svc')).toBe('MyService'));
  it('type annotation', () =>
    expect(inferTypesFromSource('const svc: MyService = inject();', 'TypeScript').get('svc')).toBe('MyService'));
});

describe('JavaScript', () => {
  it('const = new ClassName()', () =>
    expect(inferTypesFromSource('const svc = new MyService();', 'JavaScript').get('svc')).toBe('MyService'));
});

describe('Go', () => {
  it('var declaration', () =>
    expect(inferTypesFromSource('var svc *MyService', 'Go').get('svc')).toBe('MyService'));
  it(':= struct literal', () =>
    expect(inferTypesFromSource('svc := MyService{}', 'Go').get('svc')).toBe('MyService'));
  it(':= address of struct', () =>
    expect(inferTypesFromSource('svc := &MyService{}', 'Go').get('svc')).toBe('MyService'));
});

describe('Rust', () => {
  it('let with type annotation', () =>
    expect(inferTypesFromSource('let svc: MyService = MyService::new();', 'Rust').get('svc')).toBe('MyService'));
  it('let inferred via ::new()', () =>
    expect(inferTypesFromSource('let svc = MyService::new();', 'Rust').get('svc')).toBe('MyService'));
  it('let inferred via ::default()', () =>
    expect(inferTypesFromSource('let svc = MyService::default();', 'Rust').get('svc')).toBe('MyService'));
});

describe('Java', () => {
  it('explicit declaration', () =>
    expect(inferTypesFromSource('MyService svc = new MyService();', 'Java').get('svc')).toBe('MyService'));
  it('interface var = new ConcreteClass — prefers concrete', () =>
    expect(inferTypesFromSource('IService svc = new MyService();', 'Java').get('svc')).toBe('MyService'));
});

describe('Ruby', () => {
  it('.new call', () =>
    expect(inferTypesFromSource('svc = MyService.new', 'Ruby').get('svc')).toBe('MyService'));
});

describe('unknown language', () => {
  it('returns empty map', () =>
    expect(inferTypesFromSource('x = Foo()', 'Cobol').size).toBe(0));
});
