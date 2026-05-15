# EDU-REV Backend API

A Node.js and Express.js backend for the EDU-REV AI-Powered Learning Management System.

## Features

- User authentication (Signup/Login) with JWT
- Role-based access control (Student, Instructor, Admin)
- Secure password hashing with bcryptjs
- CORS enabled for frontend communication
- Comprehensive error handling
- TypeScript support

## Getting Started

### Prerequisites

- Node.js (v18+)
- npm or yarn

### Installation

1. Clone the repository and navigate to the Backend folder:

```bash
cd Backend
```

2. Install dependencies:

```bash
npm install
```

3. Create a `.env` file based on `.env.example`:

```bash
cp .env.example .env
```

4. Update `.env` with your configuration:

```env
PORT=5000
NODE_ENV=development
CLIENT_URL=http://localhost:3000
JWT_SECRET=your-super-secret-key-for-production
```

### Running the Server

#### Development Mode (with hot reload):

```bash
npm run dev
```

The server will start at `http://localhost:5000`

#### Production Mode:

```bash
npm run build
npm start
```

## API Endpoints

### Authentication Routes (`/api/auth`)

#### Sign Up

```
POST /api/auth/signup
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "securepassword123",
  "name": "John Doe",
  "role": "student" | "instructor" | "admin"
}

Response:
{
  "success": true,
  "message": "User created successfully",
  "token": "jwt-token-here",
  "user": {
    "id": "user-id",
    "email": "user@example.com",
    "name": "John Doe",
    "role": "student",
    "createdAt": "2025-05-11T10:30:00Z"
  }
}
```

#### Log In

```
POST /api/auth/login
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "securepassword123"
}

Response:
{
  "success": true,
  "message": "Login successful",
  "token": "jwt-token-here",
  "user": { ... }
}
```

#### Verify Token

```
GET /api/auth/verify
Authorization: Bearer <jwt-token>

Response:
{
  "success": true,
  "message": "Token is valid",
  "user": {
    "id": "user-id",
    "email": "user@example.com",
    "role": "student"
  }
}
```

## Health Check

```
GET /health

Response:
{
  "status": "OK",
  "message": "EDU-REV Backend is running"
}
```

## Project Structure

```
Backend/
├── src/
│   ├── controllers/        # Business logic
│   │   └── authController.ts
│   ├── routes/            # API routes
│   │   └── auth.ts
│   ├── middleware/        # Express middleware
│   ├── models/            # Data models (for future DB)
│   ├── data/              # In-memory data storage
│   │   └── users.ts
│   └── index.ts           # Main server file
├── package.json
├── tsconfig.json
├── .env.example
└── README.md
```

## Future Enhancements

- [ ] MongoDB integration for persistent storage
- [ ] Email verification for new users
- [ ] Password reset functionality
- [ ] Google OAuth integration
- [ ] Rate limiting
- [ ] API documentation with Swagger
- [ ] Comprehensive logging system
- [ ] Database migrations
- [ ] Unit and integration tests

## Environment Variables

See `.env.example` for all available configuration options.

## Error Handling

The API returns consistent error responses:

```json
{
  "success": false,
  "message": "Error description",
  "stack": "Error stack (only in development)"
}
```

## Development

### Code Style

- TypeScript for type safety
- ES6+ modern JavaScript
- Consistent naming conventions

### Running Linter

```bash
npm run lint
```

## Deployment

For production deployment:

1. Update environment variables
2. Set `NODE_ENV=production`
3. Use a production database (MongoDB, PostgreSQL, etc.)
4. Implement rate limiting
5. Use environment-specific configurations
6. Add comprehensive logging

## License

ISC

## Support

For issues and questions, please open an issue on the GitHub repository.
