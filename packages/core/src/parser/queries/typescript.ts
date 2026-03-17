import type Parser from 'tree-sitter'
import { toOneBasedLine, type ParsedSource } from '../tree-sitter.js'

// ── Types ──────────────────────────────────────────────────────────

export interface ParamInfo {
    name: string
    type?: string
    optional?: boolean
}

export interface ExtractedDeclaration {
    id: string
    kind: 'function' | 'class' | 'method' | 'interface' | 'type_alias' | 'enum' | 'variable'
    name: string
    filePath: string
    startLine: number
    endLine: number
    exported: boolean
    async?: boolean
    parentName?: string
    // function/method metadata
    params?: ParamInfo[]
    returnType?: string
    // class metadata
    heritage?: { extends?: string; implements?: string[] }
    // method metadata
    visibility?: 'public' | 'private' | 'protected'
    isStatic?: boolean
    // interface metadata
    interfaceExtends?: string[]
    properties?: { name: string; type?: string }[]
    // type alias metadata
    typeText?: string
    // enum metadata
    members?: string[]
    // variable metadata
    varType?: string
    isConst?: boolean
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
    isTypeOnly?: boolean
}

export interface ExtractedExport {
    id: string
    kind: 'export'
    filePath: string
    startLine: number
    endLine: number
    name: string
    exportedName?: string
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
    argumentsCount?: number
}

export interface TypeScriptExtractionResult {
    declarations: ExtractedDeclaration[]
    imports: ExtractedImport[]
    exports: ExtractedExport[]
    calls: ExtractedCall[]
}

// ── Utility helpers ────────────────────────────────────────────────

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

// ── AST helper functions ───────────────────────────────────────────

/** Check if a node has an unnamed child of a given type (e.g. 'async', 'static', 'type', 'const') */
function hasUnnamedChild(node: Parser.SyntaxNode, type: string): boolean {
    for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i)
        if (child && !child.isNamed && child.type === type) return true
    }
    return false
}

/** Extract accessibility modifier from a method/property node */
function getAccessibility(node: Parser.SyntaxNode): 'public' | 'private' | 'protected' | undefined {
    const accessNode = getChildByType(node, 'accessibility_modifier')
    if (!accessNode) return undefined
    const text = accessNode.text
    if (text === 'public' || text === 'private' || text === 'protected') return text
    return undefined
}

/** Extract parameter information from a formal_parameters node */
function extractParams(node: Parser.SyntaxNode, content: string): ParamInfo[] {
    const paramsNode = getChildByType(node, 'formal_parameters')
    if (!paramsNode) return []

    const params: ParamInfo[] = []
    for (const child of paramsNode.namedChildren) {
        if (child.type === 'required_parameter' || child.type === 'optional_parameter') {
            const patternNode =
                getChildByType(child, 'identifier') ??
                getChildByType(child, 'rest_pattern')
            const nameText = patternNode ? getNodeText(patternNode, content) : null
            if (!nameText) continue

            const typeAnnotation = getChildByType(child, 'type_annotation')
            let typeText: string | undefined
            if (typeAnnotation && typeAnnotation.namedChildren.length > 0) {
                typeText = getNodeText(typeAnnotation.namedChildren[0]!, content)
            }

            params.push({
                name: nameText,
                type: typeText,
                optional: child.type === 'optional_parameter' ? true : undefined,
            })
        }
    }
    return params
}

/** Extract return type annotation from a function/method node */
function extractReturnType(node: Parser.SyntaxNode, content: string): string | undefined {
    // Look for a type_annotation that is a direct child (not inside params)
    for (const child of node.namedChildren) {
        if (child.type === 'type_annotation') {
            if (child.namedChildren.length > 0) {
                return getNodeText(child.namedChildren[0]!, content)
            }
        }
    }
    return undefined
}

// ── Extraction functions ───────────────────────────────────────────

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
        async: hasUnnamedChild(node, 'async') || undefined,
        params: extractParams(node, content),
        returnType: extractReturnType(node, content),
    }
}

