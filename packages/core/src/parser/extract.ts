import { SupportedLanguages } from "../config/languages.js"
import {
    readFileContents,
    scanRepository,
    type ScannedFile
} from '../walker/filesystem.js'
import { parseSource } from "./tree-sitter.js"
import {
    extractTypeScriptSymbols,
    type ExtractedCall,
    type ExtractedDeclaration,
    type ExtractedImport,
    type ExtractedExport,
} from './queries/typescript.js'

export interface ExtractedFile {
    filePath: string
    language: SupportedLanguages
    declarations: ExtractedDeclaration[]
    imports: ExtractedImport[]
    exports: ExtractedExport[]
    calls: ExtractedCall[]
}

export function extractFromFile(file: ScannedFile, content: string): ExtractedFile {
    switch (file.language) {
        case SupportedLanguages.TypeScript: {
            const parsed = parseSource(file.language, content)
            const extracted = extractTypeScriptSymbols(file.path, parsed)

            return {
                filePath: file.path,
                language: file.language,
                declarations: extracted.declarations,
                imports: extracted.imports,
                exports: extracted.exports,
                calls: extracted.calls,
            }
        }
        case SupportedLanguages.Svelte:
            throw new Error('Svelte currently unsupported')
        case SupportedLanguages.Prisma:
            throw new Error('Prisma currently unsupported')
        default:
            throw new Error(`Unsupported language: ${String(file.language)}`)
    }
}

export async function extractFromRepository(repoPath: string): Promise<ExtractedFile[]> {
    const scannedFiles = await scanRepository(repoPath)
    const contents = await readFileContents(repoPath, scannedFiles.map((file) => file.path))

    const extractedFiles: ExtractedFile[] = []

    for (const file of scannedFiles) {
        const content = contents.get(file.path)
        if (!content) continue

        try {
            extractedFiles.push(extractFromFile(file, content))
        } catch (error) {
            console.warn(`Failed to extract symbols from ${file.path}`, error)
        }
    }

    extractedFiles.sort((a, b) => a.filePath.localeCompare(b.filePath))
    return extractedFiles
}
