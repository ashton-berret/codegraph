// Interfaces
export interface User {
    id: string
    name: string
    email: string
}

export interface Admin extends User {
    role: string
    permissions: string[]
}

// Type aliases
export type UserId = string

export type UserRole = 'admin' | 'user' | 'guest'

// Enums
export enum Status {
    Active,
    Inactive,
    Pending
}

export enum Color {
    Red = 'RED',
    Green = 'GREEN',
    Blue = 'BLUE'
}

// Variables
export const MAX_USERS: number = 100

export const DEFAULT_ROLE: UserRole = 'user'

// Arrow functions
export const createUser = (name: string, email: string): User => {
    return { id: '1', name, email }
}

export const isAdmin = (user: User): boolean => {
    return 'role' in user
}

// Async arrow function
export const fetchUser = async (id: string): Promise<User> => {
    return createUser('test', 'test@test.com')
}