function extractClassDeclaration(
    node: Parser.SyntaxNode,
    filePath: string,
    content: string
): ExtractedDeclaration | null {
    const nameNode = getChildByType(node, 'type_identifier') ?? getChildByType(node, 'identifier')
    const name = getIdentifierText(nameNode, content)
    if (!name) return null

    const startLine = toOneBasedLine(node.startPosition.row)
    const endLine = toOneBasedLine(node.endPosition.row)

    // Extract heritage (extends/implements)
    let heritage: ExtractedDeclaration['heritage'] | undefined
    const heritageNode = getChildByType(node, 'class_heritage')
    if (heritageNode) {
        heritage = {}
        const extendsClause = getChildByType(heritageNode, 'extends_clause')
        if (extendsClause) {
            // The first named child after 'extends' keyword is the base class
            const baseNode = extendsClause.namedChildren[0]
            if (baseNode) {
                heritage.extends = getNodeText(baseNode, content)
            }
        }
        const implementsClause = getChildByType(heritageNode, 'implements_clause')
        if (implementsClause) {
            heritage.implements = implementsClause.namedChildren.map(c => getNodeText(c, content))
        }
    }

    return {
        id: createId(filePath, 'class', name, startLine),
        kind: 'class',
        name,
        filePath,
        startLine,
        endLine,
        exported: isNodeExported(node),
        heritage,
    }
}

function extractMethodDeclaration(
    node: Parser.SyntaxNode,
    filePath: string,
    content: string,
    parentName: string
): ExtractedDeclaration | null {
    const nameNode =
        getChildByType(node, 'property_identifier') ??
        getChildByType(node, 'private_property_identifier') ??
        getChildByType(node, 'identifier')

    const name = getIdentifierText(nameNode, content)
    if (!name) return null

    const startLine = toOneBasedLine(node.startPosition.row)
    const endLine = toOneBasedLine(node.endPosition.row)

    return {
        id: createId(filePath, 'method', `${parentName}.${name}`, startLine),
        kind: 'method',
        name,
        filePath,
        startLine,
        endLine,
        exported: false,
        async: hasUnnamedChild(node, 'async') || undefined,
        parentName,
        params: extractParams(node, content),
        returnType: extractReturnType(node, content),
        visibility: getAccessibility(node),
        isStatic: hasUnnamedChild(node, 'static') || undefined,
    }
}

function extractImportDeclaration(
    node: Parser.SyntaxNode,
    filePath: string,
    content: string
): ExtractedImport | null {
    const startLine = toOneBasedLine(node.startPosition.row)
    const endLine = toOneBasedLine(node.endPosition.row)
    const sourceNode = node.namedChildren[node.namedChildren.length - 1] ?? null
    const sourceText = sourceNode ? getNodeText(sourceNode, content) : null

    if (!sourceText) return null

    const source = sourceText.replace(/^['"]|['"]$/g, '')
    const statementText = getNodeText(node, content)
    const namedImports: string[] = []

    const namedMatch = statementText.match(/\{([^}]+)\}/)
    if (namedMatch?.[1]) {
        const items = namedMatch[1].split(',')
        for (const item of items) {
            const cleaned = item.trim()
            if (cleaned.length > 0) namedImports.push(cleaned)
        }
    }

    const namespaceMatch = statementText.match(/\*\s+as\s+([A-Za-z0-9_$]+)/)
    const defaultMatch = statementText.match(/^import\s+(?:type\s+)?([A-Za-z0-9_$]+)\s*(,|from)/m)

    return {
        id: createId(filePath, 'import', source, startLine),
        kind: 'import',
        filePath,
        startLine,
        endLine,
        source,
        defaultImport: defaultMatch?.[1],
        namespaceImport: namespaceMatch?.[1],
        namedImports,
        isTypeOnly: hasUnnamedChild(node, 'type') || undefined,
    }
}

function extractExportStatement(
    node: Parser.SyntaxNode,
    filePath: string,
    content: string
): ExtractedExport[] {
    const startLine = toOneBasedLine(node.startPosition.row)
    const endLine = toOneBasedLine(node.endPosition.row)
    const statementText = getNodeText(node, content)

    const exports: ExtractedExport[] = []

    // Handle `export default`
    if (statementText.startsWith('export default')) {
        exports.push({
            id: createId(filePath, 'export', 'default', startLine),
            kind: 'export',
            filePath,
            startLine,
            endLine,
            name: 'default',
            isDefault: true,
            isReExport: false,
        })
    }

    // Handle `export { ... } from '...'` and `export { ... }`
    const fromMatch = statementText.match(/from\s+['"]([^'"]+)['"]/)
    const source = fromMatch?.[1]

    const namedMatch = statementText.match(/\{([^}]+)\}/)
    if (namedMatch?.[1]) {
        const items = namedMatch[1].split(',')
        for (const item of items) {
            const cleaned = item.trim()
            if (!cleaned) continue

            const [localName, exportedName] = cleaned.split(/\s+as\s+/)

            exports.push({
                id: createId(filePath, 'export', cleaned, startLine),
                kind: 'export',
                filePath,
                startLine,
                endLine,
                name: localName ?? cleaned,
                exportedName,
                source,
                isDefault: false,
                isReExport: Boolean(source),
            })
        }
    }

    // Handle direct `export function/class/enum/interface/type/const`
    // These are export_statement nodes wrapping a declaration child
    for (const child of node.namedChildren) {
        let declName: string | undefined
        if (child.type === 'function_declaration' || child.type === 'generator_function_declaration') {
            const n = getChildByType(child, 'identifier')
            declName = n ? getNodeText(n, content) : undefined
        } else if (child.type === 'class_declaration') {
            const n = getChildByType(child, 'type_identifier') ?? getChildByType(child, 'identifier')
            declName = n ? getNodeText(n, content) : undefined
        } else if (child.type === 'interface_declaration') {
            const n = getChildByType(child, 'type_identifier') ?? getChildByType(child, 'identifier')
            declName = n ? getNodeText(n, content) : undefined
        } else if (child.type === 'type_alias_declaration') {
            const n = getChildByType(child, 'type_identifier') ?? getChildByType(child, 'identifier')
            declName = n ? getNodeText(n, content) : undefined
        } else if (child.type === 'enum_declaration') {
            const n = getChildByType(child, 'identifier')
            declName = n ? getNodeText(n, content) : undefined
        } else if (child.type === 'lexical_declaration' || child.type === 'variable_declaration') {
            // `export const FOO = ...`
            const declarator = getChildByType(child, 'variable_declarator')
            if (declarator) {
                const n = getChildByType(declarator, 'identifier')
                declName = n ? getNodeText(n, content) : undefined
            }
        }

        if (declName && !exports.some(e => e.name === declName)) {
            exports.push({
                id: createId(filePath, 'export', declName, startLine),
                kind: 'export',
                filePath,
                startLine,
                endLine,
                name: declName,
                isDefault: false,
                isReExport: false,
            })
        }
    }

    return exports
}

