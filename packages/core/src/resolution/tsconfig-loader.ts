import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { argv0 } from 'node:process'

export interface TsconfigPaths {
    baseUrl: string
    paths: Record<string, string[]> // path alias mappings
}

// per repo cache to avoid re-reading tsconfig on every resolve call
const cache = new Map <string, TsconfigPaths | null>()

/**
 * Load path alias config from tsconfig.json at root
 * Return null if no tsconfig exists or contains no relevant fields
 * Results are cached per repoPath
 */
export async function loadTsconfigPaths(repoPath: string): Promise<TsconfigPaths | null> {
    const cacheKey = resolve(repoPath)
    const cached = cache.get(cacheKey)

    if (cached !== undefined) return cached

    const result = await loadFromFile(join(repoPath, 'tsconfig.json'), repoPath)
    cache.set(cacheKey, result)

    return result
}

export function clearTsconfigCache(): void {
    cache.clear()
}

// ---- internal --------------------------
interface RawCompilerOptions {
    baseUrl?: string
    paths?: Record<string, string[]>
}

interface RawTsconfig {
    extends?: string
    compilerOptions?: RawCompilerOptions
}

/**
 * Recursively load a tsconfig file, following all 'extends' chains
 * Stops if extends target is inside node_modules or otherwise unresolvable
 */
async function loadFromFile(
    filePath: string,
    repoPath: string,
    visited: Set<string> = new Set()
): Promise<TsconfigPaths | null> {
    const absolutePath = resolve(filePath)

    if (visited.has(absolutePath)) return null
    visited.add(absolutePath)

    let content: string
    try {
        content = await readFile(absolutePath, 'utf-8')
    } catch {
        return null
    }

    let parsed: RawTsconfig
    try {
        parsed = JSON.parse(stripJsonComments(content)) as RawTsconfig
    } catch {
        return null
    }

    // start with parent config if 'extends' is present
    let baseUrl = '.'
    let paths: Record<string, string[]> = {}

    if (parsed.extends) {
        const parent = await resolveExtends(parsed.extends, dirname(absolutePath), repoPath, visited)
        if (parent) {
            baseUrl = parent.baseUrl
            paths = { ...parent.paths }
        }
    }

    // child overrides parent
    const opts = parsed.compilerOptions
    if (opts?.baseUrl) {
        baseUrl = opts.baseUrl
    }
    if (opts?.paths) {
        paths = { ...paths, ...opts.paths }
    }

    // only return useful results
    if (baseUrl === '.' && Object.keys(paths).length === 0) {
        return null
    }

    return { baseUrl, paths }
}

/**
 * Resolve the extends field to an absolute path and load that path, skipping node_modules targets
 */
async function resolveExtends(
    extendsValue: string,
    fromDir: string,
    repoPath: string,
    visited: Set<string>
): Promise<TsconfigPaths | null> {
    if (!extendsValue.startsWith('.') && !extendsValue.startsWith('/')) {
        return null
    }

    let target = resolve(fromDir, extendsValue)
    if (!target.endsWith('.json')) {
        target += '.json'
    }

    return loadFromFile(target, repoPath, visited)
}

/**
 * strip single line, multi-line, and trailing commas from JSONC string so JSON.parse can parse it
 * should handle all patterns without pulling in a dependency
 */
function stripJsonComments(text: string): string {
    let result = ''
    let i = 0
    let inString = false
    let stringChar = ''

    while (i < text.length) {
        const char = text[i]!
        const next = text[i + 1]

        if (inString) {
            result += char
            if (char === '\\') {
                // skip esc char
                result += text[i + 1] ?? ''
                i += 2
                continue
            }
            if (char === stringChar) {
                inString = false
            }
            i++
            continue
        }

        // string start
        if (char === '"' || char === "'") {
            inString = true
            stringChar = char
            result += char
            i++
            continue
        }

        // single line comment
        if (char === '/' && next === '/') {
            // skip until end of line
            i += 2
            while (i < text.length && text[i] !== '\n') i++
            continue
        }

        // mulit-line comments
        if (char === '/' && next === '*') {
            i += 2
            while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
            continue
        }

        result += char
        i++
    }
    /// remove tailing commas before } or ]
    return result.replace(/,\s*([\]}])/g, '$1')
}
