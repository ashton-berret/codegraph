import path from 'node:path'

export enum SupportedLanguages {
    TypeScript = 'typescript',
    Svelte = 'svelte',
    Prisma = 'prisma',
}

const extensionMap: Record<string, SupportedLanguages> = {
    '.ts':      SupportedLanguages.TypeScript,
    '.tsx':     SupportedLanguages.TypeScript,
    '.js':      SupportedLanguages.TypeScript,
    '.jsx':     SupportedLanguages.TypeScript,
    '.svelte':  SupportedLanguages.Svelte,
    '.prisma':  SupportedLanguages.Prisma,
}

export function getLanguageFromFilename(filePath: string): SupportedLanguages | null {
    const extension = path.extname(filePath)
    const lang = extensionMap[extension]

    if (lang !== undefined) return lang

    return null
}