function extractCallExpression(
    node: Parser.SyntaxNode,
    filePath: string,
    content: string,
    containingSymbol?: string
): ExtractedCall | null {
    const functionNode = node.childForFieldName('function')
    if (!functionNode) return null

    const callee = getNodeText(functionNode, content)
    const startLine = toOneBasedLine(node.startPosition.row)
    const endLine = toOneBasedLine(node.endPosition.row)

    // Count arguments
    const argsNode = getChildByType(node, 'arguments')
    let argumentsCount: number | undefined
    if (argsNode) {
        argumentsCount = argsNode.namedChildren.length
    }

    return {
        id: createId(filePath, 'call', callee, startLine),
        kind: 'call',
        filePath,
        startLine,
        endLine,
        callee,
        containingSymbol,
        argumentsCount,
    }
}

// ── New extraction functions ───────────────────────────────────────

function extractInterfaceDeclaration(
    node: Parser.SyntaxNode,
    filePath: string,
    content: string
): ExtractedDeclaration | null {
    const nameNode = getChildByType(node, 'type_identifier') ?? getChildByType(node, 'identifier')
    const name = getIdentifierText(nameNode, content)
    if (!name) return null

    const startLine = toOneBasedLine(node.startPosition.row)
    const endLine = toOneBasedLine(node.endPosition.row)

    // Extract extends list
    let interfaceExtends: string[] | undefined
    const extendsClause = getChildByType(node, 'extends_type_clause')
    if (extendsClause) {
        interfaceExtends = extendsClause.namedChildren.map(c => getNodeText(c, content))
    }

    // Extract properties from object type / interface body
    let properties: { name: string; type?: string }[] | undefined
    const bodyNode = getChildByType(node, 'interface_body') ?? getChildByType(node, 'object_type')
    if (bodyNode) {
        properties = []
        for (const member of bodyNode.namedChildren) {
            if (member.type === 'property_signature') {
                const propNameNode = getChildByType(member, 'property_identifier')
                const propName = propNameNode ? getNodeText(propNameNode, content) : null
                if (!propName) continue
                const typeAnnotation = getChildByType(member, 'type_annotation')
                let typeText: string | undefined
                if (typeAnnotation && typeAnnotation.namedChildren.length > 0) {
                    typeText = getNodeText(typeAnnotation.namedChildren[0]!, content)
                }
                properties.push({ name: propName, type: typeText })
            } else if (member.type === 'method_signature') {
                const propNameNode = getChildByType(member, 'property_identifier')
                const propName = propNameNode ? getNodeText(propNameNode, content) : null
                if (propName) {
                    properties.push({ name: propName, type: 'method' })
                }
            }
        }
    }

    return {
        id: createId(filePath, 'interface', name, startLine),
        kind: 'interface',
        name,
        filePath,
        startLine,
        endLine,
        exported: isNodeExported(node),
        interfaceExtends,
        properties,
    }
}

