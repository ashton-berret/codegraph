import { AuthService } from './auth/service'
export { validate } from './auth/validate'
export { AuthService } from './auth/service'

export function createAuthService(): AuthService {
    return new AuthService()
}

export const VERSION: string = '1.0.0'
