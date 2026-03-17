import { validate } from './validate'
import type { User } from '../models/types'

export class AuthService {
    private secret: string = 'key'

    public login(token: string): boolean {
        return validate(token)
    }

    protected refresh(token: string): boolean {
        return validate(token)
    }

    static create(): AuthService {
        return new AuthService()
    }

    async verifyUser(user: User): Promise<boolean> {
        return validate(user.id)
    }
}