function extractTypeAliasDeclaration(
    node: Parser.SyntaxNode,
    filePath: string,
    content: string
): ExtractedDeclaration | null {
    const nameNode = getChildByType(node, 'type_identifier') ?? getChildByType(node, 'identifier')
    const name = getIdentifierText(nameNode, content)
    if (!name) return null

    const startLine = toOneBasedLine(node.startPosition.row)
    const endLine = toOneBasedLine(node.endPosition.row)

    // Extract the RHS of the type alias (everything after the '=')
    let typeText: string | undefined
    // The value is the last named child (after type_identifier and optional type_parameters)
    const children = node.namedChildren
    for (let i = children.length - 1; i >= 0; i--) {
        const child = children[i]!
        if (child.type !== 'type_identifier' && child.type !== 'identifier' && child.type !== 'type_parameters') {
            typeText = getNodeText(child, content)
            break
        }
    }

    return {
        id: createId(filePath, 'type_alias', name, startLine),
        kind: 'type_alias',
        name,
        filePath,
        startLine,
        endLine,
        exported: isNodeExported(node),
        typeText,
    }
}

function extractEnumDeclaration(
    node: Parser.SyntaxNode,
    filePath: string,
    content: string
): ExtractedDeclaration | null {
    const nameNode = getChildByType(node, 'identifier')
    const name = getIdentifierText(nameNode, content)
    if (!name) return null

    const startLine = toOneBasedLine(node.startPosition.row)
    const endLine = toOneBasedLine(node.endPosition.row)

    // Extract members from enum body
    let members: string[] | undefined
    const bodyNode = getChildByType(node, 'enum_body')
    if (bodyNode) {
        members = []
        for (const member of bodyNode.namedChildren) {
            if (member.type === 'enum_assignment') {
                const memberName = getChildByType(member, 'property_identifier')
                if (memberName) members.push(getNodeText(memberName, content))
            } else if (member.type === 'property_identifier') {
                members.push(getNodeText(member, content))
            }
        }
    }

    return {
        id: createId(filePath, 'enum', name, startLine),
        kind: 'enum',
        name,
        filePath,
        startLine,
        endLine,
        exported: isNodeExported(node),
        members,
    }
}

function extractVariableDeclaration(
    node: Parser.SyntaxNode,
    filePath: string,
    content: string
): ExtractedDeclaration[] {
    const results: ExtractedDeclaration[] = []
    const isConst = hasUnnamedChild(node, 'const')

    for (const child of node.namedChildren) {
        if (child.type !== 'variable_declarator') continue

        const nameNode = getChildByType(child, 'identifier')
        const name = nameNode ? getNodeText(nameNode, content) : null
        if (!name) continue

        const startLine = toOneBasedLine(node.startPosition.row)
        const endLine = toOneBasedLine(node.endPosition.row)

        // Check if the value is an arrow function
        const valueNode = getChildByType(child, 'arrow_function')
        if (valueNode) {
            // Treat as a function declaration
            results.push({
                id: createId(filePath, 'function', name, startLine),
                kind: 'function',
                name,
                filePath,
                startLine,
                endLine,
                exported: isNodeExported(node),
                async: hasUnnamedChild(valueNode, 'async') || undefined,
                params: extractParams(valueNode, content),
                returnType: extractReturnType(valueNode, content),
                isConst: true,
            })
        } else {
            // Regular variable
            const typeAnnotation = getChildByType(child, 'type_annotation')
            let varType: string | undefined
            if (typeAnnotation && typeAnnotation.namedChildren.length > 0) {
                varType = getNodeText(typeAnnotation.namedChildren[0]!, content)
            }

            results.push({
                id: createId(filePath, 'variable', name, startLine),
                kind: 'variable',
                name,
                filePath,
                startLine,
                endLine,
                exported: isNodeExported(node),
                isConst,
                varType,
            })
        }
    }

    return results
}

