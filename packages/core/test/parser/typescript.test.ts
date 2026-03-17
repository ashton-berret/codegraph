import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { SupportedLanguages } from '../../src/config/languages.js'
import { parseSource } from '../../src/parser/tree-sitter.js'
import { extractTypeScriptSymbols } from '../../src/parser/queries/typescript.js'
import { extractFromRepository } from '../../src/parser/extract.js'
import { scanRepository } from '../../src/walker/filesystem.js'

const fixtureRepoPath = path.resolve(
  process.cwd(),
  'test/fixtures/ts-library'
)

/** Helper to extract symbols from an inline snippet */
function extract(code: string, filePath = 'test.ts') {
  const parsed = parseSource(SupportedLanguages.TypeScript, code)
  return extractTypeScriptSymbols(filePath, parsed)
}

describe('TypeScript parser and extractor', () => {
  it('scanRepository returns parseable source files', async () => {
    const files = await scanRepository(fixtureRepoPath)

    expect(files.length).toBeGreaterThan(0)
    expect(files.every((file) => file.language === SupportedLanguages.TypeScript)).toBe(true)
    expect(files.map((file) => file.path)).toContain('src/index.ts')
  })

  it('parseSource parses a simple TypeScript file', () => {
    const parsed = parseSource(
      SupportedLanguages.TypeScript,
      'export function hello() { return 1 }'
    )

    expect(parsed.rootNode.type).toBe('program')
  })

  it('extractFromRepository finds declarations, imports, exports, and calls', async () => {
    const extractedFiles = await extractFromRepository(fixtureRepoPath)

    const serviceFile = extractedFiles.find((file) => file.filePath === 'src/auth/service.ts')
    expect(serviceFile).toBeDefined()

    const classDeclaration = serviceFile?.declarations.find((item) => item.kind === 'class')
    expect(classDeclaration?.name).toBe('AuthService')

    const methodDeclaration = serviceFile?.declarations.find((item) => item.kind === 'method')
    expect(methodDeclaration?.name).toBe('login')

    const importItem = serviceFile?.imports.find(i => i.source === './validate')
    expect(importItem?.namedImports).toContain('validate')

    const callItem = serviceFile?.calls.find(c => c.callee === 'validate')
    expect(callItem).toBeDefined()

    const indexFile = extractedFiles.find((file) => file.filePath === 'src/index.ts')
    expect(indexFile).toBeDefined()
    expect(indexFile?.exports.length).toBeGreaterThan(0)
  })
})

// ── Interface extraction ───────────────────────────────────────────

describe('Interface extraction', () => {
  it('extracts interface name and properties', () => {
    const result = extract(`
      export interface User {
        id: string
        name: string
      }
    `)

    const iface = result.declarations.find(d => d.kind === 'interface')
    expect(iface).toBeDefined()
    expect(iface?.name).toBe('User')
    expect(iface?.exported).toBe(true)
    expect(iface?.properties).toEqual([
      { name: 'id', type: 'string' },
      { name: 'name', type: 'string' },
    ])
  })

  it('extracts interface extends', () => {
    const result = extract(`
      interface Base { id: string }
      interface Extended extends Base {
        extra: number
      }
    `)

    const ext = result.declarations.find(d => d.name === 'Extended')
    expect(ext?.kind).toBe('interface')
    expect(ext?.interfaceExtends).toEqual(['Base'])
  })

  it('does not create an export record without export keyword', () => {
    const result = extract(`interface Foo { x: number }`)
    expect(result.exports).toHaveLength(0)
  })
})

// ── Type alias extraction ──────────────────────────────────────────

describe('Type alias extraction', () => {
  it('extracts type alias name and typeText', () => {
    const result = extract(`export type UserId = string`)

    const ta = result.declarations.find(d => d.kind === 'type_alias')
    expect(ta).toBeDefined()
    expect(ta?.name).toBe('UserId')
    expect(ta?.typeText).toBe('string')
    expect(ta?.exported).toBe(true)
  })

  it('extracts union type alias', () => {
    const result = extract(`type Role = 'admin' | 'user' | 'guest'`)

    const ta = result.declarations.find(d => d.name === 'Role')
    expect(ta?.kind).toBe('type_alias')
    expect(ta?.typeText).toContain('admin')
  })
})

// ── Enum extraction ────────────────────────────────────────────────

