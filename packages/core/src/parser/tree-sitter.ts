import Parser from 'tree-sitter'
import TypeScript from 'tree-sitter-typescript'
import { SupportedLanguages } from '../config/languages.js'

const parserCache = new Map<SupportedLanguages, Parser>()

export interface ParsedSource {
    language: SupportedLanguages
    tree: Parser.Tree
    rootNode: Parser.SyntaxNode
    content: string
}

function getTreeSitterLanguage(language: SupportedLanguages): Parser.Language {
    switch (language) {
        case SupportedLanguages.TypeScript:
            return TypeScript.typescript as unknown as Parser.Language
        case SupportedLanguages.Svelte:
            throw new Error('Svelte parsing is not implemented in Phase 1')
        case SupportedLanguages.Prisma:
            throw new Error('Prisma parsing is not implemented in Phase 1')
        default:
            throw new Error(`Unsupported language: ${String(language)}`)
    }
}

function createParser(language: SupportedLanguages): Parser {
    const parser = new Parser
    parser.setLanguage(getTreeSitterLanguage(language))
    return parser
}

export function getParser(language: SupportedLanguages): Parser {
    const cached = parserCache.get(language)
    if (cached) return cached

    const parser = createParser(language)
    parserCache.set(language, parser)
    return parser
}

export function parseSource(language: SupportedLanguages, content: string): ParsedSource {
    const parser = getParser(language)
    const tree = parser.parse(content)

    return {
        language,
        tree,
        rootNode: tree.rootNode,
        content,
    }
}

export function toOneBasedLine(row: number): number {
    return row + 1
}
