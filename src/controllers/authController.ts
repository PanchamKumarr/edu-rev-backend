import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { getDB } from '../db/connection.js';
import { IUser } from '../models/index.js';
import { JWT_SECRET } from '../config.js';

/** Comma-separated allowed Web client IDs (must include the one used in VITE_GOOGLE_CLIENT_ID). */
function getGoogleOAuthClientIds(): string[] {
  const raw = process.env.GOOGLE_CLIENT_ID?.trim() || process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function peekJwtAudiences(idToken: string): string[] {
  try {
    const parts = idToken.split('.');
    if (parts.length !== 3) return [];
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as {
      aud?: string | string[];
    };
    if (payload.aud == null) return [];
    return Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  } catch {
    return [];
  }
}

export const signup = async (req: Request, res: Response) => {
  try {
    const { email, password, name, role } = req.body;

    // Validation
    if (!email || !password || !name || !role) {
      return res.status(400).json({
        success: false,
        message: 'All fields are required'
      });
    }

    const db = getDB();
    const usersCollection = db.collection<IUser>('users');

    // Check if user already exists
    const existingUser = await usersCollection.findOne({ email });
    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: 'User already exists'
      });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create new user
    const newUser: IUser = {
      email,
      password: hashedPassword,
      name,
      role: role as 'student' | 'instructor' | 'admin',
      isActive: true,
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const result = await usersCollection.insertOne(newUser);

    // Generate JWT token
    const token = jwt.sign(
      { id: result.insertedId.toString(), email, role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Return user data without password
    const { password: _, ...userWithoutPassword } = newUser;

    res.status(201).json({
      success: true,
      message: 'User created successfully',
      token,
      user: {
        id: result.insertedId.toString(),
        ...userWithoutPassword
      }
    });
  } catch (error: any) {
    console.error('Signup error:', error);
    res.status(500).json({
      success: false,
      message: 'An error occurred during signup'
    });
  }
};

export const login = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    // Validation
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Email and password are required'
      });
    }

    const db = getDB();
    const usersCollection = db.collection<IUser>('users');

    // Find user
    const user = await usersCollection.findOne({ email });
    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password'
      });
    }

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password'
      });
    }

    // Update last login
    await usersCollection.updateOne(
      { _id: user._id },
      { $set: { lastLogin: new Date() } }
    );

    // Generate JWT token
    const token = jwt.sign(
      { id: user._id?.toString(), email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Return user data without password
    const { password: _, ...userWithoutPassword } = user;

    res.status(200).json({
      success: true,
      message: 'Login successful',
      token,
      user: {
        id: user._id?.toString(),
        ...userWithoutPassword
      }
    });
  } catch (error: any) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      message: 'An error occurred during login'
    });
  }
};

export const googleAuth = async (req: Request, res: Response) => {
  try {
    const clientIds = getGoogleOAuthClientIds();
    if (clientIds.length === 0) {
      console.error('GOOGLE_CLIENT_ID or GOOGLE_OAUTH_CLIENT_ID is missing in Backend/.env');
      return res.status(503).json({
        success: false,
        message:
          'Google sign-in is not configured. Set GOOGLE_CLIENT_ID or GOOGLE_OAUTH_CLIENT_ID in Backend/.env (Web application OAuth client ID), restart the server, and set VITE_GOOGLE_CLIENT_ID or VITE_GOOGLE_OAUTH_CLIENT_ID in the frontend .env.'
      });
    }

    const idToken = (req.body.credential ?? req.body.idToken) as string | undefined;
    if (!idToken || typeof idToken !== 'string') {
      return res.status(400).json({
        success: false,
        message:
          'Google credential is required (use { credential } from @react-oauth/google, or { idToken } for legacy clients).'
      });
    }

    const oauth = new OAuth2Client(clientIds[0]);
    let payload: { email: string; name?: string; picture?: string };
    try {
      const ticket = await oauth.verifyIdToken({
        idToken,
        audience: clientIds.length === 1 ? clientIds[0] : clientIds
      });
      const p = ticket.getPayload();
      if (!p?.email) {
        return res.status(401).json({ success: false, message: 'Invalid Google token: missing email' });
      }
      if (p.email_verified === false) {
        return res.status(401).json({ success: false, message: 'Google account email is not verified' });
      }
      payload = {
        email: p.email,
        name: p.name ?? undefined,
        picture: p.picture ?? undefined
      };
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.error('Google verifyIdToken:', errMsg);
      const tokenAuds = peekJwtAudiences(idToken);
      const audienceMismatch =
        tokenAuds.length > 0 && clientIds.length > 0 && !tokenAuds.some((a) => clientIds.includes(a));
      let message: string;
      if (audienceMismatch) {
        message =
          'Google client ID mismatch: Backend GOOGLE_CLIENT_ID must be the same Web OAuth client ID as VITE_GOOGLE_CLIENT_ID in the frontend (no extra spaces). Restart both dev servers after changing .env.';
      } else if (process.env.NODE_ENV !== 'production') {
        message = `Invalid Google credential (${errMsg})`;
      } else {
        message = 'Invalid Google credential';
      }
      return res.status(401).json({ success: false, message });
    }

    const email = payload.email.toLowerCase();
    const name = (payload.name && payload.name.trim()) || email.split('@')[0] || 'User';

    const bodyRole = req.body.role as string | undefined;
    const newRole: IUser['role'] =
      bodyRole === 'instructor' || bodyRole === 'admin' || bodyRole === 'student' ? bodyRole : 'student';

    const db = getDB();
    const usersCollection = db.collection<IUser>('users');

    let user = await usersCollection.findOne({ email });

    if (!user) {
      const hashedPassword = await bcrypt.hash(randomBytes(32).toString('hex'), 10);
      const newUser: IUser = {
        email,
        password: hashedPassword,
        name,
        role: newRole,
        isActive: true,
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        lastLogin: new Date(),
        profileImage: payload.picture ?? undefined
      };

      const result = await usersCollection.insertOne(newUser);
      user = { ...newUser, _id: result.insertedId };
    } else {
      await usersCollection.updateOne(
        { _id: user._id },
        {
          $set: {
            lastLogin: new Date(),
            updatedAt: new Date(),
            emailVerified: true,
            ...(payload.picture ? { profileImage: payload.picture } : {})
          }
        }
      );
      const refreshed = await usersCollection.findOne({ _id: user._id });
      if (refreshed) user = refreshed;
    }

    const token = jwt.sign(
      { id: user._id?.toString(), email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    const { password: _, ...userWithoutPassword } = user;

    res.status(200).json({
      success: true,
      message: 'Login successful',
      token,
      user: {
        id: user._id?.toString(),
        ...userWithoutPassword
      }
    });
  } catch (error: unknown) {
    console.error('Google auth error:', error);
    res.status(500).json({
      success: false,
      message: 'An error occurred during Google sign-in'
    });
  }
};

export const verifyToken = (req: Request, res: Response) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'No token provided'
      });
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    res.status(200).json({
      success: true,
      message: 'Token is valid',
      user: decoded
    });
  } catch (error: any) {
    res.status(401).json({
      success: false,
      message: 'Invalid or expired token'
    });
  }
};