// ── Walk ───────────────────────────────────────────────────────────

function walkNode(
    node: Parser.SyntaxNode,
    filePath: string,
    content: string,
    result: TypeScriptExtractionResult,
    currentContainer?: string
): void {
    switch (node.type) {
        case 'function_declaration': {
            const extracted = extractFunctionDeclaration(node, filePath, content)
            if (extracted) {
                result.declarations.push(extracted)
                // Recurse into body with this function as container
                for (const child of node.namedChildren) {
                    walkNode(child, filePath, content, result, extracted.name)
                }
                return
            }
            break
        }

        case 'class_declaration': {
            const extracted = extractClassDeclaration(node, filePath, content)
            if (extracted) {
                result.declarations.push(extracted)

                // Walk class body — extract methods and recurse into method bodies
                for (const child of node.namedChildren) {
                    if (child.type === 'class_body') {
                        for (const member of child.namedChildren) {
                            if (member.type === 'method_definition') {
                                const method = extractMethodDeclaration(
                                    member,
                                    filePath,
                                    content,
                                    extracted.name
                                )
                                if (method) {
                                    result.declarations.push(method)
                                    // Recurse into method body with containingSymbol = ClassName.methodName
                                    const methodContainer = `${extracted.name}.${method.name}`
                                    for (const methodChild of member.namedChildren) {
                                        walkNode(methodChild, filePath, content, result, methodContainer)
                                    }
                                }
                            }
                        }
                    }
                }
                return // Already handled recursion
            }
            break
        }

        case 'interface_declaration': {
            const extracted = extractInterfaceDeclaration(node, filePath, content)
            if (extracted) result.declarations.push(extracted)
            return // No executable body to recurse
        }

        case 'type_alias_declaration': {
            const extracted = extractTypeAliasDeclaration(node, filePath, content)
            if (extracted) result.declarations.push(extracted)
            return // No executable body to recurse
        }

        case 'enum_declaration': {
            const extracted = extractEnumDeclaration(node, filePath, content)
            if (extracted) result.declarations.push(extracted)
            return // No executable body to recurse
        }

        case 'lexical_declaration':
        case 'variable_declaration': {
            const extractedVars = extractVariableDeclaration(node, filePath, content)
            for (const v of extractedVars) {
                result.declarations.push(v)
                // If arrow function, recurse into its body
                if (v.kind === 'function') {
                    // Find the arrow_function node and recurse into its body
                    for (const child of node.namedChildren) {
                        if (child.type === 'variable_declarator') {
                            const arrowFn = getChildByType(child, 'arrow_function')
                            if (arrowFn) {
                                for (const arrowChild of arrowFn.namedChildren) {
                                    walkNode(arrowChild, filePath, content, result, v.name)
                                }
                            }
                        }
                    }
                }
            }
            if (extractedVars.length > 0) return
            break
        }

        case 'import_statement': {
            const extracted = extractImportDeclaration(node, filePath, content)
            if (extracted) result.imports.push(extracted)
            return
        }

        case 'export_statement': {
            const extracted = extractExportStatement(node, filePath, content)
            result.exports.push(...extracted)
            // Recurse into child declarations (e.g. `export function foo()`)
            for (const child of node.namedChildren) {
                walkNode(child, filePath, content, result, currentContainer)
            }
            return
        }

        case 'call_expression': {
            const extracted = extractCallExpression(node, filePath, content, currentContainer)
            if (extracted) result.calls.push(extracted)
            // Recurse into arguments (they may contain nested calls)
            for (const child of node.namedChildren) {
                walkNode(child, filePath, content, result, currentContainer)
            }
            return
        }
    }

    // Default: recurse into children
    for (const child of node.namedChildren) {
        walkNode(child, filePath, content, result, currentContainer)
    }
}

export function extractTypeScriptSymbols(
    filePath: string,
    parsed: ParsedSource
): TypeScriptExtractionResult {
    const result: TypeScriptExtractionResult = {
        declarations: [],
        imports: [],
        exports: [],
        calls: [],
    }

    walkNode(parsed.rootNode, filePath, parsed.content, result)

    return result
}