describe('Enum extraction', () => {
  it('extracts enum name and members', () => {
    const result = extract(`
      export enum Status {
        Active,
        Inactive,
        Pending
      }
    `)

    const en = result.declarations.find(d => d.kind === 'enum')
    expect(en).toBeDefined()
    expect(en?.name).toBe('Status')
    expect(en?.members).toEqual(['Active', 'Inactive', 'Pending'])
    expect(en?.exported).toBe(true)
  })

  it('extracts enum with string values', () => {
    const result = extract(`
      enum Color {
        Red = 'RED',
        Green = 'GREEN'
      }
    `)

    const en = result.declarations.find(d => d.name === 'Color')
    expect(en?.kind).toBe('enum')
    expect(en?.members).toEqual(['Red', 'Green'])
  })
})

// ── Variable extraction ────────────────────────────────────────────

describe('Variable extraction', () => {
  it('extracts const variable with type', () => {
    const result = extract(`export const MAX: number = 100`)

    const v = result.declarations.find(d => d.kind === 'variable')
    expect(v).toBeDefined()
    expect(v?.name).toBe('MAX')
    expect(v?.isConst).toBe(true)
    expect(v?.varType).toBe('number')
    expect(v?.exported).toBe(true)
  })

  it('extracts let variable', () => {
    const result = extract(`let count = 0`)

    const v = result.declarations.find(d => d.kind === 'variable')
    expect(v).toBeDefined()
    expect(v?.name).toBe('count')
    expect(v?.isConst).toBeFalsy()
  })
})

// ── Arrow function extraction ──────────────────────────────────────

describe('Arrow function extraction', () => {
  it('extracts arrow function as kind=function with params and returnType', () => {
    const result = extract(`export const add = (a: number, b: number): number => a + b`)

    const fn = result.declarations.find(d => d.kind === 'function' && d.name === 'add')
    expect(fn).toBeDefined()
    expect(fn?.isConst).toBe(true)
    expect(fn?.params).toEqual([
      { name: 'a', type: 'number' },
      { name: 'b', type: 'number' },
    ])
    expect(fn?.returnType).toBe('number')
    expect(fn?.exported).toBe(true)
  })

  it('extracts async arrow function', () => {
    const result = extract(`const fetchData = async (url: string): Promise<string> => { return '' }`)

    const fn = result.declarations.find(d => d.kind === 'function' && d.name === 'fetchData')
    expect(fn).toBeDefined()
    expect(fn?.async).toBe(true)
  })

  it('extracts calls inside arrow function body', () => {
    const result = extract(`
      const doWork = (x: number): number => {
        return Math.abs(x)
      }
    `)

    const call = result.calls.find(c => c.callee === 'Math.abs')
    expect(call).toBeDefined()
    expect(call?.containingSymbol).toBe('doWork')
  })
})

// ── Function params and returnType ─────────────────────────────────

describe('Function params and returnType', () => {
  it('extracts function params and returnType', () => {
    const result = extract(`
      function greet(name: string, age?: number): string {
        return name
      }
    `)

    const fn = result.declarations.find(d => d.kind === 'function')
    expect(fn?.params).toEqual([
      { name: 'name', type: 'string' },
      { name: 'age', type: 'number', optional: true },
    ])
    expect(fn?.returnType).toBe('string')
  })

  it('handles function with no params', () => {
    const result = extract(`function noop(): void {}`)

    const fn = result.declarations.find(d => d.kind === 'function')
    expect(fn?.params).toEqual([])
    expect(fn?.returnType).toBe('void')
  })
})

// ── Class heritage ─────────────────────────────────────────────────

describe('Class heritage', () => {
  it('extracts extends', () => {
    const result = extract(`class Dog extends Animal {}`)

    const cls = result.declarations.find(d => d.kind === 'class')
    expect(cls?.heritage?.extends).toBe('Animal')
  })

  it('extracts implements', () => {
    const result = extract(`class Cat implements Pet, Serializable {}`)

    const cls = result.declarations.find(d => d.kind === 'class')
    expect(cls?.heritage?.implements).toEqual(['Pet', 'Serializable'])
  })

  it('extracts both extends and implements', () => {
    const result = extract(`class Admin extends User implements Authorizable {}`)

    const cls = result.declarations.find(d => d.kind === 'class')
    expect(cls?.heritage?.extends).toBe('User')
    expect(cls?.heritage?.implements).toEqual(['Authorizable'])
  })
})

// ── Method visibility, isStatic, async ─────────────────────────────

