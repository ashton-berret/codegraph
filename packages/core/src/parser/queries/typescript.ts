import type Parser from 'tree-sitter'
import { toOneBasedLine, type ParsedSource } from '../tree-sitter.js'

export interface ExtractedDeclaration {
    id: string
    kind: 'function' | 'class' | 'method'
    name: string
    filePath: string
    startLine: number
    endLine: number
    exported: boolean
    async?: boolean
    parentName?: boolean
}

export interface ExtractedImport {
    id: string
    kind: 'import'
    filePath: string
    startLine: number
    endLine: number
    source: string
    defaultImport?: string
    namespaceImport?: string
    namedImports: string[]
}

export interface ExtractedExport {
    id: string
    kind: 'export'
    filePath: string
    startLine: number
    endLine: number
    name: string
    exportedName: string
    source?: string
    isDefault: boolean
    isReExport: boolean
}

export interface ExtractedCall {
    id: string
    kind: 'call'
    filePath: string
    startLine: number
    endLine: number
    callee: string
    containingSymbol?: string
}

export interface TypeScriptExtractionResult {
    declarations: ExtractedDeclaration[]
    imports: ExtractedImport[]
    exports: ExtractedExport[]
    calls: ExtractedCall[]
}

function getNodeText(node: Parser.SyntaxNode, content: string): string {
    return content.slice(node.startIndex, node.endIndex)
}

function getChildByType(
    node: Parser.SyntaxNode,
    type: string
): Parser.SyntaxNode | null {
    for (const child of node.namedChildren) {
        if (child.type === type) return child
    }
    return null
}

function getIdentifierText(
    node: Parser.SyntaxNode | null,
    content: string
): string | null {
    if (!node) return null
    return getNodeText(node, content)
}

function createId(
    filePath: string,
    kind: string,
    name: string,
    startLine: number
): string {
    return `${filePath}#${kind}:${name}:${startLine}`
}

function isNodeExported(node: Parser.SyntaxNode): boolean {
    let current: Parser.SyntaxNode | null = node.parent

    while (current) {
        if (current.type === 'export_statement') return true
        current = current.parent
    }

    return false
}

function extractFunctionDeclaration(
    node: Parser.SyntaxNode,
    filePath: string,
    content: string
): ExtractedDeclaration | null {
    const nameNode = getChildByType(node, 'identifier')
    const name = getIdentifierText(nameNode, content)
    if (!name) return null

    const startLine = toOneBasedLine(node.startPosition.row)
    const endLine = toOneBasedLine(node.endPosition.row)

    return {
        id: createId(filePath, 'function', name, startLine),
        kind: 'function',
        name,
        filePath,
        startLine,
        endLine,
        exported: isNodeExported(node),
        async: getNodeText(node, content).includes('async')
    }
}
