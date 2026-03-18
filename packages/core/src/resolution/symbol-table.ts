import type { ExtractedDeclaration, ExtractedExport } from "../parser/queries/typescript.js"
import type { ExtractedFile } from '../parser/extract.js'

export interface SymbolEntry {
    declaration: ExtractedDeclaration
    filePath: string
    exports: ExtractedExport[]
}

export class SymbolTable {
    private readonly byName = new Map<string, SymbolEntry[]>()
    private readonly byFile = new Map<string, SymbolEntry[]>()
    private readonly byKind = new Map<string, SymbolEntry[]>()
    private readonly byFileAndName = new Map<string, SymbolEntry>()
    private readonly allEntries: SymbolEntry[] = []

    // set of all known files for import resolution
    readonly knownFiles: ReadonlySet<string>

    private constructor(entries: SymbolEntry[], knownFiles: Set<string>) {
        this.knownFiles = knownFiles

        for (const entry of entries) {
            this.allEntries.push(entry)

            // index by name
            let byNameList = this.byName.get(entry.declaration.name)
            if (!byNameList) {
                byNameList = []
                this.byName.set(entry.declaration.name, byNameList)
            }
            byNameList.push(entry)

            let byFileList = this.byFile.get(entry.filePath)
            if (!byFileList) {
                byFileList = []
                this.byFile.set(entry.filePath, byFileList)
            }
            byFileList.push(entry)

            let byKindList = this.byKind.get(entry.declaration.kind)
            if (!byKindList) {
                byKindList = []
                this.byKind.set(entry.declaration.kind, byKindList)
            }
            byKindList.push(entry)

            // index by file+name -> ts resolves by first match wins
            const fileNameKey = `${entry.filePath}::${entry.declaration.name}`
            if (!this.byFileAndName.has(fileNameKey)) {
                this.byFileAndName.set(fileNameKey, entry)
            }
        }
    }

    /**
     * Build a symbol table from  extraction results
     *
     * Associates each declaration with its matching export (matched by name within same file)
     */
    static build(files: ExtractedFile[]): SymbolTable {
        const entries: SymbolEntry[] = []
        const knownFiles = new Set<string>()

        for (const file of files) {
            knownFiles.add(file.filePath)

            for (const decl of file.declarations) {
                const matchingExports = file.exports.filter(
                    (exp) =>
                        !exp.isReExport &&
                    (exp.name === decl.name || exp.exportedName === decl.name)
                )

                entries.push({
                    declaration: decl,
                    filePath: file.filePath,
                    exports: matchingExports,
                })
            }
        }

        return new SymbolTable(entries, knownFiles)
    }

    // all symbols with given name
    getByName(name: string): SymbolEntry[] {
        return this.byName.get(name) ?? []
    }

    // all symbols in given file
    getByFile(filePath: string): SymbolEntry[] {
        return this.byFile.get(filePath) ?? []
    }

    // all symbols in given file that have >= 1 export record
    getExportedByFile(filePath: string): SymbolEntry[] {
        return (this.byFile.get(filePath) ?? []).filter(
            (entry) => entry.exports.length > 0
        )
    }

    // all symbols of given kind across entirety of project
    getByKind(kind: ExtractedDeclaration['kind']): SymbolEntry[] {
        return this.byKind.get(kind) ?? []
    }

    // exact match of a specific symbol name in specific file
    getByFileAndName(filePath: string, name: string): SymbolEntry | undefined {
        return this.byFileAndName.get(`${filePath}::${name}`)
    }

    // iterate over all symbol entries
    entries(): IterableIterator<SymbolEntry> {
        return this.allEntries[Symbol.iterator]()
    }

    // total num of symbols in the table
    get size(): number {
        return this.allEntries.length
    }

}