describe('Method metadata', () => {
  it('extracts visibility modifiers', () => {
    const result = extract(`
      class Svc {
        public doPublic() {}
        private doPrivate() {}
        protected doProtected() {}
      }
    `)

    const methods = result.declarations.filter(d => d.kind === 'method')
    const pub = methods.find(m => m.name === 'doPublic')
    const priv = methods.find(m => m.name === 'doPrivate')
    const prot = methods.find(m => m.name === 'doProtected')

    expect(pub?.visibility).toBe('public')
    expect(priv?.visibility).toBe('private')
    expect(prot?.visibility).toBe('protected')
  })

  it('extracts static methods', () => {
    const result = extract(`
      class Factory {
        static create(): Factory { return new Factory() }
      }
    `)

    const method = result.declarations.find(d => d.kind === 'method')
    expect(method?.isStatic).toBe(true)
  })

  it('extracts async methods via AST (not string matching)', () => {
    const result = extract(`
      class Api {
        async fetchData(url: string): Promise<string> { return '' }
      }
    `)

    const method = result.declarations.find(d => d.kind === 'method')
    expect(method?.async).toBe(true)
    expect(method?.params).toEqual([{ name: 'url', type: 'string' }])
    expect(method?.returnType).toBe('Promise<string>')
  })

  it('does not falsely detect async from method name', () => {
    const result = extract(`
      class Svc {
        asyncTask(): void {}
      }
    `)

    const method = result.declarations.find(d => d.kind === 'method')
    expect(method?.async).toBeUndefined()
  })
})

// ── Import isTypeOnly ──────────────────────────────────────────────

describe('Import isTypeOnly', () => {
  it('detects type-only imports', () => {
    const result = extract(`import type { User } from './models'`)

    const imp = result.imports[0]
    expect(imp?.isTypeOnly).toBe(true)
  })

  it('regular imports are not type-only', () => {
    const result = extract(`import { User } from './models'`)

    const imp = result.imports[0]
    expect(imp?.isTypeOnly).toBeUndefined()
  })
})

// ── Call argumentsCount and containingSymbol ────────────────────────

describe('Call metadata', () => {
  it('extracts argumentsCount', () => {
    const result = extract(`
      function test() {
        console.log('hello', 'world')
      }
    `)

    const call = result.calls.find(c => c.callee === 'console.log')
    expect(call?.argumentsCount).toBe(2)
  })

  it('extracts containingSymbol inside methods', () => {
    const result = extract(`
      class AuthService {
        login(token: string): boolean {
          return validate(token)
        }
      }
    `)

    const call = result.calls.find(c => c.callee === 'validate')
    expect(call?.containingSymbol).toBe('AuthService.login')
  })

  it('zero arguments count', () => {
    const result = extract(`foo()`)

    const call = result.calls[0]
    expect(call?.argumentsCount).toBe(0)
  })
})

// ── Export records for direct declarations ──────────────────────────

describe('Export records for direct declarations', () => {
  it('creates export record for export function', () => {
    const result = extract(`export function hello() {}`)

    const exp = result.exports.find(e => e.name === 'hello')
    expect(exp).toBeDefined()
    expect(exp?.isDefault).toBe(false)
    expect(exp?.isReExport).toBe(false)
  })

  it('creates export record for export class', () => {
    const result = extract(`export class MyClass {}`)

    const exp = result.exports.find(e => e.name === 'MyClass')
    expect(exp).toBeDefined()
  })

  it('creates export record for export const', () => {
    const result = extract(`export const VERSION: string = '1.0'`)

    const exp = result.exports.find(e => e.name === 'VERSION')
    expect(exp).toBeDefined()
  })

  it('creates export record for export interface', () => {
    const result = extract(`export interface Foo { x: number }`)

    const exp = result.exports.find(e => e.name === 'Foo')
    expect(exp).toBeDefined()
  })

  it('creates export record for export enum', () => {
    const result = extract(`export enum Dir { Up, Down }`)

    const exp = result.exports.find(e => e.name === 'Dir')
    expect(exp).toBeDefined()
  })

  it('creates export record for export type alias', () => {
    const result = extract(`export type ID = string`)

    const exp = result.exports.find(e => e.name === 'ID')
    expect(exp).toBeDefined()
  })
})

// ── Full fixture integration ───────────────────────────────────────

