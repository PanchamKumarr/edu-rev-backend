export interface User {
  id: string;
  email: string;
  password: string;
  name: string;
  role: 'student' | 'instructor' | 'admin';
  createdAt: Date;
}

// In-memory user storage (replace with database in production)
export const users: User[] = [
  {
    id: '1',
    email: 'student@example.com',
    password: '$2a$10$N9qo8uLOickgx2ZMRZoHy.S.FRzN.8f8qf7Q.fqF9K5N5.5F5F5F', // password: 'password123'
    name: 'John Student',
    role: 'student',
    createdAt: new Date('2025-01-01')
  },
  {
    id: '2',
    email: 'instructor@example.com',
    password: '$2a$10$N9qo8uLOickgx2ZMRZoHy.S.FRzN.8f8qf7Q.fqF9K5N5.5F5F5F',
    name: 'Jane Instructor',
    role: 'instructor',
    createdAt: new Date('2025-01-01')
  }
];
