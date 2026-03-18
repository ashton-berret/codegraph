import type { ExtractedImport } from "../parser/queries/typescript.js"
import type { ExtractedFile } from '../parser/extract.js'
import type { SymbolTable } from "./symbol-table.js"
import type { TsconfigPaths } from "./tsconfig-loader.js"

export interface ResolvedImport {
    importId: string
    resolvedFilePath: string | null
    isExternal: boolean
    resolvedSymbols: ResolvedSymbolRef[]
}

export interface ResolvedSymbolRef {
    importedName: string
    resolvedSymbolId: string | null
}

const EXTENSION_CANDIDATES = [
    '.ts',
    '.tsx',
    '/index.ts',
    '.js',
    '/index.js'
] as const

export class ImportResolver {
    private readonly symbolTable: SymbolTable
    private readonly tsconfigPaths: TsconfigPaths | null
    private readonly repoPath: string

    constructor(symbolTable: SymbolTable, tsconfigPaths: TsconfigPaths | null, repoPath: string) {
        this.symbolTable = symbolTable
        this.tsconfigPaths = tsconfigPaths
        this.repoPath = repoPath
    }

    // resolve a single import statement
    resolve(importRecord: ExtractedImport, fromFile: string): ResolvedImport {
        const source = importRecord.source

        // external package
        if (this.isExternalSpecifier(source)) {
            return {
                importId: importRecord.id,
                resolvedFilePath: null,
                isExternal: true,
                resolvedSymbols: this.buildUnresolvedSymbolRefs(importRecord),
            }
        }

        // path alias
        const aliasResolved = this.tryResolvePathAlias(source)
        if (aliasResolved !== null) {
            const filePath = this.tryResolveToFile(aliasResolved)
            return this.buildResult(importRecord, filePath)
        }

        // relative import
        const dir = parentDir(fromFile)
        const joined = normalizePath(dir ? `${dir}/${source}` : source)
        const filePath = this.tryResolveToFile(joined)

        return this.buildResult(importRecord, filePath)
    }

    // resolve all imports across the extracted files
    resolveAll(files: ExtractedFile[]): ResolvedImport[] {
        const results:  ResolvedImport[] = []

        for (const file of files) {
            for (const importRecord of file.imports) {
                results.push(this.resolve(importRecord, file.filePath))
            }
        }

        return results
    }

    // specifier is external if it does not start with . or /
    private isExternalSpecifier(source: string): boolean {
        return !source.startsWith('.') && !source.startsWith('/')
    }

    // attempt to resolve a path alias using tsconfig paths, returning the wrtten path (still needs extension resolution) or null
    private tryResolvePathAlias(source: string): string | null {
        if (!this.tsconfigPaths) return null

        const { baseUrl, paths } = this.tsconfigPaths
        for (const [pattern, mappings] of Object.entries(paths)) {
            const match = matchPathPattern(pattern, source)
            if (match === null) continue

            // try each mapping in order
            for (const mapping of mappings) {
                const resolved = mapping.replace('*', match)
                const withBase = baseUrl === '.' ? resolved : `${baseUrl}/${resolved}`
                return normalizePath(withBase)
            }
        }

        return null
    }

    // given base path w/o extension, find matching file in set of known extracted files
    private tryResolveToFile(basePath: string): string | null {
        const normalized = normalizePath(basePath)

        if (this.symbolTable.knownFiles.has(normalized)) {
            return normalized
        }

        for (const ext of EXTENSION_CANDIDATES) {
            const candidate = normalized + ext
            if (this.symbolTable.knownFiles.has(candidate)) {
                return candidate
            }
        }

        return null
    }