describe('Full fixture integration', () => {
  it('extracts all symbol kinds from models/types.ts', async () => {
    const extractedFiles = await extractFromRepository(fixtureRepoPath)
    const typesFile = extractedFiles.find(f => f.filePath === 'src/models/types.ts')
    expect(typesFile).toBeDefined()

    // Interfaces
    const userIface = typesFile?.declarations.find(d => d.kind === 'interface' && d.name === 'User')
    expect(userIface).toBeDefined()
    expect(userIface?.properties?.map(p => p.name)).toContain('id')

    const adminIface = typesFile?.declarations.find(d => d.kind === 'interface' && d.name === 'Admin')
    expect(adminIface?.interfaceExtends).toEqual(['User'])

    // Type aliases
    const userId = typesFile?.declarations.find(d => d.kind === 'type_alias' && d.name === 'UserId')
    expect(userId?.typeText).toBe('string')

    // Enums
    const status = typesFile?.declarations.find(d => d.kind === 'enum' && d.name === 'Status')
    expect(status?.members).toEqual(['Active', 'Inactive', 'Pending'])

    // Variables
    const maxUsers = typesFile?.declarations.find(d => d.kind === 'variable' && d.name === 'MAX_USERS')
    expect(maxUsers?.isConst).toBe(true)
    expect(maxUsers?.varType).toBe('number')

    // Arrow functions
    const createUser = typesFile?.declarations.find(d => d.kind === 'function' && d.name === 'createUser')
    expect(createUser?.params?.map(p => p.name)).toEqual(['name', 'email'])
    expect(createUser?.returnType).toBe('User')

    // Async arrow function
    const fetchUser = typesFile?.declarations.find(d => d.kind === 'function' && d.name === 'fetchUser')
    expect(fetchUser?.async).toBe(true)
  })

  it('extracts method metadata from auth/service.ts', async () => {
    const extractedFiles = await extractFromRepository(fixtureRepoPath)
    const serviceFile = extractedFiles.find(f => f.filePath === 'src/auth/service.ts')
    expect(serviceFile).toBeDefined()

    // Type-only import
    const typeImport = serviceFile?.imports.find(i => i.source === '../models/types')
    expect(typeImport?.isTypeOnly).toBe(true)

    // Method visibility
    const login = serviceFile?.declarations.find(d => d.kind === 'method' && d.name === 'login')
    expect(login?.visibility).toBe('public')
    expect(login?.params).toEqual([{ name: 'token', type: 'string' }])
    expect(login?.returnType).toBe('boolean')

    const refresh = serviceFile?.declarations.find(d => d.kind === 'method' && d.name === 'refresh')
    expect(refresh?.visibility).toBe('protected')

    // Static method
    const create = serviceFile?.declarations.find(d => d.kind === 'method' && d.name === 'create')
    expect(create?.isStatic).toBe(true)

    // Async method
    const verifyUser = serviceFile?.declarations.find(d => d.kind === 'method' && d.name === 'verifyUser')
    expect(verifyUser?.async).toBe(true)

    // containingSymbol for calls inside methods
    const validateCall = serviceFile?.calls.find(c => c.callee === 'validate' && c.containingSymbol === 'AuthService.login')
    expect(validateCall).toBeDefined()
    expect(validateCall?.argumentsCount).toBe(1)
  })

  it('extracts export const VERSION from index.ts', async () => {
    const extractedFiles = await extractFromRepository(fixtureRepoPath)
    const indexFile = extractedFiles.find(f => f.filePath === 'src/index.ts')
    expect(indexFile).toBeDefined()

    const version = indexFile?.declarations.find(d => d.kind === 'variable' && d.name === 'VERSION')
    expect(version).toBeDefined()
    expect(version?.isConst).toBe(true)
    expect(version?.varType).toBe('string')

    const versionExport = indexFile?.exports.find(e => e.name === 'VERSION')
    expect(versionExport).toBeDefined()
  })

  it('extracts re-exports from models/index.ts', async () => {
    const extractedFiles = await extractFromRepository(fixtureRepoPath)
    const modelsIndex = extractedFiles.find(f => f.filePath === 'src/models/index.ts')
    expect(modelsIndex).toBeDefined()

    // Re-exports should be captured
    const userExport = modelsIndex?.exports.find(e => e.name === 'User')
    expect(userExport).toBeDefined()
    expect(userExport?.isReExport).toBe(true)
    expect(userExport?.source).toBe('./types')

    const userIdExport = modelsIndex?.exports.find(e => e.name === 'UserId')
    expect(userIdExport).toBeDefined()
    expect(userIdExport?.isReExport).toBe(true)

    const statusExport = modelsIndex?.exports.find(e => e.name === 'Status')
    expect(statusExport).toBeDefined()
    expect(statusExport?.isReExport).toBe(true)
  })
})