    // build a complete ResolvedImport from the record and resolved file path
    // matches each named/default import to a declaration in the target file
    private buildResult(importRecord: ExtractedImport, resolvedFilePath: string | null): ResolvedImport {
        if (!resolvedFilePath) {
            return {
                importId: importRecord.id,
                resolvedFilePath: null,
                isExternal: false,
                resolvedSymbols: this.buildUnresolvedSymbolRefs(importRecord),
            }
        }

        const resolvedSymbols: ResolvedSymbolRef[] = []

        // resolve named imports
        for (const name of importRecord.namedImports) {
            const symbolId = this.resolveExportedSymbol(resolvedFilePath, name)
            resolvedSymbols.push({
                importedName: name,
                resolvedSymbolId: symbolId,
            })
        }

        // resolve default import
        if (importRecord.defaultImport) {
            const symbolId = this.resolveDefaultExport(resolvedFilePath)
            resolvedSymbols.push({
                importedName: importRecord.defaultImport,
                resolvedSymbolId: symbolId,
            })
        }

        // Namespace imports don't resolve to individual symbols
        if (importRecord.namespaceImport) {
            resolvedSymbols.push({
                importedName: importRecord.namespaceImport,
                resolvedSymbolId: null,
            })
        }

        return {
            importId: importRecord.id,
            resolvedFilePath,
            isExternal: false,
            resolvedSymbols,
        }
    }

    // find a named export in the target file and return underlying declaration id (follows one level of re-exports (barrel files))
    private resolveExportedSymbol(filePath: string, name: string): string | null {
        // first, look for declaration directly exported with this name
        const directMatch = this.symbolTable.getByFileAndName(filePath, name)
        if (directMatch && directMatch.exports.length > 0) {
            return directMatch.declaration.id
        }

        // second, look for a re-export with same name
        const fileSymbols = this.symbolTable.getByFile(filePath)
        // We need to check the file's exports, not declarations.
        // Re-exports don't create declarations in the barrel file.
        // So we need to look at all files' data to find re-export records.
        // The re-export will have: name === importedName, isReExport === true, source === './types'

        // can't access raw exports from symbol table alone, so also search by name across all files
        const byName = this.symbolTable.getByName(name)
        for (const entry of byName) {
            if (entry.exports.length > 0) {
                return entry.declaration.id
            }
        }

        return null
    }

    // find the default export in the target file
    private resolveDefaultExport(filePath: string): string | null {
        const symbols = this.symbolTable.getExportedByFile(filePath)
        const defaultExport = symbols.find((entry) =>
            entry.exports.some((exp) => exp.isDefault)
        )
        return defaultExport?.declaration.id ?? null
    }

    // build unresolved symbol refs for all names in the import
    private buildUnresolvedSymbolRefs(importRecord: ExtractedImport): ResolvedSymbolRef[] {
        const refs: ResolvedSymbolRef[] = []

        for (const name of importRecord.namedImports) {
            refs.push({ importedName: name, resolvedSymbolId: null })
        }
        if (importRecord.defaultImport) {
            refs.push({ importedName: importRecord.defaultImport, resolvedSymbolId: null })
        }
        if (importRecord.namespaceImport) {
            refs.push({ importedName: importRecord.namespaceImport, resolvedSymbolId: null })
        }

        return refs
    }
}

// get parent dir of file path
function parentDir(filePath: string): string {
    const lastSlash = filePath.lastIndexOf('/')
    return lastSlash === -1 ? '' : filePath.slice(0, lastSlash)
}

// normalize a path, resolving '.', '..', collapse double slashes, force forward slashes, strip leading './'
function normalizePath(p: string): string {
    const parts = p.split('/')
    const resolved: string[] = []

    for (const part of parts) {
        if (part === '.' || part === '') continue
        if (part === '..') {
            resolved.pop()
        } else {
            resolved.push(part)
        }
    }

    return resolved.join('/')
}

// match a tsconfig pattern like '$lib/*' against a source string, returning the wildcard portion
function matchPathPattern(pattern: string, source: string): string | null {
    const starIndex = pattern.indexOf('*')

    if (starIndex === -1) {
        // exact match
        return source === pattern ? '' : null
    }

    const prefix = pattern.slice(0, starIndex)
    const suffix = pattern.slice(starIndex + 1)

    if (!source.startsWith(prefix)) return null
    if (suffix && !source.endsWith(suffix)) return null

    return source.slice(prefix.length, suffix ? -suffix.length || undefined : undefined)
}
